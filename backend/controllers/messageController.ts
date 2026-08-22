import type { Request, Response } from 'express';

// eslint-disable-next-line global-require
const Pod = require('../models/Pod');
// eslint-disable-next-line global-require
const MongoMessage = require('../models/Message');
// eslint-disable-next-line global-require
const PGMessage = require('../models/pg/Message');
// eslint-disable-next-line global-require
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line global-require
const { deliverMessageToAgents } = require('../services/messageAgentDeliveryService');
const DMService = require('../services/dmService');
// eslint-disable-next-line global-require
const { syncPodFromMongo } = require('../services/pgPodSyncService');

interface AuthRequest extends Request {
  userId?: string;
  user?: { id: string; username?: string };
}

interface NormalizedMessage {
  id: string;
  pod_id: string;
  user_id: string;
  // PG normalizes its joined author onto userId; the Mongo fallback keeps the
  // historical user shape below. Agent wake author resolution must accept both
  // stores so a JWT-posted human message never becomes "raised by unknown".
  userId?: { username?: string } | string;
  username?: string;
  content: string;
  message_type: string;
  // ADR-020 D3: structured card payload — must survive the Mongo fallback's
  // whitelist or cards silently vanish on that path.
  payload?: unknown;
  created_at: unknown;
  updated_at: unknown;
  user?: { username: string; profile_picture?: string };
}

const pgAvailable = (): boolean => {
  try {
    // eslint-disable-next-line global-require
    const { pool } = require('../config/db-pg');
    return !!pool;
  } catch {
    return false;
  }
};

const normalizeMongo = (m: Record<string, unknown>): NormalizedMessage => {
  // When .populate('userId') ran, m.userId is a populated User document. Calling
  // .toString() on a Mongoose document returns util.inspect output
  // ("{\n  _id: new ObjectId(\"...\"),\n  username: '...'\n}"), which then leaks
  // into the user_id field of the response. Pull just the _id when populated.
  const rawUserId = m.userId as { _id?: { toString(): string }; toString(): string; username?: string; profilePicture?: string } | string | null | undefined;
  const idSource = rawUserId && typeof rawUserId === 'object' && rawUserId._id ? rawUserId._id : rawUserId;
  const populatedUsername = (typeof rawUserId === 'object' && rawUserId) ? rawUserId.username : undefined;
  const populatedProfilePicture = (typeof rawUserId === 'object' && rawUserId) ? rawUserId.profilePicture : undefined;
  return {
    id: (m._id as { toString(): string }).toString(),
    pod_id: (m.podId as { toString(): string }).toString(),
    user_id: idSource ? (idSource as { toString(): string }).toString() : '',
    content: m.content as string,
    message_type: (m.messageType as string) || 'text',
    ...(m.payload != null ? { payload: m.payload } : {}),
    created_at: m.createdAt,
    updated_at: m.updatedAt,
    user: populatedUsername
      ? {
          username: populatedUsername,
          profile_picture: populatedProfilePicture,
        }
      : undefined,
  };
};

