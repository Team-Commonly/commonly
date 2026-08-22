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
const { THREADING_BACKFILL_MIGRATION: MIGRATION_NAME } = require('../constants/migrations');

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
 * The threading cutoff from the migration ledger, and whether it is knowable.
 *
 * Final shape per the merged ruling (docs/design/threading-surface-ruling.md,
 * "Pre-cutoff roots default to expanded"), which went further than my first
 * two attempts and is worth restating because both were wrong in the same
 * direction — toward collapsing:
 *
 *   row exists  -> the cutoff governs. Roots at or before it render expanded.
 *   row missing -> UNKNOWN, and unknown resolves to EXPAND EVERYTHING.
 *
 * Not "no pre-cutoff roots". Collapsed hides history and the user cannot tell
 * anything is missing; expanded is merely noisy and one click fixes it. An
 * ambiguous state must resolve to the non-destructive side.
 *
 * The un-rooted probe I had here is GONE. It tried to distinguish "fresh
 * instance" from "backfill not yet run" by counting un-rooted edges, and the
 * ruling retires it for two reasons. It cannot work: after a backfill the old
 * threads are rooted and indistinguishable from new ones, so zero un-rooted
 * means "no history" OR "already backfilled", and the row that would tell them
 * apart is the one that is missing. And it counted ORPHANS — a reply whose
 * parent is gone stays un-rooted by design, so one dead row would have pinned
 * the whole instance to expand forever.
 *
 * The backfill now always writes the row, even when it roots zero edges, so a
 * migrated instance can never present a missing row. That is what makes
 * "missing means unknown" safe rather than permanent.
 */
async function readThreadingCutoff(): Promise<{ cutoff: string | null; cutoffUnknown: boolean }> {
  try {
    const { rows } = await pool.query(
      "SELECT details->>'threadingCutoff' AS cutoff FROM migration_records WHERE name = $1",
      [MIGRATION_NAME],
    );
    // A row with a NULL cutoff still counts as written: the backfill ran and
    // found nothing to root, which is knowledge, not absence.
    if (rows.length > 0) return { cutoff: rows[0].cutoff ?? null, cutoffUnknown: false };
    return { cutoff: null, cutoffUnknown: true };
  } catch {
    // Fails toward unknown, i.e. toward expanding. Same reasoning: the
    // recoverable error is the noisy one.
    return { cutoff: null, cutoffUnknown: true };
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
    const { cutoff, cutoffUnknown } = threadingCutoff;
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
      // Three states, and the third is the one that matters:
      //   cutoff set                    -> roots at or before it render expanded
      //   cutoff null, unknown false    -> the backfill ran and rooted nothing;
      //                                    there is no pre-cutoff history
      //   cutoffUnknown true            -> no ledger row. EXPAND EVERYTHING;
      //                                    never collapse on an unknown.
      defaults: {
        collapsed: true,
        following: null,
        expandedForRootsCreatedBefore: cutoff,
        cutoffUnknown,
      },
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
