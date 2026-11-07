/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F227: a message whose author has no users row reads as unknown, not as a
 * person. The mock in agentMessageService.selfIdentity.test.js would pass even
 * if the query stopped returning the column, so this reads a real LEFT JOIN.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

// The models read `pool` from config/db-pg when they load; this holder is
// filled with the test schema's pool before they are required.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb01';
const NO_MIRROR = 'cccccccccccccccccccccc01';
const NULL_FLAG = 'cccccccccccccccccccccc02';

real('a sender with no mirror row on real PostgreSQL (F227)', () => {
  let database;
  let pool;
  let AgentMessageService;

  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require -- loaded after the pool holder is filled
      AgentMessageService = require('../../services/agentMessageService');
    });
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  it('leaves isBot off for an unknown sender and keeps it for a known one', async () => {
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'a-person', false)", [OWNER]);
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'no-flag', NULL)", [NULL_FLAG]);
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'Checkout', 'team', $2)", [POD, OWNER]);
    await pool.query(
      `INSERT INTO messages (pod_id, user_id, content, created_at) VALUES
        ($1, $2, 'known', now() - interval '3 minutes'),
        ($1, $3, 'no row', now() - interval '2 minutes'),
        ($1, $4, 'null flag', now() - interval '1 minute')`,
      [POD, OWNER, NO_MIRROR, NULL_FLAG],
    );

    const messages = await AgentMessageService.getRecentMessages(POD, 10);
    const byContent = Object.fromEntries(messages.map((m) => [m.content, m]));

    expect(byContent.known.isBot).toBe(false);
    expect(byContent['no row']).not.toHaveProperty('isBot');
    expect(byContent['null flag']).not.toHaveProperty('isBot');
  });
});
