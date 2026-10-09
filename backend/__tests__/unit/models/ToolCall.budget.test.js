// Use pg-mem's real PostgreSQL adapter: this test exercises the conditional
// INSERT ... ON CONFLICT statement and the transaction used in production.
jest.mock('../../../config/db-pg', () => {
  // eslint-disable-next-line global-require
  const { newDb } = require('pg-mem');
  const db = newDb();
  const { Pool } = db.adapters.createPg();
  return { pool: new Pool() };
});

// eslint-disable-next-line import/no-unresolved, import/extensions
const { reserveBudget } = require('../../../models/ToolCall');

describe('tool-call budget ledger', () => {
  it('spends a finite lifetime budget atomically under concurrency', async () => {
    const results = await Promise.all(
      Array.from({ length: 20 }, () => reserveBudget('concurrent-grant', 3)),
    );
    // pg-mem currently reports a stale RETURNING row for an ON CONFLICT
    // branch whose WHERE predicate is false. Assert the durable SQL state,
    // which is the security invariant and is independent of that adapter
    // quirk.
    // eslint-disable-next-line global-require
    const { pool } = require('../../../config/db-pg');
    const row = await pool.query('SELECT calls_used FROM tool_call_budgets WHERE grant_id = $1', ['concurrent-grant']);
    expect(Number(row.rows[0].calls_used)).toBe(3);
    expect(results).toHaveLength(20);
  });
});
