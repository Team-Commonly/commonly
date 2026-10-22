/** The changed ToolCall DDL, INSERT and SELECT must run on real PostgreSQL. */
const { Pool } = require('pg');
const ToolCall = require('../../models/ToolCall');
const { TOOL_CALL_DDL } = require('../../models/ToolCall');

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
    // create() runs the model's CREATE/ALTER path, including an existing table
    // that predates these columns. The row is then read through a second pool.
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
    // eslint-disable-next-line global-require
    const { pool } = require('../../config/db-pg');
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

  test('the same DDL creates a fresh table and retrofits an old table', async () => {
    const schema = `task263_${Date.now()}`;
    await observer.query(`CREATE SCHEMA "${schema}"`);
    const client = await observer.connect();
    try {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(TOOL_CALL_DDL);
      const fresh = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'tool_calls'",
        [schema],
      );
      expect(fresh.rows.map((row) => row.column_name)).toEqual(expect.arrayContaining([
        'vendor_status', 'vendor_error',
      ]));

      await client.query('DROP TABLE tool_calls');
      await client.query(`CREATE TABLE tool_calls (
        call_id VARCHAR(255) PRIMARY KEY, grant_id VARCHAR(255) NOT NULL,
        pod_id VARCHAR(255), installation_id VARCHAR(255), agent_user_id VARCHAR(255) NOT NULL,
        tool VARCHAR(255) NOT NULL, args_digest CHAR(64) NOT NULL,
        occurred_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,
        outcome VARCHAR(32) NOT NULL, reason VARCHAR(255), approval_id VARCHAR(255),
        duration_ms INTEGER, credential_owner_id VARCHAR(255)
      )`);
      await client.query(TOOL_CALL_DDL);
      await client.query(`INSERT INTO tool_calls
        (call_id, grant_id, agent_user_id, tool, args_digest, outcome, vendor_status, vendor_error)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        'retrofit-row', GRANT_ID, 'agent-a', 'atlassian.test', 'c'.repeat(64),
        'failed', 400, 'session required',
      ]);
      const { rows } = await client.query('SELECT vendor_status, vendor_error FROM tool_calls WHERE call_id = $1',
        ['retrofit-row']);
      expect(rows[0]).toMatchObject({ vendor_status: 400, vendor_error: 'session required' });
    } finally {
      await client.query('RESET search_path');
      client.release();
      await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
