// Sprint B5: reaction add / remove controller. Per-message toggle —
// adding a reaction the user already left is a no-op (idempotent via
// the unique constraint); removing one they don't have is also a no-op.
// Both endpoints emit a `messageReaction` Socket.io event into
// `pod_${podId}` so other clients animate the chip without polling. A newly
// added reaction also sends the reacted-to agent a best-effort acknowledgement;
// removals and idempotent retries stay side-effect free.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MessageReaction = require('../models/pg/MessageReaction').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decorateReactionSummaries } = require('../services/reactionAttributionService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentEventService = require('../services/agentEventService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');

interface AuthedReq {
  params: { messageId?: string; emoji?: string };
  body: { emoji?: string };
  user?: { _id?: unknown };
  userId?: unknown;
  // Set by agentRuntimeAuth — present when caller used a cm_agent_*
  // token instead of a human JWT. Both paths populate _id on the
  // resolved bot User row (per agent-runtime memory note 2026-05-08).
  agentUser?: { _id?: unknown };
}
interface AuthedRes {
  status: (n: number) => AuthedRes;
  json: (d: unknown) => void;
}

// Accept a single emoji OR a full emoji sequence. `\p{Emoji}` alone rejects
// the combining marks real emoji carry: U+FE0F (variation selector — makes
// ❤️/☺️/⭐️ render as emoji), U+200D (ZWJ, for 👨‍👩‍👧 family/profession
// sequences), and skin-tone modifiers (\p{Emoji_Modifier}). Before this, ❤️ —
// which is in the client's reaction palette — 400'd ("emoji must be 1–8…") and
// the frontend swallowed it, so users couldn't add it (2026-07-24). Widened to
// 16 code points so ZWJ sequences fit.
const SAFE_EMOJI_RE = /^[\p{Emoji}\u{200D}\u{FE0F}\p{Emoji_Modifier}]{1,16}$/u;

function getUserId(req: AuthedReq): string {
  return String(req.user?._id || req.userId || req.agentUser?._id || '');
}

// Returns true when the caller is a member of the pod. For human
// callers we check pg pod_members (same as posting). For agent
// callers (req.agentUser populated by agentRuntimeAuth) we check
// AgentInstallation since agents may not have a pod_members row —
// per the agent-runtime memory rule "AgentInstallation required for
// posting", we mirror that gate for reacting.
async function callerHasPodAccess(podId: string, userId: string, req: AuthedReq): Promise<boolean> {
  if (req.agentUser?._id) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const { AgentInstallation } = require('../models/AgentRegistry');
    const installation = await AgentInstallation.findOne({
      podId,
      installedBy: req.agentUser._id,
      status: 'active',
    }).lean();
    if (installation) return true;
    // Fallback: the agent's bot User may be a member via Pod.members
    // (e.g. installed via /agents/runtime/room handoff). Check that path too.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const Pod = require('../models/Pod');
    const pod = await Pod.findById(podId).select('members').lean();
    if (pod?.members?.some((m: any) => String(m?.userId?.toString?.() || m) === userId)) {
      return true;
    }
    return false;
  }
  // Human path. PG pod_members is the fast check, but it is a *lazily-synced
  // mirror* of Mongo pod.members — community auto-join (ensureUserInCommunityPod)
  // and other join paths write Mongo only. So fall back to Mongo membership, the
  // source of truth, or we 403 real members whose row never reached PG. 2026-07-24:
  // HQ had 66 Mongo members but 1 in PG pod_members, so 65/66 could not react and
  // the failure was silent — reaction counts appeared stuck at 1. Mirrors the
  // agent path above, which already checks Mongo.
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2 LIMIT 1',
    [podId, userId],
  );
  if ((result.rowCount || 0) > 0) return true;
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Pod = require('../models/Pod');
  const pod = await Pod.findById(podId).select('members').lean();
  return Boolean(pod?.members?.some((mem: any) => String(mem?.userId?.toString?.() || mem) === userId));
}

async function emitReactionChange(messageId: string | number, podId: string, reactions: unknown): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const socketConfig = require('../config/socket');
    const io = socketConfig.getIO?.();
    if (io && podId) {
      io.to(`pod_${podId}`).emit('messageReaction', {
        messageId: String(messageId),
        podId,
        reactions,
      });
    }
  } catch (err) {
    // Socket failure is never fatal — the DB write succeeded; clients
    // will see the new state on next refresh.
    // eslint-disable-next-line no-console
    console.warn('[reactionController] socket emit failed:', (err as Error).message);
  }
}

