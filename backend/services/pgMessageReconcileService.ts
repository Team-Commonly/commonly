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
 * - Bounded. One pass reads at most `maxPerPass` rows, oldest first.
 * - Refusals are recorded, not retried. A row the database will never accept
 *   (its pod is not in Postgres) is stamped `reconcileFailedAt` and left out
 *   of the scan, so it cannot hold back the rows behind it.
 *
 * Reads never merge the two stores: chat reads Postgres when it is healthy and
 * Mongo only when it is not. A reconciled Mongo row therefore cannot be
 * returned alongside its PG copy in one response.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { pool } = require('../config/db-pg') as {
  pool: {
    query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  };
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const { syncPodFromMongo } = require('./pgPodSyncService') as {
  syncPodFromMongo: (podId: string, requestingUserId: string) => Promise<unknown>;
};
// eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
const MongoPod = require('../models/Pod') as {
  exists: (q: Record<string, unknown>) => Promise<unknown>;
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
  // Both must survive the move: a card loses its face without payload, and a
  // kernel seat post loses its marker without authorKind.
  authorKind?: string | null;
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

// Postgres SQLSTATE 23503: foreign_key_violation (messages.pod_id has no pod row).
const FK_VIOLATION = '23503';

/**
 * Builds the unique index ON CONFLICT needs, without blocking writes.
 *
 * CONCURRENTLY cannot run inside a transaction, so this issues the statement
 * on its own autocommit connection. A failed concurrent build leaves an
 * INVALID index behind; IF NOT EXISTS would keep that forever, so an invalid
 * one is dropped and rebuilt.
 */
export async function ensureLegacyIdIndex(): Promise<void> {
  const state = await pool.query(
    `SELECT i.indisvalid FROM pg_index i
       JOIN pg_class c ON c.oid = i.indexrelid
      WHERE c.relname = $1`,
    [LEGACY_ID_INDEX],
  );
  if (state.rows[0] && state.rows[0].indisvalid === false) {
    await pool.query(`DROP INDEX CONCURRENTLY IF EXISTS ${LEGACY_ID_INDEX}`);
  }
  await pool.query(
    `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS ${LEGACY_ID_INDEX}
       ON messages (legacy_mongo_id)`,
  );
}

async function podExistsInMongo(podId: string): Promise<boolean> {
  return Boolean(await MongoPod.exists({ _id: podId }));
}

async function copyOne(doc: MongoFallbackDoc): Promise<'moved' | 'present'> {
  const id = doc._id.toString();
  const inserted = await pool.query(
    `INSERT INTO messages (
       pod_id, user_id, content, message_type, author_kind, payload, created_at, legacy_mongo_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (legacy_mongo_id) DO NOTHING
     RETURNING id`,
    [
      doc.podId.toString(),
      doc.userId.toString(),
      doc.content || '',
      doc.messageType || 'text',
      doc.authorKind === 'kernel' ? 'kernel' : null,
      doc.payload == null ? null : JSON.stringify(doc.payload),
      doc.createdAt,
      id,
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

  await ensureLegacyIdIndex();

  const batch = await MongoMessage.find({
    reconciledAt: { $exists: false },
    reconcileFailedAt: { $exists: false },
  })
    .sort({ createdAt: 1, _id: 1 })
    .limit(Math.max(1, Math.trunc(maxPerPass)))
    .lean();

  for (const doc of batch) {
    try {
      const outcome = await copyOne(doc).catch(async (err: { code?: string }) => {
        // The pod is missing from PG. The Mongo-only pod path leaves it that
        // way until the next send backfills it (createMessage does the same
        // before its insert), so backfill and retry once.
        if (err.code !== FK_VIOLATION) throw err;
        try {
          await syncPodFromMongo(doc.podId.toString(), doc.userId.toString());
        } catch {
          // No Mongo pod to sync from. The retry below fails the same way and
          // the outer handler decides whether that is permanent.
        }
        return copyOne(doc);
      });
      if (outcome === 'moved') result.moved += 1;
      else result.alreadyPresent += 1;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      result.skipped += 1;
      // Stamp a refusal only when the pod is absent from Mongo too: then no
      // sync can ever place the message. Anything else stays in the scan and
      // is retried on the next pass.
      if (e.code === FK_VIOLATION && !(await podExistsInMongo(doc.podId.toString()))) {
        await MongoMessage.updateOne(
          { _id: doc._id, reconcileFailedAt: { $exists: false } },
          { $set: { reconcileFailedAt: new Date(), reconcileError: e.message || e.code } },
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