exports.getMessages = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { podId } = req.params;
    const { before } = req.query as { before?: string };
    // Clamp the page size [1, 200]. Unbounded `limit` let a caller ask for
    // millions of rows → OOM (both the PG and Mongo read paths below). Mirrors
    // the postController.getPosts clamp pattern.
    const limit = Math.min(200, Math.max(1, parseInt(String((req.query as { limit?: string }).limit ?? 50), 10) || 50));

    if (!podId) {
      res.status(400).json({ msg: 'Pod ID is required' });
      return;
    }

    const pod = await Pod.findById(podId) as { members: Array<{ toString(): string }>; type?: string } | null;
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }

    const userId = req.userId || req.user?.id;
    if (!userId) {
      res.status(401).json({ msg: 'User authentication failed' });
      return;
    }

    // Read-access via §3.7: members always allowed; agent-dm pods are
    // also viewable by anyone sharing a pod with either bot member, so
    // humans can read the agent ↔ agent conversations happening between
    // their team's agents without being formally added to the bot DM.
    const canView = await DMService.canViewPod(userId, pod);
    if (!canView) {
      res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
      return;
    }

    try {
      const messages = await PGMessage.findByPodId(podId, limit, before);
      // Sprint B5: attach reactions per message in one batched query
      // (MessageReaction.listForMessages aggregates by GROUP BY).
      // Falls through to `messages` unchanged on any reaction lookup error.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
        const MessageReaction = require('../models/pg/MessageReaction').default;
        const ids = (messages as Array<{ id?: string; _id?: string }>)
          .map((m) => m.id || m._id)
          .filter(Boolean);
        if (ids.length > 0) {
          const reactionsMap = await MessageReaction.listForMessages(ids, String(userId));
          // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
          const { decorateReactionMap } = require('../services/reactionAttributionService');
          const decorated = await decorateReactionMap(reactionsMap);
          for (const m of messages as Array<{ id?: string; _id?: string; reactions?: unknown }>) {
            const key = String(m.id || m._id || '');
            m.reactions = decorated.get(key) || [];
          }
        }
      } catch (rxnErr) {
        // Non-fatal: reactions are a render enhancement.
        // eslint-disable-next-line no-console
        console.warn('[messages] reaction enrichment skipped:', (rxnErr as Error).message);
      }
      res.json(messages);
      return;
    } catch (pgErr) {
      const e = pgErr as { message?: string };
      console.warn('PG unavailable for getMessages, falling back to MongoDB:', e.message);
    }

    const query: Record<string, unknown> = { podId };
    if (before) query.createdAt = { $lt: new Date(before) };
    const messages = await MongoMessage.find(query)
      .populate('userId', 'username profilePicture')
      .sort({ createdAt: -1 })
      .limit(limit);
    res.json(messages.map(normalizeMongo));
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in getMessages:', e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ error: 'Pod not found' });
      return;
    }
    res.status(500).json({ error: 'Server Error' });
  }
};

