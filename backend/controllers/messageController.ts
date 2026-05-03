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
const AgentMentionService = require('../services/agentMentionService');
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
  content: string;
  message_type: string;
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
    const { limit = 50, before } = req.query as { limit?: number; before?: string };

    if (!podId) {
      res.status(400).json({ msg: 'Pod ID is required' });
      return;
    }

    const pod = await Pod.findById(podId) as { members: Array<{ toString(): string }> } | null;
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
      res.status(401).json({ msg: 'Not authorized to view messages in this pod' });
      return;
    }

    try {
      const messages = await PGMessage.findByPodId(podId, parseInt(String(limit), 10), before);
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
      .limit(parseInt(String(limit), 10));
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
    const { content, text, attachments, replyToMessageId } = req.body as {
      content?: string;
      text?: string;
      attachments?: unknown[];
      replyToMessageId?: string;
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

    try {
      const created = await PGMessage.create(
        podId,
        userId,
        messageContent || '',
        'text',
        replyToMessageId || null,
      );
      // create() returns the raw INSERT row with no users JOIN, so the
      // response would lack username/profile_picture and the v2 chat would
      // render the author as "Unknown" until a refresh pulled the joined
      // row. findById re-fetches with the JOIN so the optimistic render
      // already has the right author identity.
      const populated = created?.id ? await PGMessage.findById(created.id) : null;
      message = (populated || created) as NormalizedMessage;
    } catch (pgErr) {
      const e = pgErr as { message?: string };
      console.warn('PG unavailable for createMessage, falling back to MongoDB:', e.message);
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

    const username = req.user?.username;
    // agent-admin (legacy 1:1 admin DM), agent-room (1:1 user↔agent DM), and
    // agent-dm (any 2-member DM, including agent↔agent) all auto-route every
    // human message to the agent — no @mention needed. Other pod types only
    // fire on explicit @mentions. Adding a new private 1:1 pod type without
    // updating this allow-list silently drops every message; see
    // docs/agents/AGENT_RUNTIME.md "Routing Invariants" for the canonical
    // version of this rule.
    if (pod.type === 'agent-admin' || pod.type === 'agent-room' || pod.type === 'agent-dm') {
      await AgentMentionService.enqueueDmEvent({ podId, message, userId, username });
    } else {
      await AgentMentionService.enqueueMentions({ podId, message, userId, username });
    }

    res.json(message);
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
