/** Exercise the provider audit columns through the real PostgreSQL model. */
const { Pool } = require('pg');
// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../models/ToolCall');

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

  // A fresh database and a retrofitted pre-provider table both end with the
  // provider columns: pgMigrations.test.js applies 0004 to each and compares
  // tool_calls' full column list.
});
