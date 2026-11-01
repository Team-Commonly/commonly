/**
 * Storage for server-written record-v1 chains (TASK-513, migration 0002).
 * It stores and returns line bytes; it never builds or parses a line. The
 * format belongs to the shared writer (vendor/seats/src/record/format.js).
 */

interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
  release: () => void;
}
interface PgPool {
  connect: () => Promise<PgClient>;
  query: PgClient['query'];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../config/db-pg') as { pool: PgPool | null };

/** A pod's taskless chain is stored with task_id ''; task ids are never empty. */
export type ChainRef = { podId: string; taskId?: string };

export type StoredChain = {
  runId: string;
  headSeq: number;
  headHash: string | null;
  lines: string[];
  /** The seq to pass as `after` for the next page; null when this page reached the head. */
  nextAfter: number | null;
};

/** The most lines one read returns. A chain longer than this is read in pages. */
export const MAX_PAGE_LINES = 1000;

/**
 * A seq cursor: the lines after seq `after`, at most `limit` of them. A page's
 * first line carries `prev`, the hash of line `after`, so pages read in order
 * concatenate into one chain that still verifies.
 */
export type ChainPage = { after?: number; limit?: number };

/** Thrown when no PostgreSQL is configured; a reader must not answer "empty". */
export class RecordStoreUnavailableError extends Error {
  constructor() {
    super('record store unavailable: PostgreSQL is not configured');
    this.name = 'RecordStoreUnavailableError';
  }
}

const requirePool = (db: PgPool | null = pool): PgPool => {
  if (!db) throw new RecordStoreUnavailableError();
  return db;
};

const taskKey = (ref: ChainRef): string => ref.taskId || '';

/**
 * Append one source event's lines to a chain, in one transaction under the
 * chain row's lock, so concurrent writers on any replica get consecutive seqs.
 * `build(prevLine, runId)` runs under that lock and returns the new lines and
 * the SHA-256 of the last one. A redelivered event key appends nothing.
 */
export async function appendToChain(
  ref: ChainRef,
  runId: string,
  eventKey: string,
  build: (prevLine: string | null, runId: string) => { lines: string[]; headHash: string },
  db: PgPool | null = pool,
): Promise<{ appended: number; duplicate: boolean }> {
  const client = await requirePool(db).connect();
  try {
    await client.query('BEGIN');
    // No conflict target. run_id is unique as well, and a target covers one
    // index only, so two first writers racing on one chain could pass the
    // (pod_id, task_id) check together and fail on run_id instead.
    await client.query(
      `INSERT INTO record_chains (pod_id, task_id, run_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [ref.podId, taskKey(ref), runId],
    );
    const chain = (await client.query(
      'SELECT id, run_id, head_seq FROM record_chains WHERE pod_id = $1 AND task_id = $2 FOR UPDATE',
      [ref.podId, taskKey(ref)],
    )).rows[0] as { id: string; run_id: string; head_seq: number } | undefined;
    if (!chain) throw new Error(`record chain not created: run_id ${runId} belongs to another chain`);
    const seen = await client.query(
      'SELECT 1 FROM record_lines WHERE chain_id = $1 AND source_key = $2',
      [chain.id, `${eventKey}/0`],
    );
    if (seen.rowCount) {
      await client.query('ROLLBACK');
      return { appended: 0, duplicate: true };
    }
    const prevLine = chain.head_seq > 0
      ? (await client.query(
        'SELECT line FROM record_lines WHERE chain_id = $1 AND seq = $2',
        [chain.id, chain.head_seq],
      )).rows[0].line as string
      : null;
    const { lines, headHash } = build(prevLine, chain.run_id);
    if (lines.length === 0) {
      await client.query('ROLLBACK');
      return { appended: 0, duplicate: false };
    }
    for (let index = 0; index < lines.length; index += 1) {
      // eslint-disable-next-line no-await-in-loop -- one ordered chain, one client
      await client.query(
        'INSERT INTO record_lines (chain_id, seq, line, source_key) VALUES ($1, $2, $3, $4)',
        [chain.id, chain.head_seq + 1 + index, lines[index], `${eventKey}/${index}`],
      );
    }
    await client.query(
      'UPDATE record_chains SET head_seq = $2, head_hash = $3, updated_at = NOW() WHERE id = $1',
      [chain.id, chain.head_seq + lines.length, headHash],
    );
    await client.query('COMMIT');
    return { appended: lines.length, duplicate: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Read one page of a chain's lines, bounded by its stored head. Lines and head
 * commit together, so bounding by the head read first gives a consistent
 * prefix without a transaction. A chain that was never written returns null.
 */
export async function readChain(
  ref: ChainRef,
  db: PgPool | null = pool,
  page: ChainPage = {},
): Promise<StoredChain | null> {
  const store = requirePool(db);
  const after = Math.max(0, Math.trunc(Number(page.after) || 0));
  const limit = Math.min(MAX_PAGE_LINES, Math.max(1, Math.trunc(Number(page.limit) || MAX_PAGE_LINES)));
  const chain = (await store.query(
    'SELECT id, run_id, head_seq, head_hash FROM record_chains WHERE pod_id = $1 AND task_id = $2',
    [ref.podId, taskKey(ref)],
  )).rows[0] as { id: string; run_id: string; head_seq: number; head_hash: string | null } | undefined;
  if (!chain) return null;
  const rows = (await store.query(
    'SELECT seq, line FROM record_lines WHERE chain_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq LIMIT $4',
    [chain.id, after, chain.head_seq, limit],
  )).rows as Array<{ seq: number; line: string }>;
  const last = rows.length > 0 ? Number(rows[rows.length - 1].seq) : after;
  return {
    runId: chain.run_id,
    headSeq: chain.head_seq,
    headHash: chain.head_hash,
    lines: rows.map((row) => row.line),
    nextAfter: rows.length > 0 && last < chain.head_seq ? last : null,
  };
}