exports.createMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { podId } = req.params;
    const { content, text, attachments, replyToMessageId, threadRootId } = req.body as {
      content?: string;
      text?: string;
      attachments?: unknown[];
      replyToMessageId?: string;
      // @ux-lead 56879: an ordinary in-thread post carries NO reply edge and
      // names its root directly, so joining a thread never addresses the
      // root's author.
      threadRootId?: string | number;
    };

    if (!podId) {
      res.status(400).json({ msg: 'Pod ID is required' });
      return;
    }

    const messageContent = content || text;
    if (!messageContent && (!attachments || attachments.length === 0)) {
      res.status(400).json({ msg: 'Message text or attachments are required' });
      return;
    }

    const pod = await Pod.findById(podId) as {
      members: Array<{ toString(): string }>;
      type?: string;
      createdBy?: { toString(): string };
    } | null;
    if (!pod) {
      res.status(404).json({ msg: 'Pod not found' });
      return;
    }

    const userId = req.userId || req.user?.id;
    if (!userId) {
      res.status(401).json({ msg: 'User authentication failed' });
      return;
    }

    const userIdStr = userId.toString();
    const isUserMember = pod.members.some((memberId) => memberId.toString() === userIdStr);
    if (!isUserMember) {
      // agent-dm pods are intentionally write-restricted to formal
      // members. Read access fans out per §3.7 (canViewPod), but
      // posting does NOT — the agent ↔ agent space stays clean and
      // humans intervene via the team pod they share with the agents.
      // This pairs with the bot-loop guard in agentMentionService:
      // once N consecutive bot turns trip, the conversation stops
      // until a human pulls one of the agents back via @mention in
      // a co-pod, where the autoJoin path resumes flow.
      res.status(401).json({ msg: 'Not authorized to post in this pod' });
      return;
    }

    let message: NormalizedMessage;

    // Best-effort backfill: pods created via the Mongo-only POST /api/pods
    // path (podController) have no row in the PG `pods` table, so the
    // subsequent PGMessage.create fails the messages.pod_id foreign key
    // and the message lands in the Mongo fallback indefinitely.
    // pgMessageController already does this; mirror it here so the dual-DB
    // path stays consistent with the PG-primary path. Swallow errors —
    // if PG is unreachable, PGMessage.create below will throw and the
    // existing Mongo fallback handles it.
    try {
      const pgPodExists = await PGPod.findById(podId);
      if (!pgPodExists) {
        await syncPodFromMongo(podId, userId);
      }
    } catch (syncErr) {
      const e = syncErr as { message?: string };
      console.warn('[messageController] PG pod backfill skipped:', e.message);
    }

    // Reconcile the two shapes BEFORE the insert, so a caller whose reply edge
    // and named root disagree is told, rather than having one silently win.
    //
    // ONLY when the caller names a root. With no explicit threadRootId the
    // resolver would just re-derive COALESCE(parent.thread_root_id, parent.id)
    // — which the INSERT already does — so calling it would add a query per
    // message and change nothing. There is nothing to reconcile until there
    // are two claims to reconcile.
    let resolvedThreadRootId: number | null = null;
    try {
      if (threadRootId != null && threadRootId !== '') {
        // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
        const { resolveThreadRoot } = require('../services/threadRootResolver');
        resolvedThreadRootId = await resolveThreadRoot({ podId, replyToMessageId, threadRootId });
      }
    } catch (err) {
      const e = err as { name?: string; code?: string; message?: string };
      if (e.name === 'ThreadRootError') {
        // 400, not 500: every one of these is fixable by sending different
        // input, and the code says which.
        res.status(400).json({ error: e.message, code: e.code });
        return;
      }
      // A resolver failure that is NOT a caller error must not silently drop
      // the message into no thread — that is the data loss this column exists
      // to prevent. Surface it.
      throw err;
    }

    try {
      const created = await PGMessage.create(
        podId,
        userId,
        messageContent || '',
        'text',
        replyToMessageId || null,
        null,
        resolvedThreadRootId,
      );
      // create() returns the raw INSERT row with no users JOIN, so the
      // response would lack username/profile_picture and the v2 chat would
      // render the author as "Unknown" until a refresh pulled the joined
      // row. findById re-fetches with the JOIN so the optimistic render
      // already has the right author identity. A JOIN failure is not a write
      // failure: falling into the Mongo fallback after INSERT would duplicate
      // the message (or falsely reject an already-persisted reply).
      let populated = null;
      try {
        populated = created?.id ? await PGMessage.findById(created.id) : null;
      } catch (readErr) {
        console.warn('[messageController] PG post-write read failed:', (readErr as Error).message);
      }
      message = (populated || created) as NormalizedMessage;
    } catch (pgErr) {
      const e = pgErr as { message?: string };
      console.warn('PG unavailable for createMessage, falling back to MongoDB:', e.message);
      // Mongo messages have no reply_to_message_id column and are never
      // reconciled into PG. A reply written here would look successful while
      // permanently losing its parent edge, so only non-replies may use this
      // availability fallback.
      //
      // "NEVER RECONCILED" IS A CURRENT FACT, NOT AN INVARIANT — and this
      // guard is correct only while it holds (@sprint-review, pod 56881).
      // Reconciling Mongo into PG was the other option considered on TASK-040;
      // #1116 chose this one instead, so nothing reconciles today and the 503
      // is the resolution rather than a stopgap.
      //
      // If reconciliation is ever built, this stops being a data-loss guard
      // and becomes a rejection with no remaining reason: a user told
      // "Replies are temporarily unavailable" about a path that would now
      // preserve their reply. Whoever builds it must remove or relax this in
      // the same change. The dependency runs both ways and appears in neither
      // diff, which is why it is written at both ends — TASK-040 carries the
      // pointer back here.
      if (replyToMessageId) {
        res.status(503).json({
          error: 'Replies are temporarily unavailable. Please try again shortly.',
          code: 'REPLY_REQUIRES_POSTGRES',
        });
        return;
      }
      const mongoMsg = await MongoMessage.create({
        podId,
        userId,
        content: messageContent || '',
        messageType: 'text',
      });
      const populated = await MongoMessage.findById(mongoMsg._id)
        .populate('userId', 'username profilePicture');
      message = normalizeMongo(populated || mongoMsg);
    }

    const responseMessage = await deliverMessageToAgents({
      podId,
      podType: pod.type,
      message,
      userId,
      requestUser: req.user,
      // This route owns reply edges. Passing null for a root post preserves
      // the existing enqueueMentions contract; the legacy PG route omits the
      // field altogether because it cannot receive one.
      replyToMessageId: replyToMessageId || null,
    });

    // Live-broadcast the new message to every connected client in this pod's
    // Socket.io room. Without this emit, V2 chat surfaces only see the new
    // message on a manual refresh — the agent-runtime path (`AgentMessageService.
    // postMessage`) emits `newMessage` already, but the human-user path
    // never did, which made human messages "disappear" until refresh from
    // the perspective of every other connected user.
    //
    // Same payload shape that `agentMessageService` uses (`pod_id` + `podId`
    // both populated for V2's cross-pod-leak guard in useV2PodDetail).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
      const socketConfig = require('../config/socket');
      const io = socketConfig.getIO();
      if (io) {
        const m = message as NormalizedMessage & {
          _id?: string;
          id?: string;
          userId?: unknown;
          username?: string;
          profile_picture?: string;
          createdAt?: string;
          messageType?: string;
          replyTo?: { id: string; content: string; username: string; userId: string } | null;
        };
        const formattedMessage = {
          _id: m._id || m.id,
          id: m._id || m.id,
          pod_id: String(podId),
          podId: String(podId),
          content: m.content,
          messageType: m.messageType || 'text',
          userId: m.userId,
          username: m.username,
          profile_picture: m.profile_picture,
          createdAt: m.createdAt,
          // Reply quote must ride the broadcast too — without it every live
          // viewer renders the reply without its quoted context until a
          // reload re-fetches the joined row (#646).
          replyTo: m.replyTo ?? null,
        };
        io.to(`pod_${podId}`).emit('newMessage', formattedMessage);
      }
    } catch (socketErr) {
      console.warn('[messageController] socket emit failed:', (socketErr as Error).message);
    }

    res.json(responseMessage);
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in createMessage:', e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ error: 'Pod not found' });
      return;
    }
    res.status(500).json({ error: 'Server Error' });
  }
};

exports.deleteMessage = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    let message: NormalizedMessage | null = null;
    try {
      message = await PGMessage.findById(req.params.id) as NormalizedMessage | null;
    } catch {
      const mongoMsg = await MongoMessage.findById(req.params.id) as Record<string, unknown> | null;
      if (mongoMsg) message = normalizeMongo(mongoMsg);
    }

    if (!message) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }

    const userId = req.userId || req.user?.id;
    if (!userId) {
      res.status(401).json({ msg: 'User authentication failed' });
      return;
    }

    if (message.user_id.toString() !== userId.toString()) {
      const pod = await Pod.findById(message.pod_id) as { createdBy?: { toString(): string } } | null;
      if (!pod || pod.createdBy?.toString() !== userId.toString()) {
        res.status(401).json({ msg: 'Not authorized to delete this message' });
        return;
      }
    }

    try {
      await PGMessage.delete(req.params.id);
    } catch {
      await MongoMessage.findByIdAndDelete(req.params.id);
    }

    res.json({ msg: 'Message deleted' });
  } catch (err) {
    const e = err as { message?: string; kind?: string };
    console.error('Error in deleteMessage:', e.message);
    if (e.kind === 'ObjectId') {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    res.status(500).json({ error: 'Server Error' });
  }
};
