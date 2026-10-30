/**
 * backfill-local-messages-to-pg — one-shot, for a self-hosted install that ran
 * chat on MongoDB only and has just gained PostgreSQL (TASK-503).
 *
 * The local profile (docker-compose.local.yml) used to run without Postgres,
 * so every chat message lived in Mongo. Once Postgres is healthy, chat reads
 * Postgres only and never merges the two stores, so that history disappears
 * from the UI. The background reconciler (pgMessageReconcileService) does not
 * help: it moves only rows flagged `pgFallback`, written while PG was down.
 *
 * This copies every not-yet-reconciled Mongo message through the reconciler's
 * own `copyOne`, so it inherits its guarantees: the PG insert is ON CONFLICT
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
 * Exit codes: 0 done, or a dry run that would proceed; 1 some rows failed;
 * 2 refused (a dry run that finds the overlap refuses too, so it also exits 2).
 */
/* eslint-disable no-console, no-await-in-loop */

import mongoose from 'mongoose';
import { copyOne, ensureLegacyIdIndex } from '../services/pgMessageReconcileService';

type CopyResult = 'moved' | 'present';

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
  failed: number;
}

export async function backfillLocalMessages(
  deps: LocalBackfillDeps,
  { apply = false, force = false, batchSize = 500 }: { apply?: boolean; force?: boolean; batchSize?: number } = {},
): Promise<LocalBackfillReport> {
  const pending = await deps.countPending();
  const newest = pending ? await deps.newestPendingAt() : null;
  const overlap = newest ? await deps.countOverlap(newest) : 0;
  const report: LocalBackfillReport = {
    dryRun: !apply, pending, overlap, refused: overlap > 0 && !force, moved: 0, alreadyPresent: 0, failed: 0,
  };
  if (!apply || report.refused || !pending) return report;

  let afterId: string | null = null;
  for (;;) {
    const batch = await deps.nextBatch(afterId, batchSize);
    if (!batch.length) break;
    for (const doc of batch) {
      try {
        if (await deps.copy(doc) === 'moved') report.moved += 1;
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

interface PgPool {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
}

export interface BackfillScope { since?: Date }

export const productionDeps = (pool: PgPool, { since }: BackfillScope = {}): LocalBackfillDeps => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Message = require('../models/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { syncPodFromMongo } = require('../services/pgPodSyncService');
  const unreconciled = since
    ? { reconciledAt: { $exists: false }, createdAt: { $gte: since } }
    : { reconciledAt: { $exists: false } };
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
    nextBatch: (afterId, limit) => Message.find(afterId
      ? { ...unreconciled, _id: { $gt: new mongoose.Types.ObjectId(afterId) } }
      : unreconciled).sort({ _id: 1 }).limit(limit).lean(),
    // Same pod fallback as the reconciler: a Mongo-only pod is mirrored, then retried.
    copy: (doc) => copyOne(doc).catch(async (err: { code?: string }) => {
      if (err.code !== '23503') throw err;
      await syncPodFromMongo(doc.podId.toString(), doc.userId.toString());
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

export interface OpenedStores { deps: LocalBackfillDeps; close: () => Promise<void> }

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

export interface BackfillArgs { apply: boolean; force: boolean; since?: Date }

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
  const args: BackfillArgs = { apply: false, force: false };
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
    else if (arg === '--since') {
      setSince(rest[i + 1]);
      i += 1;
    } else if (arg.startsWith('--since=')) setSince(arg.slice('--since='.length));
    else throw new Error(`unknown argument ${JSON.stringify(arg)}; expected --apply, --force, --since <ISO date>`);
  }
  return args;
};

/** Runs the backfill, sets process.exitCode (see exitCodeFor) and returns it. */
export async function main(
  argv: string[] = process.argv,
  open: (scope: BackfillScope) => Promise<OpenedStores> = openStores,
): Promise<number> {
  const { apply, force, since } = parseArgs(argv);
  const { deps, close } = await open({ since });
  try {
    const report = await backfillLocalMessages(deps, { apply, force });
    console.log(`[backfill-local-messages] ${JSON.stringify({ ...report, since: since?.toISOString() ?? null })}`);
    if (report.refused) {
      console.log(`REFUSED — PostgreSQL already holds ${report.overlap} messages with no Mongo id`
        + ' that predate the newest Mongo message. They may be the same history; copying would duplicate it.'
        + ' Re-run with --force only if you have checked.');
    } else if (!apply) {
      console.log('DRY RUN — nothing written. Re-run with --apply.');
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
