import { createHash } from 'crypto';

interface PgResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number;
}

interface PgClient {
  query: (sql: string, params?: unknown[]) => Promise<PgResult>;
  release: () => void;
}

interface PgPool {
  query: (sql: string, params?: unknown[]) => Promise<PgResult>;
  connect: () => Promise<PgClient>;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { pool } = require('../config/db-pg') as { pool: PgPool | null };

export type ToolCallOutcome = 'ok' | 'refused' | 'pending_approval' | 'failed';

/**
 * A derived value the trail REPORTS but the table never stores. A parked row
 * (`pending_approval`) is the *request*, not the call: when the approval
 * resolves, the resolution is recorded as its own row carrying the same
 * `approval_id` — the executed call (`ok`/`failed`) or the declined/expired
 * decision (`refused`). The parked row is then no longer awaiting anyone, and
 * reporting it as `pending_approval` forever is how a trail ends up claiming
 * a person is still being waited on for work that already ran (C4-11).
 *
 * Kept OUT of `ToolCallOutcome` so it can never be written into the column,
 * whose CHECK constraint is the storage vocabulary.
 */
export type ToolCallDisplayOutcome = ToolCallOutcome | 'superseded';

/** A parked row is superseded when a resolved sibling of the same approval
 * exists. `approval_id` is the join: every terminal path stamps the parked
 * row's approval id on the row it writes (approved → the broker's `ok`/`failed`
 * row, declined/expired → `recordToolCallDecision`'s `refused` row). A parked
 * row whose `approval_id` is NULL matches nothing here and stays awaiting —
 * correctly, because nothing ever resolved it.
 *
 * Expressed as a LEFT JOIN on the resolved approvals of ONE grant rather than a
 * correlated EXISTS: the same plan on real PostgreSQL, and the form the unit
 * tests can actually execute (pg-mem throws on a correlated `EXISTS` inside a
 * CASE). Both queries below pass the grant id as `$1`, which this fragment
 * references.
 */
const RESOLVED_SIBLINGS = `(
         SELECT DISTINCT sibling.grant_id, sibling.approval_id
           FROM tool_calls sibling
          WHERE sibling.grant_id = $1
            AND sibling.outcome <> 'pending_approval'
            AND sibling.approval_id IS NOT NULL) resolved`;

/** `$1` = grant id (via RESOLVED_SIBLINGS); the caller adds its own params. */
const EFFECTIVE_OUTCOME = `CASE WHEN tc.outcome = 'pending_approval'
                AND resolved.approval_id IS NOT NULL
           THEN 'superseded' ELSE tc.outcome END`;

export interface ToolCallRecord {
  callId: string;
  grantId: string;
  podId?: string;
  installationId?: string;
  agentUserId: string;
  tool: string;
  argsDigest: string;
  at?: Date;
  outcome: ToolCallOutcome;
  reason?: string;
  approvalId?: string;
  durationMs?: number;
}

const DDL = `
CREATE TABLE IF NOT EXISTS tool_call_budgets (
  grant_id VARCHAR(255) PRIMARY KEY,
  calls_used INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS tool_calls (
  call_id VARCHAR(255) PRIMARY KEY,
  grant_id VARCHAR(255) NOT NULL,
  pod_id VARCHAR(255),
  installation_id VARCHAR(255),
  agent_user_id VARCHAR(255) NOT NULL,
  tool VARCHAR(255) NOT NULL,
  args_digest CHAR(64) NOT NULL,
  occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
  outcome VARCHAR(32) NOT NULL CHECK (outcome IN ('ok', 'refused', 'pending_approval', 'failed')),
  reason VARCHAR(255),
  approval_id VARCHAR(255),
  duration_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_tool_calls_grant_at ON tool_calls(grant_id, occurred_at DESC);
`;

let ensured = false;
let ensureInFlight: Promise<PgPool> | null = null;

const ensurePool = (): PgPool => {
  if (!pool) throw new Error('tool broker requires PostgreSQL');
  return pool;
};

const ensureTables = async (): Promise<PgPool> => {
  const db = ensurePool();
  if (ensured) return db;
  if (!ensureInFlight) {
    ensureInFlight = db.query(DDL)
      .then(() => {
        ensured = true;
        return db;
      })
      .finally(() => {
        ensureInFlight = null;
      });
  }
  return ensureInFlight;
};

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value) || 'null';
};

