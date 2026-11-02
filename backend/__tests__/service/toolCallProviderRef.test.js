/** Exercise the provider audit columns through the real PostgreSQL model. */
// eslint-disable-next-line import/no-unresolved, import/extensions
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

// The model no longer creates tool_calls itself, so it runs against a private
// schema the shipped migrations built. The model binds `pool` at require time;
// this stand-in forwards to that schema's pool once it exists.
jest.mock('../../config/db-pg', () => {
  const target = { pool: null };
  return {
    target,
    pool: {
      query: (...args) => target.pool.query(...args),
      connect: (...args) => target.pool.connect(...args),
    },
  };
});
// eslint-disable-next-line import/no-unresolved, import/extensions
const ToolCall = require('../../models/ToolCall');

const run = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const GRANT_ID = `task284-provider-ref-${Date.now()}`;

run('ToolCall provider ref audit on real PostgreSQL', () => {
  let database;
  let observer;

  beforeAll(async () => {
    database = await createRealPgSchema();
    observer = database.pool;
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    require('../../config/db-pg').target.pool = observer;
    await runPgMigrations(observer);
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
    if (database) await database.close();
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
