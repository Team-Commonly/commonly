/**
 * F183: nightly repair of the PostgreSQL mirror from MongoDB.
 *
 * Mongo is the source of truth for pods, pod membership and users. PG holds
 * mirrors (`pods`, `pod_members`, `users`) that the PG chat listings and the
 * message author join read. Writes that skipped the mirror left 860 drifted
 * rows on production by 2026-11-05, 39 of them a wrong `pods.created_by`.
 * pgMirrorWrite.ts closes the known bypass writers; this job catches the rest
 * and says loudly when a new one appears.
 *
 * Rules:
 *   - Direction is Mongo → PG only.
 *   - Report-only unless PG_MIRROR_REPAIR_APPLY=1. The env var is the only way
 *     to apply; there is no option that bypasses it.
 *   - One run at a time: a session advisory lock; a second run returns
 *     `skipped: 'locked'` and writes nothing, not even a run row.
 *   - Never deletes a PG pod or user Mongo lacks. A PG-only pod holds messages
 *     and `messages.pod_id` cascades on delete, so it is reported with its
 *     message count. A PG-only user named "Deleted user" with no picture is the
 *     account-deletion tombstone (accountDeletionService) and counts as
 *     explained.
 *   - Ghost memberships are deleted only through the fail-closed classifier
 *     in services/podMemberClassifier (shared with scripts/cleanup-ghost-pod-members);
 *     if any pod cannot be read, or ghosts exceed GHOST_FLOOR_RATIO of all
 *     rows, no ghost is deleted.
 *   - The snapshot is minutes old by write time. Pod field fixes, missing-pod
 *     inserts, ghost deletes and user syncs re-read Mongo first, and a user
 *     sync never overwrites a PG tombstone. Missing-member adds write from the
 *     snapshot (a member who left mid-run is a ghost the next run removes).
 *   - Every change logs one line with the before-value. Pod fields are logged
 *     verbatim (needed to undo a bad run); user labels and pictures are
 *     fingerprinted, and no email is ever read.
 *
 * Each run writes one row to `pg_mirror_repair_runs` (migration 0008) and one
 * summary log line. It alerts (an ERROR `[pg-mirror-alert]` log line, plus the
 * SRE alerts pod via spendAlarmService.pageSre) when a `created_by` mismatch
 * appears that the previous run did not see, when a category grows by more
 * than 20 against the previous run, when a key the previous run repaired
 * drifts again, when the ghost floor trips, or when the run fails (before or
 * after its run row exists).
 */
import { createHash } from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const MongoPod = require('../models/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const User = require('../models/User');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const PGPod = require('../models/pg/Pod');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentIdentityService = require('./agentIdentityService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { syncPodFromMongo } = require('./pgPodSyncService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { classifyMemberRows } = require('./podMemberClassifier');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isListedPodMember } = require('../utils/isPodMember');

interface QueryResult { rows: Record<string, unknown>[]; rowCount?: number | null }
interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  release: (destroy?: boolean) => void;
}
interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<QueryResult>;
  connect: () => Promise<PgClient>;
}

export interface RepairLogger {
  info: (line: string) => void;
  warn: (line: string) => void;
  error: (line: string) => void;
}

export interface RepairOptions {
  logger?: RepairLogger;
  /** Delivers an alert to SRE. Defaults to spendAlarmService.pageSre. */
  page?: (content: string) => Promise<void>;
  /** How long a page may take before the run gives up on it. Defaults to PAGE_TIMEOUT_MS. */
  pageTimeoutMs?: number;
}

export interface RepairReport {
  skipped?: 'locked' | 'no-pg';
  runId?: number;
  applied: boolean;
  counts: Record<string, number>;
  unexplained: number;
  repeats: string[];
  orphanPods: Array<{ id: string; messages: number }>;
  alerts: string[];
  error?: string;
}