/** Stable digest used in the audit trail; request arguments are never stored. */
export const digestArgs = (args: unknown): string => createHash('sha256')
  .update(stableJson(args === undefined ? {} : args))
  .digest('hex');

/**
 * Atomically reserve one call against a grant budget. The INSERT/ON CONFLICT
 * statement takes the row lock and only returns a row when a slot was spent.
 * This is deliberately one conditional write rather than a read followed by
 * an increment, so concurrent calls cannot both consume the final slot.
 */
const reserveOne = async (
  client: PgClient,
  grantId: string,
  calls: number,
  windowMs?: number,
): Promise<boolean> => {
  if (!Number.isInteger(calls) || calls <= 0) return false;
  if (windowMs === undefined) {
    const result = await client.query(
      `INSERT INTO tool_call_budgets (grant_id, calls_used, window_started_at)
       VALUES ($1, 1, CURRENT_TIMESTAMP)
       ON CONFLICT (grant_id) DO UPDATE
         SET calls_used = tool_call_budgets.calls_used + 1
       WHERE tool_call_budgets.calls_used < $2
       RETURNING calls_used`,
      [grantId, calls],
    );
    return result.rows.length > 0;
  }
  if (!Number.isInteger(windowMs) || windowMs < 1) return false;
  const result = await client.query(
    `INSERT INTO tool_call_budgets (grant_id, calls_used, window_started_at)
     VALUES ($1, 1, CURRENT_TIMESTAMP)
     ON CONFLICT (grant_id) DO UPDATE
       SET calls_used = CASE
         WHEN CURRENT_TIMESTAMP >= tool_call_budgets.window_started_at
              + ($3::double precision * INTERVAL '1 millisecond') THEN 1
         ELSE tool_call_budgets.calls_used + 1
       END,
       window_started_at = CASE
         WHEN CURRENT_TIMESTAMP >= tool_call_budgets.window_started_at
              + ($3::double precision * INTERVAL '1 millisecond') THEN CURRENT_TIMESTAMP
         ELSE tool_call_budgets.window_started_at
       END
     WHERE CURRENT_TIMESTAMP >= tool_call_budgets.window_started_at
           + ($3::double precision * INTERVAL '1 millisecond')
        OR tool_call_budgets.calls_used < $2
     RETURNING calls_used`,
    [grantId, calls, windowMs],
  );
  return result.rows.length > 0;
};

/** Reserve one slot on every grant in a lineage in one transaction. A child
 * therefore consumes both its own cap and each ancestor cap; if any row is
 * exhausted, the transaction rolls back all earlier reservations. */
