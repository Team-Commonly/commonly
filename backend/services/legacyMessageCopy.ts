/**
 * Copies a MongoDB message into PostgreSQL under its Mongo id (TASK-503).
 *
 * PostgreSQL is the only message store once PG_HOST is set, so nothing writes
 * Mongo messages there any more. What remains is history: rows written before
 * an install gained Postgres, and the rows the old fallback wrote while PG was
 * down. The operator script `backfill-local-messages-to-pg` moves them with
 * `copyOne`. This module replaced the TASK-313 background reconciler, which
 * moved only rows flagged `pgFallback` and so never moved the socket-path rows.
 *
 * - Idempotent. The PG insert is ON CONFLICT on legacy_mongo_id, so a second
 *   writer inserts nothing. The Mongo stamp is guarded on `reconciledAt` being
 *   absent, so a second stamp matches nothing.
 * - The Mongo id keeps working. `PGMessage.resolveId` maps it to the PG row,
 *   so replies, thread roots, reactions and deletes that name it still land.
 */
interface CopyClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { pool } = require('../config/db-pg') as {
  pool: {
    connect: () => Promise<CopyClient>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const MongoMessage = require('../models/Message') as {
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ matchedCount?: number; modifiedCount?: number }>;
};

export interface LegacyMessageDoc {
  _id: { toString(): string };
  podId: { toString(): string };
  userId: { toString(): string };
  content: string;
  messageType?: string;
  authorKind?: 'kernel' | null;
  payload?: unknown;
  createdAt: Date;
}

export const LEGACY_ID_INDEX = 'messages_legacy_mongo_id_key';

/**
 * Builds the unique index ON CONFLICT needs, without blocking writes.
 *
 * CONCURRENTLY cannot run inside a transaction, so this issues the statement
 * on its own autocommit connection. A failed concurrent build leaves an
 * INVALID index behind; IF NOT EXISTS would keep that forever, so an invalid
 * one is dropped and rebuilt.
 */
export async function ensureLegacyIdIndex(): Promise<boolean> {
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock(313, 2) AS acquired');
    locked = lock.rows[0]?.acquired === true;
    if (!locked) return false;
    const state = await client.query(
      `SELECT i.indisvalid FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = $1`,
      [LEGACY_ID_INDEX],
    );
    if (state.rows[0]?.indisvalid === false) {
      await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_ID_INDEX}`);
    }
    await client.query(
      `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${LEGACY_ID_INDEX}
         ON messages (legacy_mongo_id)`,
    );
    return true;
  } finally {
    try {
      if (locked) await client.query('SELECT pg_advisory_unlock(313, 2)');
    } finally {
      client.release();
    }
  }
}

export async function copyOne(doc: LegacyMessageDoc): Promise<'moved' | 'present'> {
  const id = doc._id.toString();
  const inserted = await pool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type, created_at, legacy_mongo_id, author_kind, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (legacy_mongo_id) DO NOTHING
     RETURNING id`,
    [
      doc.podId.toString(),
      doc.userId.toString(),
      doc.content || '',
      doc.messageType || 'text',
      doc.createdAt,
      id,
      doc.authorKind === 'kernel' ? 'kernel' : null,
      doc.payload == null ? null : JSON.stringify(doc.payload),
    ],
  );
  let pgId = inserted.rows[0]?.id;
  if (pgId === undefined) {
    const existing = await pool.query(
      'SELECT id FROM messages WHERE legacy_mongo_id = $1',
      [id],
    );
    pgId = existing.rows[0]?.id;
  }
  if (pgId == null || !Number.isSafeInteger(Number(pgId)) || Number(pgId) <= 0) {
    throw new Error('Copied PG row disappeared before stamping');
  }
  // Stamp only after Postgres has the row. A crash between the two leaves an
  // unstamped Mongo row that the next copy turns into `present`, then stamps.
  await MongoMessage.updateOne(
    { _id: doc._id, reconciledAt: { $exists: false } },
    { $set: { reconciledAt: new Date(), reconciledPgId: Number(pgId) } },
  );
  return inserted.rows[0] ? 'moved' : 'present';
}
