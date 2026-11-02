/**
 * backfill-local-messages-to-pg — one-shot, for a self-hosted install that ran
 * chat on MongoDB only and has just gained PostgreSQL (TASK-503).
 *
 * The local profile (docker-compose.local.yml) used to run without Postgres,
 * so every chat message lived in Mongo. Once Postgres is healthy, chat reads
 * Postgres only and never merges the two stores, so that history disappears
 * from the UI. Nothing else moves it: the TASK-313 background reconciler is
 * gone, and it only ever moved rows flagged `pgFallback`.
 *
 * This copies every not-yet-reconciled Mongo message through `copyOne`
 * (services/legacyMessageCopy), so it inherits its guarantees: the PG insert is ON CONFLICT
 * on `legacy_mongo_id` and the Mongo row is stamped `reconciledAt` afterwards,
 * so a rerun or a crash mid-run inserts nothing twice.
 *
 * REFUSES on overlapping history. A deployment whose PG already holds messages
 * that never came from this Mongo (no `legacy_mongo_id`) and that predate the
 * newest Mongo row may have the same messages in both stores, copied by an
 * older migration that did not record the Mongo id. Copying again would
 * duplicate them. That is not the local-upgrade case, so it stops and says why;
 * `--force` is for an operator who has checked.
 *
 * Dry run by default; `--apply` writes. Replies keep their text but not their
 * reply edge, same as the reconciler.
 *
 * `--since <ISO date>` (or `--since=<ISO date>`) copies only Mongo rows created
 * at or after that time; any other argument throws, so a typo cannot widen it.
 * It is for a deployment that already moved its history into PG and has a
 * bounded tail of Mongo-only rows left (TASK-503, hosted: socket sends during
 * PG boot were written to Mongo without the `pgFallback` flag, so the
 * reconciler never moves them). The overlap check still runs on that tail; a
 * live deployment has unmarked PG rows in any window, so it needs `--force`
 * after the dry run shows the expected count.
 *
 *   npm run backfill:local-messages            # report only
 *   npm run backfill:local-messages -- --apply
 *   npm run backfill:local-messages -- --since 2026-09-30T00:00:00Z --apply --force
 *
 * A row whose pod is in neither store is an orphan: its pod was deleted, so
 * there is nothing to mirror into PG and the FK on `pods` refuses the copy.
 * Those rows are skipped, left untouched in Mongo and counted as `orphaned`;
 * they never fail the run. `orphanedPending` reports how many of the pending
 * rows are orphans before anything is written, dry run included.
 *
 * A row older than the message retention window, in a pod the Pro tier does
 * not protect, is not copied: the nightly retention run (pgRetentionService)
 * would delete it on arrival. It stays in Mongo, counted as `expiredPending`
 * in the report and `expired` when an `--apply` run passes it. `toCopy` is
 * what is left once orphans and expired rows are set aside, so a report-only
 * run showing `toCopy: 0` means the instance has nothing more to copy
 * (ADR-034 D6).
 *
 * `--verify` copies nothing. It compares the rows this script copied, per pod:
 * the Mongo rows stamped `reconciledAt` against the PG rows carrying their
 * `legacy_mongo_id`, by count and by a checksum over the copied fields. Rows
 * past retention are left out on both sides. Run it after `--apply`, on
 * staging before production; it exits 1 when any pod differs.
 *
 * Exit codes: 0 done, or a dry run that would proceed, or a clean verify;
 * 1 some rows failed, or a verify found a difference; 2 refused (a dry run
 * that finds the overlap refuses too, so it also exits 2).
 */
/* eslint-disable no-console, no-await-in-loop */

import { createHash } from 'crypto';
import mongoose from 'mongoose';
import { copyOne, ensureLegacyIdIndex } from '../services/legacyMessageCopy';

type CopyResult = 'moved' | 'present' | 'orphaned';

export interface PendingDoc {
  _id: { toString(): string };
  podId: { toString(): string };
  userId: { toString(): string };
  content: string;
  createdAt: Date;
}

