/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentTaskWakeState on real PostgreSQL: migration 0019, and
 * a reserve, a release and a re-reserve through the real pgTableAdapter SQL,
 * with the released slot's NULL last_wake_at and verify agreeing.
 */
const fs = require('fs');
const path = require('path');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const AgentTaskWakeState = require('../../models/AgentTaskWakeState');
const {
  reserveWake, releaseWake, taskWakeStateStore,
} = require('../../repositories/agentTaskWakeStateRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0019_agent_task_wake_states.sql'), 'utf8',
);
const ENV = 'STORE_MODE_AGENT_TASK_WAKE_STATE';
const INTERVAL = 30 * 60000;
const NOW = new Date('2026-11-25T10:00:00Z');
const minutes = (m) => new Date(NOW.getTime() + m * 60000);
const KEY = JSON.stringify(['codex', 'forge']);

real('AgentTaskWakeState on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await AgentTaskWakeState.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await AgentTaskWakeState.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0019 is a no-op on a second run, and last_wake_at takes NULL', async () => {
    await database.pool.query(MIGRATION);
    await database.pool.query('INSERT INTO agent_task_wake_states (id, pg_version) VALUES ($1, 1)', [KEY]);
    const { rows } = await database.pool.query('SELECT last_wake_at FROM agent_task_wake_states');
    expect(rows).toEqual([{ last_wake_at: null }]);
  });

  it('dual: a reserve, a release and a re-reserve land in both stores, and verify finds them equal', async () => {
    process.env[ENV] = 'dual';
    const select = async () => (await database.pool.query(
      'SELECT id, last_wake_at, pg_version FROM agent_task_wake_states',
    )).rows;

    expect(await reserveWake(KEY, NOW, INTERVAL)).toBe(true);
    // Held: a second worker inside the interval gets nothing, and nothing is copied for it.
    expect(await reserveWake(KEY, minutes(5), INTERVAL)).toBe(false);
    expect(await select()).toEqual([{ id: KEY, last_wake_at: NOW, pg_version: 1 }]);

    // A worker whose slot was taken since releases nothing.
    expect(await releaseWake(KEY, minutes(-40))).toBe(false);
    expect(await releaseWake(KEY, NOW)).toBe(true);
    expect(await select()).toEqual([{ id: KEY, last_wake_at: null, pg_version: 2 }]);

    expect(await reserveWake(KEY, minutes(1), INTERVAL)).toBe(true);
    const doc = await AgentTaskWakeState.findById(KEY).lean();
    const { rows } = await database.pool.query('SELECT * FROM agent_task_wake_states');
    expect(rows).toEqual([{
      id: KEY,
      last_wake_at: minutes(1),
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      pg_version: 3,
    }]);
    const verified = await taskWakeStateStore().verify();
    expect(verified).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });
});
