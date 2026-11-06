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

/** An id a line commits to, kept outside its bytes (record-v1 §9). */
export type ChainOpening = {
  seq: number;
  commitment: string;
  /** The line path it sits at. Reading rules go by this. */
  field: string;
  /** The person account deletion removes it for. */
  subject: string;
  value: string;
  salt: string;
};

export type StoredChain = {
  runId: string;
  headSeq: number;
  headHash: string | null;
  lines: string[];
  /** Openings for this page's lines. A deleted id has none. */
  openings: ChainOpening[];
  /** Every opening the chain still holds, so a reader can tell when one went. */
  openingsTotal: number;
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

/** The seq a page really starts after. Anything that pairs lines to seqs uses this. */
export const pageAfter = (page: ChainPage = {}): number => Math.max(0, Math.trunc(Number(page.after) || 0));

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
  build: (prevLine: string | null, runId: string) => {
    lines: string[];
    headHash: string;
    /** One list per line, in order. */
    openings?: Array<Array<Omit<ChainOpening, 'seq'>>>;
  },
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
    const { lines, headHash, openings = [] } = build(prevLine, chain.run_id);
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
      for (const opening of openings[index] || []) {
        // eslint-disable-next-line no-await-in-loop -- one ordered chain, one client
        await client.query(
          `INSERT INTO record_openings (chain_id, seq, commitment, field, subject, value, salt)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [chain.id, chain.head_seq + 1 + index, opening.commitment, opening.field, opening.subject, opening.value, opening.salt],
        );
      }
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
  const after = pageAfter(page);
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
  const openings = rows.length === 0 ? [] : (await store.query(
    `SELECT seq, commitment, field, subject, value, salt FROM record_openings
     WHERE chain_id = $1 AND seq > $2 AND seq <= $3`,
    [chain.id, after, last],
  )).rows as ChainOpening[];
  const total = (await store.query(
    'SELECT count(*)::int AS total FROM record_openings WHERE chain_id = $1',
    [chain.id],
  )).rows[0] as { total?: number } | undefined;
  return {
    runId: chain.run_id,
    headSeq: chain.head_seq,
    headHash: chain.head_hash,
    lines: rows.map((row) => row.line),
    openings: openings.map((row) => ({ ...row, seq: Number(row.seq) })),
    openingsTotal: Number(total?.total ?? 0),
    nextAfter: rows.length > 0 && last < chain.head_seq ? last : null,
  };
}

/**
 * Forget a person: their ids go, and every line that committed to them stays
 * byte for byte, so each chain still verifies. Safe to repeat, and a store
 * with no PostgreSQL has nothing to forget. Returns how many ids went.
 */
export async function deleteOpeningsFor(subject: string, db: PgPool | null = pool): Promise<number> {
  if (!db) return 0;
  return (await db.query('DELETE FROM record_openings WHERE subject = $1', [subject])).rowCount || 0;
}