export interface LocalBackfillDeps {
  countPending: () => Promise<number>;
  newestPendingAt: () => Promise<Date | null>;
  /** PG rows with no legacy_mongo_id written at or before `at`. */
  countOverlap: (at: Date) => Promise<number>;
  /** Pending rows whose pod exists in neither MongoDB nor PG `pods`. */
  countOrphaned: () => Promise<number>;
  /** Pending rows, in pods that still exist, that retention would delete on arrival. */
  countExpired: () => Promise<number>;
  /** Whether retention would delete this row on arrival (its pod still exists). */
  isExpired: (doc: PendingDoc) => Promise<boolean>;
  /** The next pending docs after `afterId`, oldest id first. */
  nextBatch: (afterId: string | null, limit: number) => Promise<PendingDoc[]>;
  copy: (doc: PendingDoc) => Promise<CopyResult>;
}

export interface LocalBackfillReport {
  dryRun: boolean;
  pending: number;
  overlap: number;
  refused: boolean;
  moved: number;
  alreadyPresent: number;
  /** Pending rows whose pod is gone, counted before any write. */
  orphanedPending: number;
  /** Pending rows past retention, counted before any write. */
  expiredPending: number;
  /** Pending rows that are neither orphaned nor past retention. */
  toCopy: number;
  /** Rows this run skipped because their pod is gone. */
  orphaned: number;
  /** Rows this run skipped because they are past retention. */
  expired: number;
  failed: number;
}

export async function backfillLocalMessages(
  deps: LocalBackfillDeps,
  { apply = false, force = false, batchSize = 500 }: { apply?: boolean; force?: boolean; batchSize?: number } = {},
): Promise<LocalBackfillReport> {
  const pending = await deps.countPending();
  const newest = pending ? await deps.newestPendingAt() : null;
  const overlap = newest ? await deps.countOverlap(newest) : 0;
  const orphanedPending = pending ? await deps.countOrphaned() : 0;
  const expiredPending = pending ? await deps.countExpired() : 0;
  const report: LocalBackfillReport = {
    dryRun: !apply,
    pending,
    overlap,
    refused: overlap > 0 && !force,
    moved: 0,
    alreadyPresent: 0,
    orphanedPending,
    expiredPending,
    toCopy: Math.max(0, pending - orphanedPending - expiredPending),
    orphaned: 0,
    expired: 0,
    failed: 0,
  };
  if (!apply || report.refused || !pending) return report;

  let afterId: string | null = null;
  for (;;) {
    const batch = await deps.nextBatch(afterId, batchSize);
    if (!batch.length) break;
    for (const doc of batch) {
      try {
        if (await deps.isExpired(doc)) {
          report.expired += 1;
          continue;
        }
        const result = await deps.copy(doc);
        if (result === 'moved') report.moved += 1;
        else if (result === 'orphaned') report.orphaned += 1;
        else report.alreadyPresent += 1;
      } catch (err) {
        report.failed += 1;
        console.warn('[backfill-local-messages] row not copied:', doc._id.toString(), (err as Error).message);
      }
    }
    afterId = batch[batch.length - 1]._id.toString();
  }
  return report;
}

/** The fields a copy carries, read from either store. */
export interface CopiedRow {
  legacyId: string;
  podId: string;
  userId: string;
  content: string;
  messageType: string;
  createdAt: Date;
  /** 'kernel' or null, as `copyOne` writes `author_kind`. */
  authorKind: string | null;
  payload: unknown;
}

export interface PodDigest { count: number; hash: string }

export interface VerifyDeps {
  /** Per pod: the Mongo rows stamped as copied, past-retention rows left out. */
  copiedInMongo: () => Promise<Map<string, PodDigest>>;
  /** Per pod: the PG rows carrying a Mongo id, past-retention rows left out. */
  copiedInPg: () => Promise<Map<string, PodDigest>>;
}

// A payload as JSON with its keys sorted. Postgres jsonb returns keys in its own
// order and dates as strings, so the same payload read from Mongo and from PG
// only compares equal after this.
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().map((key) => [key, canonicalJson(obj[key])]));
  }
  return value;
};
const canonicalPayload = (payload: unknown): unknown => (payload == null
  ? null
  : canonicalJson(JSON.parse(JSON.stringify(payload))));

export const rowDigest = (row: CopiedRow): string => createHash('sha256')
  .update(JSON.stringify([
    row.legacyId, row.podId, row.userId, row.content, row.messageType, row.createdAt.getTime(),
    row.authorKind ?? null, canonicalPayload(row.payload),
  ]))
  .digest('hex');

