// Sprint B5: reaction add / remove controller. Per-message toggle —
// adding a reaction the user already left is a no-op (idempotent via
// the unique constraint); removing one they don't have is also a no-op.
// Both endpoints emit a `messageReaction` Socket.io event into
// `pod_${podId}` so other clients animate the chip without polling.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MessageReaction = require('../models/pg/MessageReaction').default;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { decorateReactionSummaries } = require('../services/reactionAttributionService');

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

const SAFE_EMOJI_RE = /^[\p{Emoji}‍]{1,8}$/u;

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
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2 LIMIT 1',
    [podId, userId],
  );
  return (result.rowCount || 0) > 0;
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

async function loadPodIdForMessage(messageId: string | number): Promise<string | null> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT pod_id FROM messages WHERE id = $1 LIMIT 1',
    [Number(messageId)],
  );
  const row = result.rows[0];
  return row ? String(row.pod_id) : null;
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
    const podId = await loadPodIdForMessage(messageId);
    if (!podId) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
    if (!(await callerHasPodAccess(podId, userId, req))) {
      res.status(403).json({ msg: 'Not a member of this pod' });
      return;
    }
    await MessageReaction.add(messageId, userId, emoji);
    const rawSummaries = await MessageReaction.listForMessage(messageId, userId);
    const reactions = await decorateReactionSummaries(rawSummaries);
    void emitReactionChange(messageId, podId, reactions);
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
    const podId = await loadPodIdForMessage(messageId);
    if (!podId) {
      res.status(404).json({ msg: 'Message not found' });
      return;
    }
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
