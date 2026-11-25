import Cursor from '../models/AgentPodReadCursor';
import { createDualStore, pgTableAdapter } from './dualStore';

type ReadWatermark = { readAt: Date; readRevision?: number };
type Doc = Record<string, unknown>;

const cursorId = (agentUserId: unknown, podId: unknown): string => `${String(agentUserId)}:${String(podId)}`;

// The pool is resolved per query: in mongo mode (the default) nothing here
// touches Postgres, and an instance without PG_HOST never needs it.
const lazyPool = {
  query: (sql: string, params?: unknown[]) => {
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { pool } = require('../config/db-pg');
    if (!pool) throw new Error('agent_pod_read_cursors: PostgreSQL is not configured (PG_HOST)');
    return pool.query(sql, params);
  },
};

const later = (a: unknown, b: Date): Date => (a instanceof Date && a > b ? a : b);

/**
 * ADR-034 step 2 for the read cursor, selected by STORE_MODE_AGENT_POD_READ_CURSOR.
 * Table: config/migrations/0016_agent_pod_read_cursors.sql.
 */
export const readCursorStore = createDualStore({
  name: 'AgentPodReadCursor',
  model: Cursor,
  pg: pgTableAdapter({
    pool: lazyPool,
    table: 'agent_pod_read_cursors',
    idColumn: 'id',
    columns: ['agent_user_id', 'pod_id', 'read_at', 'read_revision'],
  }),
  toRow: (doc) => ({
    id: String(doc._id),
    agent_user_id: String(doc.agentUserId),
    pod_id: String(doc.podId),
    read_at: doc.readAt,
    read_revision: doc.readRevision ?? null,
  }),
  fromRow: (row) => Cursor.castObject({
    _id: row.id,
    agentUserId: row.agent_user_id,
    podId: row.pod_id,
    readAt: row.read_at,
    ...(row.read_revision == null ? {} : { readRevision: Number(row.read_revision) }),
  }) as Doc,
});

/** Plain watermark or null. No Mongoose queries/documents escape this module. */
export async function getReadWatermark(agentUserId: unknown, podId: unknown): Promise<ReadWatermark | null> {
  const row = await readCursorStore.findById(cursorId(agentUserId, podId));
  if (!row) return null;
  return {
    readAt: row.readAt as Date,
    ...(row.readRevision == null ? {} : { readRevision: row.readRevision as number }),
  };
}

/**
 * Independent maxima preserve the existing timestamp/revision fence. The
 * pipeline and `merge` are one change in two languages: Mongo's, and the JS
 * applied where Postgres is the store. A parity test holds them together.
 */
export async function advanceReadWatermark(
  agentUserId: unknown, podId: unknown, watermark: ReadWatermark,
): Promise<void> {
  const withRevision = watermark.readRevision !== undefined;
  // Pipeline values bypass schema casting, so cast once here (and throw on a bad id, as the cast always did).
  const value = Cursor.castObject({
    agentUserId, podId, readAt: watermark.readAt, ...(withRevision ? { readRevision: watermark.readRevision } : {}),
  }) as { agentUserId: unknown; podId: unknown; readAt: Date; readRevision?: number };
  const literal = (v: unknown) => ({ $literal: v });
  await readCursorStore.upsert(cursorId(agentUserId, podId), {
    pipeline: [{
      $set: {
        agentUserId: { $ifNull: ['$agentUserId', literal(value.agentUserId)] },
        podId: { $ifNull: ['$podId', literal(value.podId)] },
        readAt: { $max: ['$readAt', literal(value.readAt)] },
        ...(withRevision ? { readRevision: { $max: ['$readRevision', literal(value.readRevision)] } } : {}),
      },
    }],
    merge: (current) => {
      const revision = current?.readRevision as number | undefined;
      let readRevision = revision;
      if (withRevision) {
        readRevision = revision == null ? value.readRevision : Math.max(revision, value.readRevision as number);
      }
      return {
        agentUserId: current?.agentUserId ?? value.agentUserId,
        podId: current?.podId ?? value.podId,
        readAt: later(current?.readAt, value.readAt),
        ...(readRevision == null ? {} : { readRevision }),
      };
    },
  });
}
