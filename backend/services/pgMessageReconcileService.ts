/**
 * TASK-313 part 2 — moves Mongo fallback messages into PostgreSQL.
 *
 * While Postgres is down, createMessage writes non-replies to Mongo. Once it
 * is healthy this pass copies each unmoved row into `messages`, stamping the
 * Mongo row with the PG id it became. Three properties carry the design:
 *
 * - Idempotent across replicas. The PG insert is ON CONFLICT on
 *   legacy_mongo_id, so a second writer inserts nothing. The Mongo stamp is
 *   guarded on `reconciledAt` being absent, so a second stamp matches nothing.
 * - Bounded. One pass reads at most `maxPerPass` rows, unattempted rows first, then the oldest deferred attempts.
 * - Malformed rows are permanently refused. Recoverable failures (including
 *   missing PG pods) are deferred so later rows can progress, then retried.
 *
 * Reads never merge the two stores: chat reads Postgres when it is healthy and
 * Mongo only when it is not. A reconciled Mongo row therefore cannot be
 * returned alongside its PG copy in one response.
 */
interface ReconcileClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { pool } = require('../config/db-pg') as {
  pool: {
    connect: () => Promise<ReconcileClient>;
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { syncPodFromMongo } = require('./pgPodSyncService') as {
  syncPodFromMongo: (podId: string, requestingUserId: string) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const MongoMessage = require('../models/Message') as {
  find: (q: Record<string, unknown>) => {
    sort: (s: Record<string, number>) => {
      limit: (n: number) => { lean: () => Promise<MongoFallbackDoc[]> };
    };
  };
  updateOne: (
    filter: Record<string, unknown>,
    update: Record<string, unknown>,
  ) => Promise<{ matchedCount?: number; modifiedCount?: number }>;
};

interface MongoFallbackDoc {
  _id: { toString(): string };
  podId: { toString(): string };
  userId: { toString(): string };
  content: string;
  messageType?: string;
  authorKind?: 'kernel' | null;
  payload?: unknown;
  createdAt: Date;
}

export interface ReconcilePassResult {
  /** False when Postgres did not answer; the pass did nothing. */
  healthy: boolean;
  /** Rows this pass inserted into Postgres. */
  moved: number;
  /** Rows Postgres already had (a concurrent pass or an earlier crash). */
  alreadyPresent: number;
  /** Rows that failed this pass; permanent refusals are also stamped. */
  skipped: number;
}

export const LEGACY_ID_INDEX = 'messages_legacy_mongo_id_key';
export const DEFAULT_MAX_PER_PASS = 200;

// FK failures can recover after pod synchronization; retry after a backoff.
export const RETRY_DELAY_MS = 60_000;
const isPermanentRowError = (err: unknown): boolean => {
  const code = (err as { code?: string }).code;
  return err instanceof TypeError || Boolean(code && code !== '23503' && /^(22|23)/.test(code));
};

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

export async function copyOne(doc: MongoFallbackDoc): Promise<'moved' | 'present'> {
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
    throw new Error('Reconciled PG row disappeared before stamping');
  }
  // Stamp only after Postgres has the row. A crash between the two leaves an
  // unstamped Mongo row that the next pass turns into `present`, then stamps.
  await MongoMessage.updateOne(
    { _id: doc._id, reconciledAt: { $exists: false } },
    { $set: { reconciledAt: new Date(), reconciledPgId: Number(pgId) } },
  );
  return inserted.rows[0] ? 'moved' : 'present';
}

export async function reconcileMongoFallbackMessages(
  { maxPerPass = DEFAULT_MAX_PER_PASS }: { maxPerPass?: number } = {},
): Promise<ReconcilePassResult> {
  const result: ReconcilePassResult = {
    healthy: false, moved: 0, alreadyPresent: 0, skipped: 0,
  };
  try {
    await pool.query('SELECT 1');
  } catch {
    return result;
  }
  result.healthy = true;

  if (!await ensureLegacyIdIndex()) return result;

  const batch = await MongoMessage.find({
    reconciledAt: { $exists: false },
    reconcileFailedAt: { $exists: false },
    $or: [{ reconcileRetryAt: { $exists: false } }, { reconcileRetryAt: { $lte: new Date() } }],
  })
    .sort({ reconcileRetryAt: 1, createdAt: 1, _id: 1 })
    .limit(Math.max(1, Math.trunc(maxPerPass)))
    .lean();

  for (const doc of batch) {
    try {
      const outcome = await copyOne(doc).catch(async (err: { code?: string }) => {
        if (err.code !== '23503') throw err;
        // A Mongo-only pod can be mirrored once PG returns. Keep failures
        // retryable; even a missing Mongo pod may be restored later.
        try {
          await syncPodFromMongo(doc.podId.toString(), doc.userId.toString());
        } catch {
          throw err;
        }
        return copyOne(doc);
      });
      if (outcome === 'moved') result.moved += 1;
      else result.alreadyPresent += 1;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      result.skipped += 1;
      if (isPermanentRowError(err)) {
        await MongoMessage.updateOne(
          { _id: doc._id, reconcileFailedAt: { $exists: false } },
          { $set: { reconcileFailedAt: new Date(), reconcileError: e.message || e.code } },
        );
      }
      else {
        await MongoMessage.updateOne(
          { _id: doc._id, reconciledAt: { $exists: false } },
          { $set: { reconcileRetryAt: new Date(Date.now() + RETRY_DELAY_MS) } },
        );
      }
      console.warn('[pgMessageReconcile] row not moved:', doc._id.toString(), e.message);
    }
  }
  return result;
}

export default { reconcileMongoFallbackMessages, ensureLegacyIdIndex };

// One pass a minute per process. Replicas may each run one: the database
// (ON CONFLICT) and the Mongo stamp (set-once) make overlapping passes harmless.
// The in-process flag only keeps a slow pass from piling up behind itself.
let timer: ReturnType<typeof setInterval> | null = null;
let passInFlight = false;

export function initPgMessageReconcile(intervalMs = 60_000): void {
  if (timer) return;
  timer = setInterval(() => {
    if (passInFlight) return;
    passInFlight = true;
    reconcileMongoFallbackMessages()
      .then((r) => {
        if (r.moved || r.skipped) {
          console.log(`[pgMessageReconcile] moved=${r.moved} present=${r.alreadyPresent} skipped=${r.skipped}`);
        }
      })
      .catch((err: Error) => console.warn('[pgMessageReconcile] pass failed:', err.message))
      .finally(() => { passInFlight = false; });
  }, intervalMs);
  timer.unref?.();
}
