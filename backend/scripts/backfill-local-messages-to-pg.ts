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
 *   npm run backfill:local-messages            # report only
 *   npm run backfill:local-messages -- --apply
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

const productionDeps = (pool: PgPool): LocalBackfillDeps => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const Message = require('../models/Message');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { syncPodFromMongo } = require('../services/pgPodSyncService');
  const unreconciled = { reconciledAt: { $exists: false } };
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

export async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const force = process.argv.includes('--force');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };
  if (!pool) throw new Error('PostgreSQL is not configured (PG_HOST unset)');

  await mongoose.connect(process.env.MONGO_URI);
  try {
    if (!await ensureLegacyIdIndex()) throw new Error('could not ensure the legacy_mongo_id index');
    const report = await backfillLocalMessages(productionDeps(pool), { apply, force });
    console.log(`[backfill-local-messages] ${JSON.stringify(report)}`);
    if (report.refused) {
      console.log(`REFUSED — PostgreSQL already holds ${report.overlap} messages with no Mongo id`
        + ' that predate the newest Mongo message. They may be the same history; copying would duplicate it.'
        + ' Re-run with --force only if you have checked.');
    } else if (!apply) {
      console.log('DRY RUN — nothing written. Re-run with --apply.');
    }
    if (report.failed) process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('local message backfill failed:', error);
    process.exit(1);
  });
}
