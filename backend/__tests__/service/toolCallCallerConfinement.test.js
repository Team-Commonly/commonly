/** The caller's confinement (F94, migration 0007) through the real PostgreSQL model. */
// eslint-disable-next-line import/no-unresolved, import/extensions
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

// As toolCallProviderRef.test.js: the model binds `pool` at require time, so
// this stand-in forwards to a private schema the shipped migrations built.
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
const GRANT_ID = `f94-caller-confinement-${Date.now()}`;

run('ToolCall caller confinement on real PostgreSQL', () => {
  let database;
  let observer;

  beforeAll(async () => {
    database = await createRealPgSchema();
    observer = database.pool;
    // eslint-disable-next-line global-require, import/no-unresolved, import/extensions
    require('../../config/db-pg').target.pool = observer;
    await runPgMigrations(observer);
    await ToolCall.create({
      callId: `${GRANT_ID}-named`,
      grantId: GRANT_ID,
      agentUserId: 'seat-a',
      tool: 'linear.list_issues',
      argsDigest: 'a'.repeat(64),
      outcome: 'ok',
      callerConfinement: 'named_unconfined',
    });
    // A refusal before the confinement check records none.
    await ToolCall.create({
      callId: `${GRANT_ID}-early`,
      grantId: GRANT_ID,
      agentUserId: 'seat-b',
      tool: 'linear.list_issues',
      argsDigest: 'b'.repeat(64),
      outcome: 'refused',
      reason: 'grant_not_found',
    });
  });

  afterAll(async () => {
    if (database) await database.close();
  });

  test('insert and list keep a classified state, and leave an unjudged call null', async () => {
    const { rows } = await observer.query(
      'SELECT call_id, caller_confinement FROM tool_calls WHERE grant_id = $1 ORDER BY call_id',
      [GRANT_ID],
    );
    expect(rows).toEqual([
      { call_id: `${GRANT_ID}-early`, caller_confinement: null },
      { call_id: `${GRANT_ID}-named`, caller_confinement: 'named_unconfined' },
    ]);
    const lines = await ToolCall.listForGrant(GRANT_ID);
    expect(lines.find((line) => line.callId === `${GRANT_ID}-named`).callerConfinement).toBe('named_unconfined');
    expect(lines.find((line) => line.callId === `${GRANT_ID}-early`).callerConfinement).toBeUndefined();
  });
});