interface MessageContext {
  podId: string;
  authorUserId: string;
}

async function loadMessageContext(messageId: string | number): Promise<MessageContext | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT pod_id, user_id FROM messages WHERE id = $1 LIMIT 1',
    [Number(messageId)],
  );
  const row = result.rows[0];
  if (!row?.pod_id || !row?.user_id) return null;
  return { podId: String(row.pod_id), authorUserId: String(row.user_id) };
}

// A reaction is an acknowledgement of an already-posted agent message, not a
// new message for the room. Reuse chat.mention instead of inventing a new
// event type: deployed wrapper versions only turn their prompt-event allowlist
// into a model turn. Deliberately omit payload.messageId so ADR-018's
// claim-before-act gate does not claim the original message a second time.
// The original ID remains available as reactedMessageId for consumers that
// need to correlate this receipt.
const reactionAcknowledgementContent = (emoji: string): string => (
  `[Reaction acknowledgement] Someone reacted ${emoji} to your message. `
  + 'This is an acknowledgement, not a new request — do not post a reply.'
);

const deriveReactionRecipientInstanceId = (
  agentName: string,
  username: unknown,
  metadataInstanceId: unknown,
): string => {
  const normalizedUsername = String(username || '').trim().toLowerCase();
  const normalizedMetadataInstanceId = String(metadataInstanceId || '').trim().toLowerCase();
  const prefix = `${agentName}-`;
  const usernameInstanceId = normalizedUsername === agentName
    ? 'default'
    : (normalizedUsername.startsWith(prefix) ? normalizedUsername.slice(prefix.length).trim() : '');

  // Runtime consumers use a username suffix when metadata is absent or still
  // says "default". Match that address exactly: an acknowledgement under a
  // different instance key is an event no connected agent can poll.
  if (usernameInstanceId && (!normalizedMetadataInstanceId || normalizedMetadataInstanceId === 'default')) {
    return usernameInstanceId;
  }
  return normalizedMetadataInstanceId || usernameInstanceId || 'default';
};

async function enqueueReactionAcknowledgement({
  podId,
  authorUserId,
  reactorUserId,
  messageId,
  emoji,
  reactorIsAgent,
}: {
  podId: string;
  authorUserId: string;
  reactorUserId: string;
  messageId: string | number;
  emoji: string;
  reactorIsAgent: boolean;
}): Promise<void> {
  // An agent reacting to its own message already has the information and must
  // not wake itself. This also keeps autonomous reaction workflows from
  // becoming self-trigger loops.
  if (authorUserId === reactorUserId) return;

  try {
    const author = await User.findById(authorUserId)
      .select('isBot username botMetadata.agentName botMetadata.instanceId')
      .lean() as {
        isBot?: boolean;
        username?: string;
        botMetadata?: { agentName?: string; instanceId?: string };
      } | null;
    if (!author?.isBot) return;

    // AgentEvent is addressed by (agentName, instanceId). A legacy bot row
    // without agentName has no transport-independent routing identity:
    // HTTP auth and the agent WebSocket derive different fallbacks. Do not
    // enqueue a receipt either delivery path might strand; leave a visible
    // operational signal instead of silently treating it as delivered.
    const agentName = String(author.botMetadata?.agentName || '').trim().toLowerCase();
    if (!agentName) {
      // eslint-disable-next-line no-console
      console.warn('[reactionController] agent acknowledgement skipped: missing botMetadata.agentName', authorUserId);
      return;
    }

    await AgentEventService.enqueue({
      agentName,
      instanceId: deriveReactionRecipientInstanceId(
        agentName,
        author.username,
        author.botMetadata?.instanceId,
      ),
      podId,
      // `message.posted`, NOT `chat.mention`. Since #973, chat.mention carries
      // `cap + addressedGrace` — so typing a receipt that way let a single 👍
      // buy a capped seat two extra turns, and a seat nobody could reach by
      // name could be un-capped by anyone reacting to an old message of its
      // own. Ruled by fable-lead, who overrode its own earlier read.
      type: 'message.posted',
      payload: {
        content: reactionAcknowledgementContent(emoji),
        reactedMessageId: String(messageId),
        reactionAcknowledgement: true,
        emoji,
        source: 'message-reaction',
        // Retyping alone closes the GRACE hole and leaves an ADMISSION hole:
        // this event carries no `payload.messageId`, so `classifyTrigger`
        // returns 'unknown' — which is fail-open for admission, and a capped
        // seat would still burn a full turn on every reaction, uncounted.
        //
        // `classifyTrigger` dispatches on `dmKind` FIRST (enforcement.js:48-49),
        // before the messageId lookup, so stamping the reactor's authorship
        // here decides it:
        //   human 👍  -> 'human' -> wakes the seat AND resets the streak, which
        //                is what the streak measures: human attention in the room
        //   agent 👍  -> 'agent' -> counts toward the cap, so reaction loops
        //                terminate instead of ratcheting
        //
        // The condition lives in the gate rather than beside it: `admit()`
        // reads nothing new, and #1010's own regression test already uses
        // dmKind on a plain message.posted as its trigger oracle.
        //
        // KNOWN DEBT, deliberately taken to ship on the deployed 0.1.11 fleet
        // without a wrapper change: `dmKind` is DM-named, and the moltbot
        // system prompt (agentProvisionerServiceK8s.ts:416) documents it to
        // agents as "a human just sent you a message". A reaction receipt is
        // not a DM. Routing is unaffected — the DM conversational frame is
        // built in `enqueueDmEvent`, a different path that this never enters —
        // so the risk is an agent MISREADING the field, not mis-delivery. The
        // clean fix is a neutral `triggerAuthor` field taught to
        // classifyTrigger; it needs a CLI release and a fleet restart, so it
        // is filed as follow-up rather than blocking reactions.
        dmKind: reactorIsAgent ? 'agent-agent' : 'user-agent',
      },
    });
  } catch (err) {
    // The reaction is durable before this best-effort receipt. Agent delivery
    // failure must never turn a user acknowledgement into a failed reaction.
    // eslint-disable-next-line no-console
    console.warn('[reactionController] agent acknowledgement enqueue failed:', (err as Error).message);
  }
}

