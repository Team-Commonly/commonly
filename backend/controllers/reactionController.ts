// Sprint B5: reaction add / remove controller. Per-message toggle —
// adding a reaction the user already left is a no-op (idempotent via
// the unique constraint); removing one they don't have is also a no-op.
// Both endpoints emit a `messageReaction` Socket.io event into
// `pod_${podId}` so other clients animate the chip without polling.

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MessageReaction = require('../models/pg/MessageReaction').default;

interface AuthedReq {
  params: { messageId?: string; emoji?: string };
  body: { emoji?: string };
  user?: { _id?: unknown };
  userId?: unknown;
}
interface AuthedRes {
  status: (n: number) => AuthedRes;
  json: (d: unknown) => void;
}

const SAFE_EMOJI_RE = /^[\p{Emoji}‍]{1,8}$/u;

function getUserId(req: AuthedReq): string {
  return String(req.user?._id || req.userId || '');
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

async function userHasPodMembership(podId: string, userId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg');
  const result = await pool.query(
    'SELECT 1 FROM pod_members WHERE pod_id = $1 AND user_id = $2 LIMIT 1',
    [podId, userId],
  );
  return (result.rowCount || 0) > 0;
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
    if (!(await userHasPodMembership(podId, userId))) {
      res.status(403).json({ msg: 'Not a member of this pod' });
      return;
    }
    await MessageReaction.add(messageId, userId, emoji);
    const reactions = await MessageReaction.listForMessage(messageId, userId);
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
    if (!(await userHasPodMembership(podId, userId))) {
      res.status(403).json({ msg: 'Not a member of this pod' });
      return;
    }
    await MessageReaction.remove(messageId, userId, emoji);
    const reactions = await MessageReaction.listForMessage(messageId, userId);
    void emitReactionChange(messageId, podId, reactions);
    res.json({ ok: true, reactions });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('Error in removeReaction:', (err as Error).message);
    res.status(500).json({ msg: 'Server Error' });
  }
}

module.exports = { addReaction, removeReaction };