// XOR, so the order the rows are read in cannot matter. Two equal rows would
// cancel, but a row's digest includes its Mongo id, which is unique in both
// stores (the PG column has a unique index), so no two rows are equal.
export const foldDigests = (digests: string[]): string => {
  const acc = Buffer.alloc(32);
  digests.forEach((hex) => {
    const bytes = Buffer.from(hex, 'hex');
    // eslint-disable-next-line no-bitwise -- XOR is the fold
    for (let i = 0; i < acc.length; i += 1) acc[i] ^= bytes[i];
  });
  return acc.toString('hex');
};

/** Folds rows into per-pod counts and checksums. */
export const digestByPod = (rows: Iterable<CopiedRow>): Map<string, PodDigest> => {
  const byPod = new Map<string, string[]>();
  for (const row of rows) {
    const list = byPod.get(row.podId) || [];
    list.push(rowDigest(row));
    byPod.set(row.podId, list);
  }
  return new Map([...byPod].map(([pod, list]) => [pod, { count: list.length, hash: foldDigests(list) }]));
};

export interface VerifyReport { pods: number; mongoRows: number; pgRows: number; differing: string[] }

export async function verifyCopied(deps: VerifyDeps): Promise<VerifyReport> {
  const [mongo, pg] = [await deps.copiedInMongo(), await deps.copiedInPg()];
  const pods = new Set([...mongo.keys(), ...pg.keys()]);
  const sum = (digests: Map<string, PodDigest>) => [...digests.values()].reduce((n, d) => n + d.count, 0);
  return {
    pods: pods.size,
    mongoRows: sum(mongo),
    pgRows: sum(pg),
    differing: [...pods].filter((pod) => {
      const a = mongo.get(pod);
      const b = pg.get(pod);
      return !a || !b || a.count !== b.count || a.hash !== b.hash;
    }),
  };
}

interface PgPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
}

export interface BackfillScope { since?: Date }

