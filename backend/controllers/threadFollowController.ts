/**
 * Thread follow / unfollow (W-T, TASK-029, 2/4).
 *
 * Following is a SUBSCRIPTION, deliberately not an addressing edge. Nothing
 * here writes reply_to_message_id and nothing here enqueues a mention — 3/4
 * consumes this state in the wake path, ambient-only per the #1045 ruling. If
 * a future change makes following a thread ping anyone directly, that is the
 * bug this separation exists to prevent.
 *
 * You may follow from ANY message in a thread, not only its root: the root is
 * resolved server-side via COALESCE(thread_root_id, id), matching the write
 * path's derivation in models/pg/Message. A client should never have to know
 * whether the message it is looking at happens to be a root.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */
const ThreadFollow = require('../models/pg/ThreadFollow');
const { getCallerId, callerHasPodWriteAccess } = require('../services/podWriteAccessService');
const { pool } = require('../config/db-pg');

interface Req {
  params: { messageId?: string };
  query: { podId?: string };
  user?: { _id?: unknown };
  userId?: unknown;
  agentUser?: { _id?: unknown };
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

/**
 * Resolve the thread root for any message id, and return the pod so the
 * caller's membership can be checked against the pod that actually owns the
 * message rather than one supplied by the client.
 */
async function resolveRoot(messageId: number): Promise<{ rootId: number; podId: string } | null> {
  const { rows } = await pool.query(
    'SELECT COALESCE(thread_root_id, id) AS root_id, pod_id FROM messages WHERE id = $1',
    [messageId],
  );
  if (!rows.length) return null;
  return { rootId: Number(rows[0].root_id), podId: String(rows[0].pod_id) };
}

async function authorize(req: Req, res: Res): Promise<{ rootId: number; podId: string; userId: string } | null> {
  const userId = getCallerId(req);
  if (!userId) {
    res.status(401).json({ msg: 'auth required' });
    return null;
  }
  const messageId = Number(req.params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    res.status(400).json({ msg: 'messageId must be a positive integer' });
    return null;
  }
  const resolved = await resolveRoot(messageId);
  if (!resolved) {
    res.status(404).json({ msg: 'message not found' });
    return null;
  }
  if (!(await callerHasPodWriteAccess(resolved.podId, userId, req))) {
    // 403 and not 404: the caller named a real message. Membership on chat
    // pods is not a secret the way DM existence is.
    res.status(403).json({ msg: 'not a member of this pod' });
    return null;
  }
  return { ...resolved, userId };
}

export async function followThread(req: Req, res: Res): Promise<void> {
  try {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    const row = await ThreadFollow.follow(ctx.rootId, ctx.userId, ctx.podId);
    // 200 rather than 201 on both create and re-follow. The client asked for a
    // state, it has that state; distinguishing "already following" would make
    // a double-click look like a failure for no gain to any caller.
    res.status(200).json({ threadRootId: ctx.rootId, podId: ctx.podId, following: true, followedAt: row?.followed_at });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to follow thread', error: err?.message });
  }
}

export async function unfollowThread(req: Req, res: Res): Promise<void> {
  try {
    const ctx = await authorize(req, res);
    if (!ctx) return;
    await ThreadFollow.unfollow(ctx.rootId, ctx.userId);
    // Same reasoning: unfollowing what you do not follow is the state you
    // asked for, so it is a 200 and not a 404.
    res.status(200).json({ threadRootId: ctx.rootId, following: false });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to unfollow thread', error: err?.message });
  }
}

/** What am I following in this pod — the render path's question. */
export async function listFollowedThreads(req: Req, res: Res): Promise<void> {
  try {
    const userId = getCallerId(req);
    if (!userId) {
      res.status(401).json({ msg: 'auth required' });
      return;
    }
    const podId = String(req.query.podId || '');
    if (!podId) {
      res.status(400).json({ msg: 'podId is required' });
      return;
    }
    if (!(await callerHasPodWriteAccess(podId, userId, req))) {
      res.status(403).json({ msg: 'not a member of this pod' });
      return;
    }
    const threadRootIds = await ThreadFollow.followedRootsForUser(userId, podId);
    res.status(200).json({ podId, threadRootIds });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to list followed threads', error: err?.message });
  }
}

module.exports = { followThread, unfollowThread, listFollowedThreads };
Object.assign(module.exports, exports);
