/** Exercise the provider audit columns through the real PostgreSQL model. */
const { Pool } = require('pg');
// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../models/ToolCall');
// eslint-disable-next-line import/no-unresolved, import/extensions
const { TOOL_CALL_DDL } = require('../../models/ToolCall');

const run = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const GRANT_ID = `task284-provider-ref-${Date.now()}`;

const observerPool = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

run('ToolCall provider ref audit on real PostgreSQL', () => {
  let observer;

  beforeAll(async () => {
    observer = observerPool();
    await ToolCall.create({
      callId: GRANT_ID,
      grantId: GRANT_ID,
      agentUserId: 'seat-a',
      tool: 'github.push_branch',
      argsDigest: 'a'.repeat(64),
      outcome: 'ok',
      providerRepo: 'Team-Commonly/commonly',
      providerRef: 'refs/heads/seat/seat-a/work',
    });
  });

  afterAll(async () => {
    if (observer) {
      await observer.query('DELETE FROM tool_calls WHERE grant_id = $1', [GRANT_ID]);
      await observer.end();
    }
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    const { pool } = require('../../config/db-pg');
    if (pool?.end) await pool.end();
  });

  test('insert and list retain the exact provider repository and ref', async () => {
    const query = 'SELECT provider_repo, provider_ref FROM tool_calls WHERE call_id = $1';
    const { rows } = await observer.query(query, [GRANT_ID]);
    expect(rows).toEqual([{
      provider_repo: 'Team-Commonly/commonly',
      provider_ref: 'refs/heads/seat/seat-a/work',
    }]);
    const [line] = await ToolCall.listForGrant(GRANT_ID);
    expect(line).toMatchObject({
      providerRepo: 'Team-Commonly/commonly',
      providerRef: 'refs/heads/seat/seat-a/work',
    });
  });

  test('DDL creates the columns and retrofits an existing table', async () => {
    const schema = `task284_${Date.now()}`;
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
        'provider_repo', 'provider_ref',
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
        (call_id, grant_id, agent_user_id, tool, args_digest, outcome, provider_repo, provider_ref)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
        'retrofit-row', GRANT_ID, 'seat-a', 'github.push_branch', 'b'.repeat(64),
        'ok', 'Team-Commonly/commonly', 'refs/heads/seat/seat-a/work',
      ]);
      const { rows } = await client.query(
        'SELECT provider_repo, provider_ref FROM tool_calls WHERE call_id = $1',
        ['retrofit-row'],
      );
      expect(rows[0]).toMatchObject({
        provider_repo: 'Team-Commonly/commonly',
        provider_ref: 'refs/heads/seat/seat-a/work',
      });
    } finally {
      await client.query('RESET search_path');
      client.release();
      await observer.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  });
});