export async function addReaction(req: AuthedReq, res: AuthedRes): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ msg: 'Unauthorized' });
      return;
    }
    const messageId = req.params.messageId;
    const emoji = String(req.body.emoji || '').trim();
    if (!messageId || !emoji) {
      res.status(400).json({ msg: 'messageId and emoji are required' });
      return;
    }
    if (!SAFE_EMOJI_RE.test(emoji)) {
      res.status(400).json({ msg: 'emoji must be 1–8 emoji characters' });
      return;
    }
    const message = await loadMessageContext(messageId);
    if (!message) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
    const { podId } = message;
    if (!(await callerHasPodAccess(podId, userId, req))) {
      res.status(403).json({ msg: 'Not a member of this pod' });
      return;
    }
    const added = await MessageReaction.add(messageId, userId, emoji);
    const rawSummaries = await MessageReaction.listForMessage(messageId, userId);
    const reactions = await decorateReactionSummaries(rawSummaries);
    void emitReactionChange(messageId, podId, reactions);
    if (added) {
      void enqueueReactionAcknowledgement({
        podId,
        authorUserId: message.authorUserId,
        reactorUserId: userId,
        messageId,
        emoji,
        // `dualAuth` populates `req.agentUser` only for cm_agent_* runtime
        // tokens, so its presence IS the authorship answer at this point.
        reactorIsAgent: Boolean(req.agentUser?._id),
      });
    }
    res.json({ ok: true, reactions });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error in addReaction:', (err as Error).message);
    res.status(500).json({ msg: 'Server Error' });
  }
}

export async function removeReaction(req: AuthedReq, res: AuthedRes): Promise<void> {
  try {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ msg: 'Unauthorized' });
      return;
    }
    const messageId = req.params.messageId;
    const emoji = String(req.params.emoji || '').trim();
    if (!messageId || !emoji) {
      res.status(400).json({ msg: 'messageId and emoji are required' });
      return;
    }
    const message = await loadMessageContext(messageId);
    if (!message) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
    const { podId } = message;
    if (!(await callerHasPodAccess(podId, userId, req))) {
      res.status(403).json({ msg: 'Not a member of this pod' });
      return;
    }
    await MessageReaction.remove(messageId, userId, emoji);
    const rawSummaries = await MessageReaction.listForMessage(messageId, userId);
    const reactions = await decorateReactionSummaries(rawSummaries);
    void emitReactionChange(messageId, podId, reactions);
    res.json({ ok: true, reactions });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error in removeReaction:', (err as Error).message);
    res.status(500).json({ msg: 'Server Error' });
  }
}

module.exports = { addReaction, removeReaction };
