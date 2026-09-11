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

  static async listForGrant(grantId: string, limit = 100): Promise<ToolCallRecord[]> {
    const db = await ensureTables();
    const result = await db.query(
      `SELECT call_id, grant_id, pod_id, installation_id, agent_user_id,
              tool, args_digest, occurred_at, outcome, reason, approval_id,
              duration_ms
       FROM tool_calls WHERE grant_id = $1
       ORDER BY occurred_at DESC LIMIT $2`,
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
      outcome: String(row.outcome) as ToolCallOutcome,
      reason: row.reason ? String(row.reason) : undefined,
      approvalId: row.approval_id ? String(row.approval_id) : undefined,
      durationMs: row.duration_ms === null || row.duration_ms === undefined
        ? undefined : Number(row.duration_ms),
    }));
  }
}

export { ToolCall };
export default ToolCall;

// CJS compat: let require() return the default export directly.
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"];
Object.assign(module.exports, exports);
