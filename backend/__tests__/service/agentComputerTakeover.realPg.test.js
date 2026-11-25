/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentComputerTakeover on real PostgreSQL: migration 0021,
 * and dual set, bind, list and set again through the real pgTableAdapter SQL,
 * with another owner refused and verify finding both stores equal.
 */
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const { AgentComputerTakeover } = require('../../models/AgentComputerTakeover');
const {
  bindTarget, computerTakeoverStore, isTakeoverActive, listBindings, setTakeover,
} = require('../../repositories/agentComputerTakeoverRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0021_agent_computer_takeovers.sql'), 'utf8',
);
const ENV = 'STORE_MODE_AGENT_COMPUTER_TAKEOVER';

real('AgentComputerTakeover on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await AgentComputerTakeover.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await AgentComputerTakeover.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0021 is a no-op on a second run, and owner_id and active are required', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = current_schema()
        AND tablename = 'agent_computer_takeovers' ORDER BY indexname`,
    );
    expect(rows.map((r) => r.indexname))
      .toEqual(['agent_computer_takeovers_owner_id', 'agent_computer_takeovers_pkey']);
    await expect(database.pool.query(
      'INSERT INTO agent_computer_takeovers (id, active, pg_version) VALUES ($1, true, 1)', ['a'],
    )).rejects.toMatchObject({ code: '23502' });
    await expect(database.pool.query(
      'INSERT INTO agent_computer_takeovers (id, owner_id, pg_version) VALUES ($1, $2, 1)', ['a', 'o'],
    )).rejects.toMatchObject({ code: '23502' });
  });

  it('dual: set, bind, list and set again; another owner is refused; verify finds the stores equal', async () => {
    process.env[ENV] = 'dual';
    const owner = String(new Types.ObjectId());
    const other = String(new Types.ObjectId());
    const install = String(new Types.ObjectId());

    await setTakeover(owner, install, true);
    expect(await isTakeoverActive(owner, install)).toBe(true);
    await bindTarget(owner, install, 'target-1');
    expect(await listBindings(owner)).toEqual([{ installationId: install, targetId: 'target-1' }]);
    await setTakeover(owner, install, false);
    expect(await isTakeoverActive(owner, install)).toBe(false);

    await expect(setTakeover(other, install, true)).rejects.toMatchObject({ code: 11000 });
    await expect(bindTarget(other, install, 'evil')).rejects.toMatchObject({ code: 11000 });
    expect(await listBindings(other)).toEqual([]);

    const doc = await AgentComputerTakeover.findById(install).lean();
    expect(doc).toMatchObject({ active: false, targetId: 'target-1', pgVersion: 3 });
    const { rows } = await database.pool.query('SELECT * FROM agent_computer_takeovers');
    expect(rows).toEqual([{
      id: install,
      owner_id: owner,
      active: false,
      target_id: 'target-1',
      created_at: doc.createdAt,
      updated_at: doc.updatedAt,
      pg_version: 3,
    }]);
    const verified = await computerTakeoverStore().verify();
    expect(verified).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);

    // pg-read answers the same from the table.
    process.env[ENV] = 'pg-read';
    expect(await isTakeoverActive(owner, install)).toBe(false);
    expect(await listBindings(owner)).toEqual([{ installationId: install, targetId: 'target-1' }]);
    expect(await listBindings(other)).toEqual([]);
  });
});
