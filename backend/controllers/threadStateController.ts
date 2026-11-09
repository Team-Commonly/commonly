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
const PGMessage = require('../models/pg/Message');
const { getCallerId, callerHasPodWriteAccess } = require('../services/podWriteAccessService');
const { pool } = require('../config/db-pg');
const {
  THREADING_BACKFILL_MIGRATION: MIGRATION_NAME,
  READ_POINT_MIGRATION,
} = require('../constants/migrations');

interface Req {
  params: { messageId?: string };
  query: { podId?: string };
  body?: { collapsed?: unknown; at?: unknown };
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

/**
 * The read-tracking epoch (D278): when migration 0011 was applied, as ISO, or
 * null when that can't be read.
 *
 * Before this moment nobody could have stored a read point, so a thread the
 * viewer posted in long ago has no `lastReadAt` — and the client's fallback,
 * "my own newest message is a read point", would call every later reply in it
 * unread on the first load after deploy. The client counts a reply as unread
 * by that fallback only when it is newer than this epoch.
 *
 * Same family as `readThreadingCutoff` above, and the same direction on
 * failure: unknown resolves to the quiet side. A null epoch makes the client
 * show no fallback unread mark and auto-open nothing; a stored `lastReadAt`
 * still counts. Read from `schema_migrations`, the runner's own ledger
 * (config/run-pg-migrations.ts), keyed by file name.
 */
async function readReadTrackingSince(): Promise<string | null> {
  try {
    const { rows } = await pool.query(
      'SELECT applied_at FROM schema_migrations WHERE version = $1',
      [READ_POINT_MIGRATION],
    );
    const raw = rows[0]?.applied_at;
    if (raw === null || raw === undefined) return null;
    const at = raw instanceof Date ? raw : new Date(String(raw));
    return Number.isNaN(at.getTime()) ? null : at.toISOString();
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
  // A reconciled message answers to its Mongo id (TASK-313 part 2).
  const pgId = await PGMessage.resolveId(String(req.params.messageId ?? ''));
  const messageId = pgId == null ? 0 : Number(pgId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    res.status(404).json({ msg: 'message not found' });
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
 * query, with `collapsed` ALREADY RESOLVED — @ux-lead's ruling (56996).
 *
 * The client never sees absence and never learns the threading cutoff. Both
 * used to be its job: notice that a root has no row, then compare that root's
 * createdAt against a migration timestamp it had to be told. That is a
 * migration detail in every client's model of the system, permanently, for one
 * boolean. The row is storage; the payload is meaning.
 *
 * `following` is deliberately NOT resolved the same way. Its absence is a
 * VALUE — `null` means "defer to participation", which the wake path computes
 * against live authorship (threadWakeScopeService). Collapsing it to a boolean
 * here would either lie or force this endpoint to recompute participation on
 * the read path. Flagged to @ux-lead, whose 56996 assumed following was
 * already effective; it is not, and the asymmetry is intentional rather than
 * an oversight to be tidied.
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
    const { cutoff, cutoffUnknown } = await readThreadingCutoff();
    const readTrackingSince = await readReadTrackingSince();
    const rows = await ThreadUserState.effectiveStateForPod(userId, podId, cutoff, cutoffUnknown);
    res.status(200).json({
      podId,
      // D278 read-tracking epoch; null when unknown. See readReadTrackingSince.
      readTrackingSince,
      // `following: null` is still a value the client must interpret, so its
      // default stays stated at the wire. `collapsed` no longer appears here
      // because there is no case left in which the client supplies it.
      defaults: {
        following: null,
      },
      // Mapped, not passed through. The model speaks the table's language
      // (`thread_root_id`); the wire has said `threadRootId` since 2/4 shipped
      // and no ruling changed that. Handing the rows straight out silently
      // renamed a public field — caught by threadStateReadContract, which is
      // the reason that suite reads through the controller rather than the
      // model.
      // `lastReadAt` is the caller's read point (D278): ISO, or null when they
      // have never opened the thread. Null is a value — it renders no unread
      // mark — so it is sent rather than omitted.
      threads: rows.map((r: {
        thread_root_id: number; following: boolean | null; collapsed: boolean; last_read_at: string | null;
      }) => ({
        threadRootId: r.thread_root_id,
        following: r.following,
        collapsed: r.collapsed,
        lastReadAt: r.last_read_at ?? null,
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

/**
 * A person's read point in a thread (D278) — the only writer of
 * `last_read_at`. The client calls it while a thread is open, with the time of
 * the newest reply it rendered.
 *
 * Same gate as the collapse gesture, by sharing `authorize`: the pod is the one
 * that owns the message, never one the client names, so a member of one pod
 * cannot write a read point against another pod's thread, and any message in a
 * thread resolves to its root.
 *
 * `at` must be an ISO 8601 date-time string that parses. Anything else is a
 * 400 before the database is touched. The model clamps it to now and only
 * moves forward, so a stale or replayed write is a 200 that changes nothing;
 * the response carries the stored point either way.
 */
const ISO_TIME = '([01]\\d|2[0-3]):[0-5]\\d(:[0-5]\\d(\\.\\d{1,6})?)?';
const ISO_ZONE = '(Z|[+-]([01]\\d|2[0-3]):?[0-5]\\d)';
const ISO_DATE_TIME = new RegExp(`^(\\d{4})-(\\d{2})-(\\d{2})T${ISO_TIME}${ISO_ZONE}$`);

/**
 * Parse `at` strictly. The shape check alone lets `2026-02-30` through, and
 * Date rolls it over to March 2; the calendar day must survive a round trip.
 */
const parseReadAt = (raw: unknown): Date | null => {
  if (typeof raw !== 'string') return null;
  const shape = ISO_DATE_TIME.exec(raw);
  if (!shape) return null;
  const [year, month, day] = [Number(shape[1]), Number(shape[2]), Number(shape[3])];
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1
    || calendar.getUTCDate() !== day) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
};

export async function setThreadRead(req: Req, res: Res): Promise<void> {
  try {
    const at = parseReadAt((req.body || {}).at);
    if (!at) {
      res.status(400).json({ msg: 'at (ISO 8601 date-time) is required' });
      return;
    }
    const ctx = await authorize(req, res);
    if (!ctx) return;
    const lastReadAt = await ThreadUserState.markRead(ctx.rootId, ctx.userId, ctx.podId, at);
    res.status(200).json({ threadRootId: ctx.rootId, lastReadAt });
  } catch (err: any) {
    res.status(500).json({ msg: 'failed to set read point', error: err?.message });
  }
}

module.exports = {
  followThread, unfollowThread, listThreadState, setThreadCollapsed, setThreadRead,
};
Object.assign(module.exports, exports);
