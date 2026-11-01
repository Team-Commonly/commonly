/**
 * The TASK-330 index migration (scripts/migrate-hosted-mcp-agent-index.js).
 * Before it runs, the old `(createdBy, entryId)` index refuses a second agent's
 * key with E11000. After it runs, that key saves, and the old index is gone.
 * Run against a real mongod, because the failure is an index, not a mock.
 *
 * Every arm seeds its own pre-migration state (old index present, new index
 * absent, agent-a's key saved) so no arm depends on another having run first.
 */
process.env.PG_HOST = '';

const mongoose = require('mongoose');
const Integration = require('../../models/Integration');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const { run, OLD_INDEX } = require('../../scripts/migrate-hosted-mcp-agent-index');

const OWNER = new mongoose.Types.ObjectId();
const keyFor = (agentId) => ({
  scope: 'user',
  type: 'hosted-mcp',
  status: 'connected',
  createdBy: OWNER,
  config: { entryId: 'latchkey', intake: 'operator_key', agentId },
});

const indexNames = async () => (await Integration.collection.indexes()).map((index) => index.name);

/** Put the database in the production state: the old index present, the agent-scoped one absent. */
const seedPreMigration = async () => {
  const agentIndex = (await Integration.collection.indexes())
    .find((index) => index.key.createdBy === 1 && index.key['config.agentId'] === 1);
  if (agentIndex) await Integration.collection.dropIndex(agentIndex.name);
  if (!(await indexNames()).includes(OLD_INDEX)) {
    await Integration.collection.createIndex(
      { createdBy: 1, 'config.entryId': 1 },
      { unique: true, partialFilterExpression: { type: 'hosted-mcp' }, name: OLD_INDEX },
    );
  }
};

describe('the TASK-330 agent-scoped index migration', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Integration.init();
  });

  beforeEach(async () => {
    await Integration.deleteMany({});
    await seedPreMigration();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  test('before the migration, the old index refuses a second agent key for the same person and entry', async () => {
    await Integration.create(keyFor('agent-a'));
    await expect(Integration.create(keyFor('agent-b'))).rejects.toMatchObject({ code: 11000 });
  });

  test('the migration builds the new index, drops the old one, and lets a second agent key save', async () => {
    await Integration.create(keyFor('agent-a'));

    await run({ apply: true });

    const names = await indexNames();
    expect(names).not.toContain(OLD_INDEX);
    expect(names.some((name) => name.includes('config.agentId'))).toBe(true);
    await expect(Integration.create(keyFor('agent-b'))).resolves.toBeDefined();
    // The migration deletes no rows: agent-a's key is still there.
    expect(await Integration.countDocuments({ 'config.agentId': 'agent-a' })).toBe(1);
  });

  test('a failed build leaves the old index in place, so uniqueness is never lost', async () => {
    jest.spyOn(Integration.collection, 'createIndex').mockRejectedValueOnce(new Error('build failed'));

    await expect(run({ apply: true })).rejects.toThrow('build failed');

    expect(await indexNames()).toContain(OLD_INDEX);
    await Integration.create(keyFor('agent-a'));
    await expect(Integration.create(keyFor('agent-b'))).rejects.toMatchObject({ code: 11000 });
  });

  test('a second run is a no-op rather than an error', async () => {
    await run({ apply: true });
    await expect(run({ apply: true })).resolves.toBeUndefined();
    expect(await indexNames()).not.toContain(OLD_INDEX);
  });

  test('read-only by default: a dry run leaves the old index in place', async () => {
    await run({ apply: false });
    expect(await indexNames()).toContain(OLD_INDEX);
  });
});
