/** The ToolCall INSERT and SELECT must run on real PostgreSQL. */
/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const { Pool } = require('pg');
const ToolCall = require('../../models/ToolCall');
const { pool } = require('../../config/db-pg');
const { runPgMigrations } = require('../../config/run-pg-migrations');

const run = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const GRANT_ID = `task263-vendor-diagnostic-tier1-${Date.now()}`;

const observerPool = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

run('ToolCall vendor diagnostics on real PostgreSQL', () => {
  let observer;

  beforeAll(async () => {
    observer = observerPool();
    // The table comes from the migrations, as at boot; the retrofit of a table
    // that predates these columns is pgMigrations.test.js's. The row is then
    // read through a second pool.
    await runPgMigrations(pool);
    await ToolCall.create({
      callId: `${GRANT_ID}-${Date.now()}`,
      grantId: GRANT_ID,
      agentUserId: 'agent-a',
      tool: 'atlassian.get_accessible_atlassian_resources',
      argsDigest: 'a'.repeat(64),
      outcome: 'failed',
      reason: 'provider_error',
      vendorStatus: 400,
      vendorError: 'session required',
    });
  });

  afterAll(async () => {
    if (observer) {
      await observer.query('DELETE FROM tool_calls WHERE grant_id = $1', [GRANT_ID]);
      await observer.end();
    }
    // The model's pool is distinct from the observing connection.
    if (pool?.end) await pool.end();
  });

  test('the inserted status and bounded line survive through another pool', async () => {
    const { rows } = await observer.query(
      'SELECT reason, vendor_status, vendor_error FROM tool_calls WHERE grant_id = $1', [GRANT_ID],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      reason: 'provider_error', vendor_status: 400, vendor_error: 'session required',
    });
    const [line] = await ToolCall.listForGrant(GRANT_ID);
    expect(line).toMatchObject({ vendorStatus: 400, vendorError: 'session required' });

    await ToolCall.create({
      callId: `${GRANT_ID}-null-${Date.now()}`, grantId: GRANT_ID,
      agentUserId: 'agent-a', tool: 'atlassian.get_accessible_atlassian_resources',
      argsDigest: 'b'.repeat(64), outcome: 'ok',
    });
    const withoutDiagnostics = (await ToolCall.listForGrant(GRANT_ID)).find((item) => item.outcome === 'ok');
    expect(withoutDiagnostics.vendorStatus).toBeUndefined();
    expect(withoutDiagnostics.vendorError).toBeUndefined();
  });
});
