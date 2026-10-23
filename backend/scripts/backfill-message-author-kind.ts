/**
 * Mark historical stalled-connect nudges as Commonly-authored seat posts.
 *
 * The episode keeps the message id, while the message may live in PostgreSQL
 * or in MongoDB when the availability fallback was used. The default is a dry
 * run; write only with `npm run backfill:message-author-kind -- --apply`.
 * Both stores are updated by message id and a retry is idempotent.
 */
/* eslint-disable no-console */

import mongoose from 'mongoose';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const StalledConnectEpisode = require('../models/StalledConnectEpisode');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Message = require('../models/Message');

interface PgPool {
  query: (sql: string, values?: unknown[]) => Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number;
  }>;
  end: () => Promise<void>;
}

interface PgMessageRow {
  id: string | number;
  author_kind?: unknown;
}

interface MongoMessageRow {
  _id: unknown;
  authorKind?: unknown;
}

export interface MessageAuthorKindBackfillReport {
  dryRun: boolean;
  episodeReferences: number;
  uniqueMessageReferences: number;
  postgresReferences: number;
  mongoReferences: number;
  invalidReferences: number;
  missingReferences: number;
  postgresRows: number;
  mongoRows: number;
  alreadyKernel: number;
  toBackfill: number;
  appliedPostgres: number;
  appliedMongo: number;
}

export interface MessageAuthorKindBackfillDeps {
  getEpisodeReferences: () => Promise<string[]>;
  getPostgresRows: (ids: string[]) => Promise<PgMessageRow[]>;
  getMongoRows: (ids: string[]) => Promise<MongoMessageRow[]>;
  updatePostgresRows: (ids: string[]) => Promise<number>;
  updateMongoRows: (ids: string[]) => Promise<number>;
}

const classifyReferences = (references: string[]) => {
  const unique = [...new Set(references.map((reference) => String(reference).trim()).filter(Boolean))];
  const postgres = unique.filter((id) => /^\d+$/.test(id));
  const mongo = unique.filter((id) => mongoose.Types.ObjectId.isValid(id));
  const known = new Set([...postgres, ...mongo]);
  return {
    unique,
    postgres,
    mongo,
    invalid: unique.filter((id) => !known.has(id)),
  };
};

export async function backfillMessageAuthorKind(
  deps: MessageAuthorKindBackfillDeps,
  options: { apply?: boolean } = {},
): Promise<MessageAuthorKindBackfillReport> {
  const references = await deps.getEpisodeReferences();
  const classified = classifyReferences(references);
  const [postgresRows, mongoRows] = await Promise.all([
    deps.getPostgresRows(classified.postgres),
    deps.getMongoRows(classified.mongo),
  ]);

  const postgresToBackfill = postgresRows
    .filter((row) => row.author_kind !== 'kernel')
    .map((row) => String(row.id));
  const mongoToBackfill = mongoRows
    .filter((row) => row.authorKind !== 'kernel')
    .map((row) => String(row._id));
  const matched = new Set([
    ...postgresRows.map((row) => String(row.id)),
    ...mongoRows.map((row) => String(row._id)),
  ]);

  const report: MessageAuthorKindBackfillReport = {
    dryRun: options.apply !== true,
    episodeReferences: references.filter((reference) => String(reference).trim()).length,
    uniqueMessageReferences: classified.unique.length,
    postgresReferences: classified.postgres.length,
    mongoReferences: classified.mongo.length,
    invalidReferences: classified.invalid.length,
    missingReferences: classified.unique.filter((id) => !matched.has(id)).length,
    postgresRows: postgresRows.length,
    mongoRows: mongoRows.length,
    alreadyKernel: postgresRows.length - postgresToBackfill.length
      + mongoRows.length - mongoToBackfill.length,
    toBackfill: postgresToBackfill.length + mongoToBackfill.length,
    appliedPostgres: 0,
    appliedMongo: 0,
  };

  if (options.apply !== true) return report;

  report.appliedPostgres = await deps.updatePostgresRows(postgresToBackfill);
  report.appliedMongo = await deps.updateMongoRows(mongoToBackfill);
  return report;
}

const productionDeps = (pool: PgPool | null): MessageAuthorKindBackfillDeps => ({
  getEpisodeReferences: async () => {
    const rows = await StalledConnectEpisode.find({
      nudgeMessageId: { $type: 'string', $ne: '' },
    }).select('nudgeMessageId').lean();
    return rows.map((row: { nudgeMessageId?: unknown }) => String(row.nudgeMessageId || ''));
  },
  getPostgresRows: async (ids) => {
    if (!pool || ids.length === 0) return [];
    const result = await pool.query(
      'SELECT id, author_kind FROM messages WHERE id = ANY($1::int[])',
      [ids.map(Number)],
    );
    return result.rows as unknown as PgMessageRow[];
  },
  getMongoRows: async (ids) => {
    if (ids.length === 0) return [];
    const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
    return Message.find({ _id: { $in: objectIds } })
      .select('_id authorKind').lean() as Promise<MongoMessageRow[]>;
  },
  updatePostgresRows: async (ids) => {
    if (!pool || ids.length === 0) return 0;
    const result = await pool.query(
      "UPDATE messages SET author_kind = 'kernel' WHERE id = ANY($1::int[]) AND author_kind IS DISTINCT FROM 'kernel'",
      [ids.map(Number)],
    );
    return result.rowCount || 0;
  },
  updateMongoRows: async (ids) => {
    if (ids.length === 0) return 0;
    const result = await Message.updateMany(
      {
        _id: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) },
        authorKind: { $ne: 'kernel' },
      },
      { $set: { authorKind: 'kernel' } },
    );
    return result.modifiedCount || 0;
  },
});

export async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  if (!process.env.MONGO_URI) throw new Error('MONGO_URI is required');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { pool } = require('../config/db-pg') as { pool: PgPool | null };

  await mongoose.connect(process.env.MONGO_URI);
  try {
    const report = await backfillMessageAuthorKind(productionDeps(pool), { apply });
    console.log(`[backfill-message-author-kind] ${JSON.stringify(report)}`);
    if (!apply) {
      console.log('DRY RUN — no message rows written. Re-run with --apply after deploy.');
    }
  } finally {
    await mongoose.disconnect();
    if (pool) await pool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('message author-kind backfill failed:', error);
    process.exit(1);
  });
}
