/**
 * Per-user, per-thread state — follow and collapse (W-T, TASK-029, 2/4).
 *
 * Two independent booleans on ONE record, per the threading surface ruling
 * (docs/design/threading-surface-ruling.md, "One state record, two booleans").
 * They are written by SEPARATE endpoints even so: following never implies
 * expanded, and one PATCH taking both invites a client to send the pair and
 * clobber the half the user did not touch.
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
const ThreadUserState = require('../models/pg/ThreadUserState');
const { getCallerId, callerHasPodWriteAccess } = require('../services/podWriteAccessService');
const { pool } = require('../config/db-pg');
const { MIGRATION_NAME } = require('../scripts/backfill-thread-root-id');

interface Req {
  params: { messageId?: string };
  query: { podId?: string };
  body?: { collapsed?: unknown };
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

/**
 * The threading cutoff, from the migration ledger the backfill writes.
 *
 * Best-effort by design: an instance that has not run the backfill, or one
 * whose ledger table predates this feature, gets null — which the response
 * documents as "no pre-cutoff roots", the safe reading. Failing the whole
 * thread-state read because a ledger row is missing would take the render
 * path down for a cosmetic default.
 */
async function readThreadingCutoff(): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      "SELECT details->>'threadingCutoff' AS cutoff FROM migration_records WHERE name = $1",
      [MIGRATION_NAME],
    );
    return rows[0]?.cutoff || null;
  } catch {
    return null;
  }
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
    const row = await ThreadUserState.follow(ctx.rootId, ctx.userId, ctx.podId);
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
    await ThreadUserState.unfollow(ctx.rootId, ctx.userId, ctx.podId);
    // Same reasoning: unfollowing what you do not follow is the state you
    // asked for, so it is a 200 and not a 404.
    res.status(200).json({ threadRootId: ctx.rootId, following: false });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to unfollow thread', error: err?.message });
  }
}

/**
 * The render path's question: my state for every thread in this pod, in one
 * query. Only rows that EXIST are returned — a thread the caller has never
 * touched is absent and the client applies the defaults (collapsed, and
 * following resolved from participation). Sending a row per thread would mean
 * materialising state nobody has expressed.
 */
export async function listThreadState(req: Req, res: Res): Promise<void> {
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
    const [rows, threadingCutoff] = await Promise.all([
      ThreadUserState.stateForPod(userId, podId),
      readThreadingCutoff(),
    ]);
    res.status(200).json({
      podId,
      // Defaults are stated in the response so a client never has to hardcode
      // them, and so a change to them is visible at the wire rather than only
      // in two codebases that have to agree.
      //
      // `expandedForRootsCreatedBefore` is the #1115 carve-out: a thread whose
      // root pre-dates the threading migration renders expanded, so nothing
      // visible in history disappears under a headline card on ship day.
      //
      // Returned as ONE timestamp rather than resolved per thread. Resolving
      // server-side would mean enumerating every root in the pod and joining
      // messages.created_at — duplicating data the client already has, since
      // it is rendering those messages. This is O(1) and the comparison is a
      // date compare. @sprint-review (56862) was right that the shipped
      // contract could not express the rule; this is the smallest thing that
      // can.
      //
      // null = no pre-cutoff roots exist (fresh instance, or the backfill has
      // not run). NOT "unknown" — a client must not expand everything on null.
      defaults: { collapsed: true, following: null, expandedForRootsCreatedBefore: threadingCutoff },
      threads: rows.map((r: any) => ({
        threadRootId: Number(r.thread_root_id),
        following: r.following === null ? null : Boolean(r.following),
        collapsed: Boolean(r.collapsed),
      })),
    });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to list thread state', error: err?.message });
  }
}

/**
 * The expand/collapse gesture — the only writer of `collapsed`.
 *
 * Separate from follow on purpose: following never implies expanded, so a
 * single "thread state" PATCH taking both booleans would invite a client to
 * send the pair and silently overwrite the one the user did not touch.
 */
export async function setThreadCollapsed(req: Req, res: Res): Promise<void> {
  try {
    const collapsedRaw = (req.body || {}).collapsed;
    if (typeof collapsedRaw !== 'boolean') {
      res.status(400).json({ msg: 'collapsed (boolean) is required' });
      return;
    }
    const ctx = await authorize(req, res);
    if (!ctx) return;
    await ThreadUserState.setCollapsed(ctx.rootId, ctx.userId, ctx.podId, collapsedRaw);
    res.status(200).json({ threadRootId: ctx.rootId, collapsed: collapsedRaw });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to set collapse state', error: err?.message });
  }
}

module.exports = { followThread, unfollowThread, listThreadState, setThreadCollapsed };
Object.assign(module.exports, exports);