export const reserveBudgetLineage = async (
  entries: Array<{ grantId: string; calls: number; windowMs?: number }>,
): Promise<boolean> => {
  if (entries.length === 0) return true;
  const db = await ensureTables();
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      if (!await reserveOne(client, entry.grantId, entry.calls, entry.windowMs)) {
        await client.query('ROLLBACK');
        return false;
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
};

export const reserveBudget = async (
  grantId: string,
  calls: number,
  windowMs?: number,
): Promise<boolean> => reserveBudgetLineage([{ grantId, calls, windowMs }]);

class ToolCall {
  static countsForGrant: (grantId: string) => Promise<ToolCallCounts>;

  static async create(record: ToolCallRecord): Promise<void> {
    const db = await ensureTables();
    await db.query(
      `INSERT INTO tool_calls
       (call_id, grant_id, pod_id, installation_id, agent_user_id, tool,
        args_digest, occurred_at, outcome, reason, approval_id, duration_ms)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        record.callId,
        record.grantId,
        record.podId || null,
        record.installationId || null,
        record.agentUserId,
        record.tool,
        record.argsDigest,
        record.at || new Date(),
        record.outcome,
        record.reason || null,
        record.approvalId || null,
        record.durationMs ?? null,
      ],
    );
  }

  static async listForGrant(grantId: string, limit = 100): Promise<ToolCallListRecord[]> {
    const db = await ensureTables();
    const result = await db.query(
      `SELECT tc.call_id, tc.grant_id, tc.pod_id, tc.installation_id, tc.agent_user_id,
              tc.tool, tc.args_digest, tc.occurred_at,
              ${EFFECTIVE_OUTCOME} AS effective_outcome,
              tc.reason, tc.approval_id, tc.duration_ms
       FROM tool_calls tc
       LEFT JOIN ${RESOLVED_SIBLINGS}
         ON resolved.grant_id = tc.grant_id AND resolved.approval_id = tc.approval_id
      WHERE tc.grant_id = $1
      ORDER BY tc.occurred_at DESC LIMIT $2`,
      [grantId, Math.max(1, Math.min(500, Math.trunc(limit)))],
    );
    return result.rows.map((row) => ({
      callId: String(row.call_id),
      grantId: String(row.grant_id),
      podId: row.pod_id ? String(row.pod_id) : undefined,
      installationId: row.installation_id ? String(row.installation_id) : undefined,
      agentUserId: String(row.agent_user_id),
      tool: String(row.tool),
      argsDigest: String(row.args_digest),
      at: new Date(String(row.occurred_at)),
      outcome: String(row.effective_outcome) as ToolCallDisplayOutcome,
      reason: row.reason ? String(row.reason) : undefined,
      approvalId: row.approval_id ? String(row.approval_id) : undefined,
      durationMs: row.duration_ms === null || row.duration_ms === undefined
        ? undefined : Number(row.duration_ms),
    }));
  }
}

export interface ToolCallCounts {
  total: number;
  ok: number;
  refused: number;
  pending_approval: number;
  failed: number;
}

/** A trail row as READ: `outcome` may be the derived `superseded`, which the
 * table never stores. Writes stay typed as `ToolCallRecord` so a derived value
 * can never reach the INSERT. */
export interface ToolCallListRecord extends Omit<ToolCallRecord, 'outcome'> {
  outcome: ToolCallDisplayOutcome;
}

/** The page's three numbers are COUNT(*) by outcome (plan §6), with one
 * derived correction: a parked row that a resolution has superseded is not a
 * call and is not awaiting anyone, so it is in neither `total` nor
 * `pending_approval`. The row that resolved it is counted instead, so
 * `ok + refused + failed + pending_approval === total`. */
ToolCall.countsForGrant = async function countsForGrant(grantId: string): Promise<ToolCallCounts> {
  const db = await ensureTables();
  const result = await db.query(
    `SELECT outcome, COUNT(*) AS n FROM (
       SELECT ${EFFECTIVE_OUTCOME} AS outcome
         FROM tool_calls tc
         LEFT JOIN ${RESOLVED_SIBLINGS}
           ON resolved.grant_id = tc.grant_id AND resolved.approval_id = tc.approval_id
        WHERE tc.grant_id = $1) derived
      GROUP BY outcome`,
    [grantId],
  );
  const counts: ToolCallCounts = { total: 0, ok: 0, refused: 0, pending_approval: 0, failed: 0 };
  for (const row of result.rows) {
    const outcome = String(row.outcome) as ToolCallDisplayOutcome;
    const n = Number(row.n) || 0;
    if (outcome === 'superseded') continue;
    if (outcome in counts) counts[outcome] = n;
    counts.total += n;
  }
  return counts;
};

export { ToolCall };
export default ToolCall;

// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
