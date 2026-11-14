/**
 * F525 store: connect codes (0015_agent_connect_codes.sql). Domain operations
 * only, returning plain values; callers never see SQL. Without PG_HOST there
 * is no pool: `isAvailable` is false, minting refuses and the page keeps its
 * key lines.
 */
/* eslint-disable @typescript-eslint/no-require-imports, global-require */

interface PgPool {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number }>;
}

const loadPool = (): PgPool | null => (require('../config/db-pg') as { pool: PgPool | null }).pool;

export interface ConnectCodeRow {
  codeHash: string;
  agentUserId: string;
  tokenHash: string;
  sealed: string;
  iv: string;
  tag: string;
  redeems: number;
  expiresAt: Date;
}

const toRow = (row: any): ConnectCodeRow => ({
  codeHash: row.code_hash,
  agentUserId: row.agent_user_id,
  tokenHash: row.token_hash,
  sealed: row.sealed,
  iv: row.iv,
  tag: row.tag,
  redeems: Number(row.redeems),
  expiresAt: new Date(row.expires_at),
});

export const isAvailable = (): boolean => Boolean(loadPool());

const requirePool = (): PgPool => {
  const pool = loadPool();
  if (!pool) throw Object.assign(new Error('connect codes need PostgreSQL'), { code: 'connect_code_unavailable' });
  return pool;
};

/**
 * Store an agent's new code in place of its older one, and clear expired rows.
 * The unique index on agent_user_id makes the replace one statement, so two
 * mints at once still leave exactly one live code.
 */
export const replaceForAgent = async (row: Omit<ConnectCodeRow, 'redeems'>, now: Date): Promise<void> => {
  const pool = requirePool();
  await pool.query('DELETE FROM agent_connect_codes WHERE expires_at <= $1', [now]);
  await pool.query(
    `INSERT INTO agent_connect_codes (code_hash, agent_user_id, token_hash, sealed, iv, tag, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (agent_user_id) DO UPDATE SET code_hash = EXCLUDED.code_hash,
       token_hash = EXCLUDED.token_hash, sealed = EXCLUDED.sealed, iv = EXCLUDED.iv, tag = EXCLUDED.tag,
       redeems = 0, expires_at = EXCLUDED.expires_at, created_at = CURRENT_TIMESTAMP`,
    [row.codeHash, row.agentUserId, row.tokenHash, row.sealed, row.iv, row.tag, row.expiresAt],
  );
};

/**
 * Claim one redeem of a live code under the cap. The guarded UPDATE is the
 * claim: Postgres re-checks its WHERE on the locked row, so concurrent redeems
 * can't pass the cap. Null when there is no live code or the cap is reached.
 */
export const claimRedeem = async (codeHash: string, now: Date, maxRedeems: number): Promise<ConnectCodeRow | null> => {
  const pool = requirePool();
  const { rows } = await pool.query(
    `UPDATE agent_connect_codes SET redeems = redeems + 1
     WHERE code_hash = $1 AND expires_at > $2 AND redeems < $3
     RETURNING *`,
    [codeHash, now, maxRedeems],
  );
  return rows[0] ? toRow(rows[0]) : null;
};

/** The agent behind a live code, whatever its redeem count. */
export const liveAgentFor = async (codeHash: string, now: Date): Promise<string | null> => {
  const pool = requirePool();
  const { rows } = await pool.query(
    'SELECT agent_user_id FROM agent_connect_codes WHERE code_hash = $1 AND expires_at > $2',
    [codeHash, now],
  );
  return rows[0]?.agent_user_id || null;
};

export const remove = async (codeHash: string): Promise<void> => {
  const pool = requirePool();
  await pool.query('DELETE FROM agent_connect_codes WHERE code_hash = $1', [codeHash]);
};

module.exports = {
  isAvailable, replaceForAgent, claimRedeem, liveAgentFor, remove,
};