export const productionDeps = (
  pool: PgPool,
  { since }: BackfillScope = {},
): LocalBackfillDeps & VerifyDeps => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Message = require('../models/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { syncPodFromMongo } = require('../services/pgPodSyncService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const MongoPod = require('../models/Pod');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const retention = require('../services/pgRetentionService');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const PGMessage = require('../models/pg/Message');
  const unreconciled = since
    ? { reconciledAt: { $exists: false }, createdAt: { $gte: since } }
    : { reconciledAt: { $exists: false } };
  // Read once per run. Pending rows in pods that exist in neither store.
  let gonePods: Promise<Array<{ toString(): string }>> | null = null;
  const pendingGonePods = () => {
    gonePods ??= (async () => {
      const podIds: Array<{ toString(): string }> = await Message.distinct('podId', unreconciled);
      if (!podIds.length) return [];
      const inMongo: Array<{ toString(): string }> = await MongoPod.find({ _id: { $in: podIds } }).distinct('_id');
      const { rows } = await pool.query('SELECT id FROM pods WHERE id = ANY($1)', [podIds.map(String)]);
      const live = new Set([...inMongo.map(String), ...rows.map((r) => String(r.id))]);
      return podIds.filter((id) => !live.has(String(id)));
    })();
    return gonePods;
  };
  // The retention delete's own rule (PGMessage.deleteOlderThan): older than
  // PG_MESSAGE_RETENTION_DAYS in whole days by the Postgres clock, in a pod
  // neither the Pro tier nor PG_RETENTION_EXEMPT_POD_IDS protects. No valid
  // window means nothing expires, as the run then skips. A protected-pod lookup
  // that fails throws, so the backfill stops rather than skipping rows a paying
  // pod should keep.
  let rule: Promise<{ cutoff: Date | null; protectedPods: Set<string> }> | null = null;
  const expiryRule = () => {
    rule ??= (async () => {
      const days = retention.resolveRetentionDays();
      if (!Number.isFinite(days) || days <= 0) return { cutoff: null, protectedPods: new Set<string>() };
      const protectedPods = new Set<string>([
        ...PGMessage.retentionExemptPodIds(),
        ...(await retention.resolveProtectedPodIds()).map(String),
      ]);
      const { rows } = await pool.query('SELECT NOW() - $1::interval AS cutoff', [`${Math.trunc(days)} days`]);
      return { cutoff: new Date(rows[0].cutoff as Date), protectedPods };
    })();
    return rule;
  };
  const pastRetention = async (podId: string, createdAt: Date) => {
    const { cutoff, protectedPods } = await expiryRule();
    return Boolean(cutoff && new Date(createdAt) < cutoff && !protectedPods.has(podId));
  };
  return {
    countPending: () => Message.countDocuments(unreconciled),
    newestPendingAt: async () => {
      const doc = await Message.findOne(unreconciled).sort({ createdAt: -1 }).select('createdAt').lean();
      return doc?.createdAt || null;
    },
    countOverlap: async (at) => {
      const { rows } = await pool.query(
        'SELECT count(*)::int AS n FROM messages WHERE legacy_mongo_id IS NULL AND created_at <= $1',
        [at],
      );
      return Number(rows[0]?.n || 0);
    },
    // An orphan's pod is in neither store: a pod already in PG copies without
    // a mirror, and a Mongo-only pod gets mirrored, so only the rest fail the FK.
    countOrphaned: async () => {
      const gone = await pendingGonePods();
      return gone.length ? Message.countDocuments({ ...unreconciled, podId: { $in: gone } }) : 0;
    },
    countExpired: async () => {
      const { cutoff, protectedPods } = await expiryRule();
      if (!cutoff) return 0;
      const kept = [...protectedPods].filter((id) => mongoose.Types.ObjectId.isValid(id))
        .map((id) => new mongoose.Types.ObjectId(id));
      const skipped = [...kept, ...await pendingGonePods()];
      return Message.countDocuments({
        $and: [unreconciled, { createdAt: { $lt: cutoff } }, { podId: { $nin: skipped } }],
      });
    },
    // A row in a gone pod goes on to copy(), which counts it as orphaned.
    isExpired: async (doc) => {
      const podId = doc.podId.toString();
      if ((await pendingGonePods()).some((id) => String(id) === podId)) return false;
      return pastRetention(podId, doc.createdAt);
    },
    copiedInMongo: async () => {
      const rows: CopiedRow[] = [];
      const cursor = Message.find({ reconciledAt: { $exists: true } })
        .select('podId userId content messageType createdAt authorKind payload').lean().cursor();
      for await (const doc of cursor) {
        const podId = String(doc.podId);
        if (!await pastRetention(podId, doc.createdAt)) {
          rows.push({
            legacyId: String(doc._id),
            podId,
            userId: String(doc.userId),
            content: doc.content || '',
            messageType: doc.messageType || 'text',
            createdAt: new Date(doc.createdAt),
            authorKind: doc.authorKind === 'kernel' ? 'kernel' : null,
            payload: doc.payload,
          });
        }
      }
      return digestByPod(rows);
    },
    copiedInPg: async () => {
      const { rows } = await pool.query(`SELECT legacy_mongo_id, pod_id, user_id, content, message_type, created_at,
        author_kind, payload FROM messages WHERE legacy_mongo_id IS NOT NULL`);
      const kept: CopiedRow[] = [];
      for (const row of rows) {
        const podId = String(row.pod_id);
        if (!await pastRetention(podId, row.created_at as Date)) {
          kept.push({
            legacyId: String(row.legacy_mongo_id),
            podId,
            userId: String(row.user_id),
            content: String(row.content ?? ''),
            messageType: String(row.message_type || 'text'),
            createdAt: new Date(row.created_at as Date),
            authorKind: row.author_kind == null ? null : String(row.author_kind),
            payload: row.payload,
          });
        }
      }
      return digestByPod(kept);
    },
    nextBatch: (afterId, limit) => Message.find(afterId
      ? { ...unreconciled, _id: { $gt: new mongoose.Types.ObjectId(afterId) } }
      : unreconciled).sort({ _id: 1 }).limit(limit).lean(),
    // Same pod fallback as the reconciler: a Mongo-only pod is mirrored, then
    // retried. syncPodFromMongo returns null when the pod is gone from Mongo
    // too; retrying would hit the same FK, so the row is an orphan.
    copy: (doc) => copyOne(doc).catch(async (err: { code?: string }) => {
      if (err.code !== '23503') throw err;
      const pod = await syncPodFromMongo(doc.podId.toString(), doc.userId.toString());
      if (!pod) return 'orphaned' as const;
      return copyOne(doc);
    }),
  };
};

/**
 * The process exit code for a finished run: 1 when rows failed, 2 when the run
 * refused, so an upgrade script that runs this stops instead of carrying on
 * without history; 0 otherwise (including a dry run).
 */
export const exitCodeFor = (report: Pick<LocalBackfillReport, 'refused' | 'failed'>): number => {
  if (report.failed) return 1;
  if (report.refused) return 2;
  return 0;
};