/** Session advisory lock keys. (313, 2) is legacyMessageCopy; (1129270605, 504) the migration runner. */
export const LOCK_KEYS = [313, 183];
export const JUMP_THRESHOLD = 20;
const TOMBSTONE_USERNAME = 'Deleted user';
const USER_FIELDS = '_id username displayName isBot botMetadata profilePicture createdAt';
const MAX_STORED_KEYS = 5000;
/** A page runs while the advisory lock is held; a hung one must not keep it. */
export const PAGE_TIMEOUT_MS = 10000;
const MAX_DETAIL_LINES = 200;
/** Ghost deletes stop when more than this share of all pod_members rows are ghosts... */
export const GHOST_FLOOR_RATIO = 0.2;
/** ...and there are more than this many: a small instance's handful of ghosts is still repaired. */
export const GHOST_FLOOR_MIN = 10;
/** PG column widths (config/migrations/0001). A longer Mongo value cannot be mirrored. */
const POD_FIELD_LIMITS: Record<string, number> = { name: 100, type: 50, created_by: 24 };
const USERNAME_LIMIT = 100;

const COUNT_KEYS = [
  'pods_missing', 'pods_name', 'pods_description', 'pods_type', 'pods_created_by', 'pods_orphan',
  'members_missing', 'members_ghost', 'members_orphan_pod', 'members_unreadable',
  'users_missing', 'users_username', 'users_profile_picture', 'users_is_bot', 'users_orphan', 'users_tombstone',
  'users_deleting', 'unrepairable', 'repairs_failed', 'repeats',
] as const;

const TAG = '[pg-mirror-repair]';
const ALERT_TAG = '[pg-mirror-alert]';

const defaultLogger: RepairLogger = {
  info: (l) => console.log(l),
  warn: (l) => console.warn(l),
  error: (l) => console.error(l),
};

const defaultPage = async (content: string): Promise<void> => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pageSre } = require('./spendAlarmService');
  await pageSre(content);
};

const loadPool = (): PgPool | null => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  return pool;
};

const verbatim = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  const text = String(value);
  return JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text);
};

// User labels and pictures can identify a person; the log carries a stable
// fingerprint so two runs can be compared without printing the value.
const fingerprint = (value: unknown): string => {
  if (value === null || value === undefined) return 'null';
  const text = String(value);
  return `sha256:${createHash('sha256').update(text).digest('hex').slice(0, 12)}(len=${text.length})`;
};

/**
 * The keys a run stores, capped at `max`. created_by keys are never cut: the
 * next run pages for any created_by key missing from this list, so a cut key
 * would page again every night.
 */
export const selectStoredKeys = (keys: string[], max: number): string[] => {
  const unique = [...new Set(keys)];
  const createdBy = unique.filter((k) => k.endsWith(':created_by'));
  const rest = unique.filter((k) => !k.endsWith(':created_by'));
  return [...createdBy, ...rest.slice(0, Math.max(0, max - createdBy.length))];
};

const withTimeout = async (work: Promise<void>, ms: number): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([work, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
      timer.unref?.();
    })]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));

export async function runPgMirrorRepair(options: RepairOptions = {}): Promise<RepairReport> {
  const logger = options.logger || defaultLogger;
  const rawPage = options.page || defaultPage;
  const pageTimeoutMs = options.pageTimeoutMs ?? PAGE_TIMEOUT_MS;
  const page = (content: string): Promise<void> => withTimeout(
    Promise.resolve().then(() => rawPage(content)), pageTimeoutMs,
  );
  const applied = process.env.PG_MIRROR_REPAIR_APPLY === '1';
  const counts: Record<string, number> = Object.fromEntries(COUNT_KEYS.map((k) => [k, 0]));
  const report: RepairReport = {
    applied, counts, unexplained: 0, repeats: [], orphanPods: [], alerts: [],
  };

  const pool = loadPool();
  if (!pool) {
    logger.warn(`${TAG} skipped: PostgreSQL is not configured`);
    return { ...report, skipped: 'no-pg' };
  }

  try {
    const lockClient = await pool.connect();
    let locked = false;
    try {
      const lock = await lockClient.query(
        'SELECT pg_try_advisory_lock($1::integer, $2::integer) AS acquired', LOCK_KEYS,
      );
      locked = lock.rows[0]?.acquired === true;
      if (!locked) {
        logger.warn(`${TAG} skipped: another run holds the advisory lock`);
        return { ...report, skipped: 'locked' };
      }
      return await runLocked(pool, report, logger, page);
    } finally {
      try {
        if (locked) await lockClient.query('SELECT pg_advisory_unlock($1::integer, $2::integer)', LOCK_KEYS);
        lockClient.release();
      } catch {
        // A session that cannot unlock may still hold the lock: destroy it.
        lockClient.release(true);
      }
    }
  } catch (error) {
    // Anything that escapes runLocked's own recording: the connection, the
    // lock, the previous-run read, the run-row insert. No run row says so, so
    // the alert line and the page are the only record.
    const message = ((error as Error)?.message || String(error)).slice(0, 200);
    logger.error(`${ALERT_TAG} ${JSON.stringify({ run: report.runId ?? null, applied, alerts: [`run failed: ${message}`] })}`);
    try {
      await page(`[pg mirror] run failed before it could record itself (${applied ? 'applied' : 'report-only'}): `
        + `${message}. Details: backend log tag ${TAG}.`);
    } catch (pageError) {
      logger.warn(`${TAG} SRE page failed; the ${ALERT_TAG} log line stands: ${(pageError as Error)?.message}`);
    }
    throw error;
  }
}

interface PreviousRun {
  applied: boolean;
  counts: Record<string, number>;
  /** Every drift key the previous run observed. */
  keys: Set<string>;
  /** The keys it actually repaired. Only these can come back as a repeat. */
  repairedKeys: Set<string>;
}

async function runLocked(
  pool: PgPool,
  report: RepairReport,
  logger: RepairLogger,
  page: (content: string) => Promise<void>,
): Promise<RepairReport> {
  const { counts, applied } = report;
  const prevRow = (await pool.query(
    `SELECT applied, counts, mismatch_keys, repaired_keys FROM pg_mirror_repair_runs
      WHERE finished_at IS NOT NULL AND error IS NULL
      ORDER BY started_at DESC, id DESC LIMIT 1`,
  )).rows[0];
  const previous: PreviousRun | null = prevRow ? {
    applied: prevRow.applied === true,
    counts: (prevRow.counts || {}) as Record<string, number>,
    keys: new Set((prevRow.mismatch_keys || []) as string[]),
    repairedKeys: new Set((prevRow.repaired_keys || []) as string[]),
  } : null;

  const runId = Number((await pool.query(
    'INSERT INTO pg_mirror_repair_runs (applied) VALUES ($1) RETURNING id', [applied],
  )).rows[0].id);
  report.runId = runId;

  const keys: string[] = [];
  const repaired: string[] = [];
  // One line per change, uncapped: the before-value is what undoes a bad run.
  const repairLine = (text: string) => {
    logger.info(`${TAG} ${applied ? 'repair' : 'would-repair'} ${text}`);
  };
  const failed = (what: string, error: unknown) => {
    counts.repairs_failed += 1;
    logger.warn(`${TAG} repair failed ${what}: ${(error as Error)?.message || String(error)}`);
  };
  // A value PG cannot hold (wider than its column). Not a failure to retry and
  // not a repeat: it needs a schema or data decision, so it is its own count.
  const unrepairable = (what: string) => {
    counts.unrepairable += 1;
    logger.warn(`${TAG} unrepairable ${what}`);
  };
  const skippedChanged = (what: string) => {
    logger.info(`${TAG} skip ${what}: changed since the snapshot; left as it now is`);
  };

  try {
    // ── Read both sides first. A Mongo read failure aborts before any write.
    const mongoPods = await MongoPod.find({})
      .select('_id name description type createdBy members').lean() as Array<{
        _id: unknown; name?: string; description?: string; type?: string; createdBy?: unknown; members?: unknown[];
      }>;
    const mongoUsers = await User.find({}).select(USER_FIELDS);
    const pgPods = (await pool.query('SELECT id, name, description, type, created_by FROM pods')).rows;
    const pgMembers = (await pool.query('SELECT pod_id, user_id FROM pod_members')).rows
      .map((r) => ({ podId: String(r.pod_id), userId: String(r.user_id) }));
    const pgUsers = (await pool.query('SELECT _id, username, profile_picture, is_bot FROM users')).rows;

    const mongoPodById = new Map(mongoPods.map((p) => [String(p._id), p]));
    const pgPodById = new Map(pgPods.map((p) => [String(p.id), p]));

    // A pod row PG cannot hold is unrepairable, not a failed insert.
    const overLimit = (podId: string, pod: typeof mongoPods[0]): boolean => {
      const values: Record<string, string> = {
        name: str(pod.name), type: str(pod.type) || 'chat', created_by: str(pod.createdBy),
      };
      const field = Object.keys(values).find((f) => values[f].length > POD_FIELD_LIMITS[f]);
      if (!field) return false;
      unrepairable(`pods id=${podId} field=${field} len=${values[field].length} limit=${POD_FIELD_LIMITS[field]}`);
      return true;
    };

    // ── pods: missing in PG
    for (const mp of mongoPods) {
      const podId = String(mp._id);
      if (pgPodById.has(podId)) continue;
      if (overLimit(podId, mp)) continue;
      counts.pods_missing += 1;
      keys.push(`pods:${podId}:row`);
      repairLine(`pods id=${podId} field=row before=absent after=present created_by=${str(mp.createdBy)}`);
      if (!applied) continue;
      try {
        // syncPodFromMongo inserts what Mongo holds now: check the limits on
        // that, not on the snapshot.
        const current = await MongoPod.findById(podId).select('_id name type createdBy').lean() as
          typeof mongoPods[0] | null;
        if (current && overLimit(podId, current)) continue;
        // syncPodFromMongo takes the owner from Mongo and copies every member.
        if (!current || !(await syncPodFromMongo(podId, str(mp.createdBy)))) {
          skippedChanged(`pods id=${podId} insert (deleted from Mongo)`);
          continue;
        }
        repaired.push(`pods:${podId}:row`);
      } catch (error) {
        failed(`pods id=${podId} insert`, error);
        continue;
      }
      // syncPodFromMongo settles each member insert and never throws for one,
      // so check which landed against Mongo's members as they are now.
      try {
        const fresh = await MongoPod.findById(podId).select('members').lean() as { members?: unknown[] } | null;
        const landed = new Set((await pool.query('SELECT user_id FROM pod_members WHERE pod_id = $1', [podId]))
          .rows.map((r) => String(r.user_id)));
        for (const member of fresh?.members || []) {
          const userId = String(member);
          if (!landed.has(userId)) failed(`pod_members pod=${podId} user=${userId} add`, 'not written by the pod sync');
        }
      } catch (error) {
        failed(`pods id=${podId} member check`, error);
      }
    }

    // ── pods: field drift, compare-and-set so a concurrent write is never overwritten
    type PodField = 'name' | 'description' | 'type' | 'created_by';
    const podFields: Array<{ field: PodField; want: (mp: typeof mongoPods[0]) => string | null }> = [
      { field: 'name', want: (mp) => str(mp.name) },
      { field: 'description', want: (mp) => str(mp.description) },
      { field: 'type', want: (mp) => str(mp.type) || 'chat' },
      // A Mongo pod without an owner cannot fill a NOT NULL column: skip it.
      { field: 'created_by', want: (mp) => (mp.createdBy ? String(mp.createdBy) : null) },
    ];
    const podFieldSelect = '_id name description type createdBy';
    for (const pp of pgPods) {
      const podId = String(pp.id);
      const mp = mongoPodById.get(podId);
      if (!mp) continue;
      // Read once per pod, only when a write is due: the snapshot is minutes
      // old by now, and a rename in between landed in both stores.
      let fresh: typeof mongoPods[0] | null | undefined;
      for (const { field, want } of podFields) {
        const after = want(mp);
        if (after === null) continue;
        const before = pp[field];
        if (str(before) === after) continue;
        keys.push(`pods:${podId}:${field}`);
        if (after.length > POD_FIELD_LIMITS[field]) {
          unrepairable(`pods id=${podId} field=${field} len=${after.length} limit=${POD_FIELD_LIMITS[field]}`);
          continue;
        }
        counts[`pods_${field}`] += 1;
        repairLine(`pods id=${podId} field=${field} before=${verbatim(before)} after=${verbatim(after)}`);
        if (!applied) continue;
        try {
          if (fresh === undefined) fresh = await MongoPod.findById(podId).select(podFieldSelect).lean();
          const now = fresh ? want(fresh) : null;
          if (now === null || now === str(before) || now.length > POD_FIELD_LIMITS[field]) {
            skippedChanged(`pods id=${podId} field=${field}`);
            continue;
          }
          const res = await pool.query(
            `UPDATE pods SET ${field} = $1, updated_at = CURRENT_TIMESTAMP
              WHERE id = $2 AND ${field} IS NOT DISTINCT FROM $3`,
            [now, podId, before ?? null],
          );
          if (!res.rowCount) throw new Error('row changed during the run; left for the next run');
          repaired.push(`pods:${podId}:${field}`);
        } catch (error) {
          failed(`pods id=${podId} field=${field}`, error);
        }
      }
    }

    // ── orphan pods: reported with their message count, never deleted
    const orphanIds = pgPods.map((p) => String(p.id)).filter((id) => !mongoPodById.has(id));
    counts.pods_orphan = orphanIds.length;
    if (orphanIds.length) {
      const msgCounts = new Map((await pool.query(
        'SELECT pod_id, count(*)::int AS n FROM messages WHERE pod_id = ANY($1) GROUP BY pod_id', [orphanIds],
      )).rows.map((r) => [String(r.pod_id), Number(r.n)]));
      report.orphanPods = orphanIds.map((id) => ({ id, messages: msgCounts.get(id) || 0 }));
      report.orphanPods.slice(0, MAX_DETAIL_LINES).forEach((o) => {
        logger.warn(`${TAG} orphan pod id=${o.id} messages=${o.messages} (PG only; kept)`);
      });
    }

    // ── pod_members: missing, for pods PG already had (a newly inserted pod got its members above)
    const pgMemberSet = new Set(pgMembers.map((r) => `${r.podId}:${r.userId}`));
    for (const pp of pgPods) {
      const podId = String(pp.id);
      const mp = mongoPodById.get(podId);
      if (!mp) continue;
      for (const member of mp.members || []) {
        const userId = String(member);
        if (pgMemberSet.has(`${podId}:${userId}`)) continue;
        counts.members_missing += 1;
        keys.push(`pod_members:${podId}:${userId}:missing`);
        repairLine(`pod_members pod=${podId} user=${userId} field=row before=absent after=present`);
        if (!applied) continue;
        try {
          await PGPod.addMember(podId, userId);
          repaired.push(`pod_members:${podId}:${userId}:missing`);
        } catch (error) {
          failed(`pod_members pod=${podId} user=${userId} add`, error);
        }
      }
    }

    // ── pod_members: ghosts, through the shared fail-closed classifier
    const classified = await classifyMemberRows(pgMembers);
    counts.members_ghost = classified.ghostRows.length;
    counts.members_orphan_pod = classified.orphanRows.length;
    counts.members_unreadable = classified.unreadable;
    const ghostFloor = classified.ghostRows.length > GHOST_FLOOR_MIN
      && classified.ghostRows.length > pgMembers.length * GHOST_FLOOR_RATIO;
    const refuseGhostDeletes = classified.unreadable > 0 || ghostFloor;
    if (classified.unreadable > 0) {
      counts.repairs_failed += classified.ghostRows.length;
      logger.warn(`${TAG} ghost deletes refused: ${classified.unreadable} row(s) on unreadable pods `
        + `(${classified.unreadablePodIds.slice(0, 20).join(',')})`);
    }
    if (ghostFloor) {
      // A fifth of all memberships does not go stale overnight; a Mongo read
      // or classifier fault does. Delete nothing and ask a human.
      const what = `ghost deletes refused: ${classified.ghostRows.length} of ${pgMembers.length} pod_members rows `
        + `classify as ghosts (over ${GHOST_FLOOR_RATIO * 100}%)`;
      logger.warn(`${TAG} ${what}`);
      report.alerts.push(what);
    }
    for (const row of classified.ghostRows as Array<{ podId: string; userId: string }>) {
      keys.push(`pod_members:${row.podId}:${row.userId}:ghost`);
      repairLine(`pod_members pod=${row.podId} user=${row.userId} field=row before=present after=absent`);
      if (!applied || refuseGhostDeletes) continue;
      try {
        // The classifier judged this row at the start of the run; a user who
        // joined since is a real member now.
        const current = await MongoPod.findById(row.podId).select('members').lean();
        if (!current || isListedPodMember(current, row.userId)) {
          skippedChanged(`pod_members pod=${row.podId} user=${row.userId} delete`);
          continue;
        }
        await pool.query('DELETE FROM pod_members WHERE pod_id = $1 AND user_id = $2', [row.podId, row.userId]);
        repaired.push(`pod_members:${row.podId}:${row.userId}:ghost`);
      } catch (error) {
        failed(`pod_members pod=${row.podId} user=${row.userId} delete`, error);
      }
    }

    // ── users: missing or drifted, written by the one sync every user path uses
    const pgUserById = new Map(pgUsers.map((u) => [String(u._id), u]));
    const mongoUserIds = new Set<string>();
    for (const user of mongoUsers) {
      const userId = String(user._id);
      mongoUserIds.add(userId);
      const pu = pgUserById.get(userId);
      // accountDeletionService anonymizes the PG row before it deletes the
      // Mongo user, so a tombstone beside a live Mongo row is a deletion in
      // flight. Writing the real label back would un-anonymize the account.
      if (pu && pu.username === TOMBSTONE_USERNAME && pu.profile_picture == null) {
        counts.users_deleting += 1;
        continue;
      }
      const changes: string[] = [];
      const changeKeys: string[] = [];
      if (!pu) {
        counts.users_missing += 1;
        changeKeys.push(`users:${userId}:row`);
        changes.push(`users id=${userId} field=row before=absent after=present`);
      } else {
        const want = {
          username: AgentIdentityService.chatUsernameFor(user),
          profile_picture: user.profilePicture || null,
          is_bot: user.isBot === true,
        };
        if (str(pu.username) !== str(want.username)) {
          counts.users_username += 1;
          changeKeys.push(`users:${userId}:username`);
          changes.push(`users id=${userId} field=username before=${fingerprint(pu.username)}`
            + ` after=${fingerprint(want.username)}`);
        }
        if ((pu.profile_picture ?? null) !== want.profile_picture) {
          counts.users_profile_picture += 1;
          changeKeys.push(`users:${userId}:profile_picture`);
          changes.push(`users id=${userId} field=profile_picture before=${fingerprint(pu.profile_picture)}`
            + ` after=${fingerprint(want.profile_picture)}`);
        }
        if ((pu.is_bot === true) !== want.is_bot) {
          counts.users_is_bot += 1;
          changeKeys.push(`users:${userId}:is_bot`);
          changes.push(`users id=${userId} field=is_bot before=${pu.is_bot === true} after=${want.is_bot}`);
        }
      }
      if (!changes.length) continue;
      keys.push(...changeKeys);
      const label = str(AgentIdentityService.chatUsernameFor(user));
      if (label.length > USERNAME_LIMIT) {
        unrepairable(`users id=${userId} field=username len=${label.length} limit=${USERNAME_LIMIT}`);
        continue;
      }
      changes.forEach(repairLine);
      if (!applied) continue;
      try {
        // The snapshot is minutes old. Sync what Mongo holds now, and nothing
        // for an account deleted (or being deleted) in between.
        const current = await User.findById(userId).select(USER_FIELDS);
        if (!current) {
          skippedChanged(`users id=${userId} (deleted from Mongo)`);
          continue;
        }
        const row = (await pool.query('SELECT username, profile_picture FROM users WHERE _id = $1', [userId])).rows[0];
        if (row && row.username === TOMBSTONE_USERNAME && row.profile_picture == null) {
          skippedChanged(`users id=${userId} (account deletion in flight)`);
          continue;
        }
        // keepTombstone: the UPDATE itself skips an anonymized row, which
        // closes the gap between the re-check above and this write.
        const ok = await AgentIdentityService.syncUserToPostgreSQL(current, { keepTombstone: true });
        if (!ok) throw new Error('syncUserToPostgreSQL returned false');
        repaired.push(...changeKeys);
      } catch (error) {
        failed(`users id=${userId} sync`, error);
      }
    }
    for (const pu of pgUsers) {
      const userId = String(pu._id);
      if (mongoUserIds.has(userId)) continue;
      if (pu.username === TOMBSTONE_USERNAME && pu.profile_picture == null) {
        counts.users_tombstone += 1;
      } else {
        counts.users_orphan += 1;
        if (counts.users_orphan <= MAX_DETAIL_LINES) logger.warn(`${TAG} orphan user id=${userId} (PG only; kept)`);
      }
    }

    // ── a field that drifts again after an applied repair points at a live bypass writer
    if (previous) {
      report.repeats = [...new Set(keys)].filter((k) => previous.repairedKeys.has(k)).sort();
    }
    counts.repeats = report.repeats.length;
    report.repeats.slice(0, MAX_DETAIL_LINES).forEach((k) => {
      logger.error(`${TAG} repeat ${k}: drifted again after last night's applied repair; a writer bypasses the mirror`);
    });

    report.unexplained = counts.pods_orphan + counts.users_orphan + counts.repairs_failed
      + counts.repeats + counts.members_unreadable;

    // ── alerts
    // Page on created_by only for a pod the previous run did not already
    // report; a standing mismatch on report-only nights pages once, not nightly.
    const newCreatedBy = [...new Set(keys)]
      .filter((k) => k.endsWith(':created_by') && !previous?.keys.has(k));
    if (newCreatedBy.length > 0) {
      report.alerts.push(`created_by mismatches=${counts.pods_created_by} (new=${newCreatedBy.length}) `
        + `(${applied ? 'repaired' : 'report-only'})`);
    }
    if (previous) {
      for (const key of COUNT_KEYS) {
        const grew = (counts[key] || 0) - (Number(previous.counts[key]) || 0);
        if (grew > JUMP_THRESHOLD) report.alerts.push(`${key} +${grew} (now ${counts[key]})`);
      }
    }
    if (counts.repeats > 0) report.alerts.push(`repeats=${counts.repeats} (a live writer bypasses the mirror)`);

    await pool.query(
      `UPDATE pg_mirror_repair_runs
          SET finished_at = CURRENT_TIMESTAMP, counts = $2::jsonb, unexplained = $3, mismatch_keys = $4::jsonb,
              repaired_keys = $5::jsonb
        WHERE id = $1`,
      [runId, JSON.stringify(counts), report.unexplained,
        JSON.stringify(selectStoredKeys(keys, MAX_STORED_KEYS)),
        JSON.stringify([...new Set(repaired)].slice(0, MAX_STORED_KEYS))],
    );
  } catch (error) {
    report.error = (error as Error)?.message || String(error);
    report.alerts.push(`run ${runId} failed: ${report.error.slice(0, 200)}`);
    try {
      await pool.query(
        `UPDATE pg_mirror_repair_runs SET finished_at = CURRENT_TIMESTAMP, counts = $2::jsonb, error = $3
          WHERE id = $1`,
        [runId, JSON.stringify(counts), report.error.slice(0, 2000)],
      );
    } catch (recordError) {
      logger.error(`${TAG} could not record the failure of run ${runId}: ${(recordError as Error)?.message}`);
    }
  }

  const nonzero = Object.fromEntries(Object.entries(counts).filter(([, n]) => n > 0));
  logger.info(`${TAG} run=${runId} applied=${applied} unexplained=${report.unexplained} `
    + `counts=${JSON.stringify(nonzero)}${report.error ? ` error=${JSON.stringify(report.error)}` : ''}`);

  if (report.alerts.length) {
    logger.error(`${ALERT_TAG} ${JSON.stringify({
      run: runId, applied, alerts: report.alerts, unexplained: report.unexplained, counts: nonzero,
    })}`);
    try {
      await page(`[pg mirror] run ${runId} (${applied ? 'applied' : 'report-only'}): ${report.alerts.join('; ')}. `
        + `unexplained=${report.unexplained}. Details: backend log tag ${TAG}, table pg_mirror_repair_runs.`);
    } catch (error) {
      logger.warn(`${TAG} SRE page failed; the ${ALERT_TAG} log line stands: ${(error as Error)?.message}`);
    }
  }
  return report;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = {
  runPgMirrorRepair, LOCK_KEYS, JUMP_THRESHOLD, GHOST_FLOOR_RATIO, GHOST_FLOOR_MIN, PAGE_TIMEOUT_MS,
  selectStoredKeys,
};