export interface OpenedStores { deps: LocalBackfillDeps & VerifyDeps; close: () => Promise<void> }

/** Connects both stores for a real run. main() takes it as a parameter so a test can swap it. */
export const openStores = async (scope: BackfillScope = {}): Promise<OpenedStores> => {
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  if (!pool) throw new Error('PostgreSQL is not configured (PG_HOST unset)');
  await mongoose.connect(process.env.MONGO_URI);
  const close = async () => { await mongoose.disconnect(); await pool.end(); };
  try {
    if (!await ensureLegacyIdIndex()) throw new Error('could not ensure the legacy_mongo_id index');
  } catch (err) {
    await close();
    throw err;
  }
  return { deps: productionDeps(pool, scope), close };
};

export interface BackfillArgs { apply: boolean; force: boolean; verify: boolean; since?: Date }

const toSince = (raw: string | undefined): Date => {
  const since = raw ? new Date(raw) : null;
  if (!since || Number.isNaN(since.getTime())) {
    throw new Error(`--since needs an ISO date, got ${raw === undefined ? 'nothing' : JSON.stringify(raw)}`);
  }
  return since;
};

/**
 * Reads the flags after `node script`. `--since` takes its date as the next
 * argument or after `=`. Any other argument throws: a misspelt or misread
 * bound would otherwise run unbounded, and with `--apply --force` that copies
 * the whole pre-PG history again.
 */
export const parseArgs = (argv: string[]): BackfillArgs => {
  const args: BackfillArgs = { apply: false, force: false, verify: false };
  let sinceSeen = false;
  const setSince = (raw: string | undefined) => {
    if (sinceSeen) throw new Error('--since given more than once');
    sinceSeen = true;
    args.since = toSince(raw);
  };
  const rest = argv.slice(2);
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--verify') args.verify = true;
    else if (arg === '--since') {
      setSince(rest[i + 1]);
      i += 1;
    } else if (arg.startsWith('--since=')) setSince(arg.slice('--since='.length));
    else {
      const expected = '--apply, --force, --since <ISO date>, --verify';
      throw new Error(`unknown argument ${JSON.stringify(arg)}; expected ${expected}`);
    }
  }
  // A verify reads every copied row in both stores and writes nothing.
  if (args.verify && (args.apply || args.force || sinceSeen)) throw new Error('--verify runs alone');
  return args;
};

/** Runs the backfill, sets process.exitCode (see exitCodeFor) and returns it. */
export async function main(
  argv: string[] = process.argv,
  open: (scope: BackfillScope) => Promise<OpenedStores> = openStores,
): Promise<number> {
  const { apply, force, verify, since } = parseArgs(argv);
  const { deps, close } = await open({ since });
  try {
    if (verify) {
      const result = await verifyCopied(deps);
      const shown = { ...result, differing: result.differing.slice(0, 20) };
      console.log(`[backfill-local-messages] verify ${JSON.stringify(shown)}`);
      if (result.differing.length) {
        console.log(`${result.differing.length} pod(s) differ between MongoDB and PostgreSQL in count or checksum.`);
      }
      process.exitCode = result.differing.length ? 1 : 0;
      return process.exitCode;
    }
    const report = await backfillLocalMessages(deps, { apply, force });
    console.log(`[backfill-local-messages] ${JSON.stringify({ ...report, since: since?.toISOString() ?? null })}`);
    if (report.refused) {
      console.log(`REFUSED — PostgreSQL already holds ${report.overlap} messages with no Mongo id`
        + ' that predate the newest Mongo message. They may be the same history; copying would duplicate it.'
        + ' Re-run with --force only if you have checked.');
    } else if (!apply) {
      console.log('DRY RUN — nothing written. Re-run with --apply.');
    }
    if (report.expiredPending) {
      console.log(`${report.expiredPending} pending message(s) are past the retention window in pods it applies to;`
        + ' retention would delete them on arrival, so they are skipped and left in MongoDB.');
    }
    if (report.orphanedPending) {
      console.log(`${report.orphanedPending} pending message(s) belong to pods that exist in neither MongoDB nor PG;`
        + ' they are skipped and left in MongoDB.');
    }
    process.exitCode = exitCodeFor(report);
    return process.exitCode;
  } finally {
    await close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('local message backfill failed:', error);
    process.exit(1);
  });
}
