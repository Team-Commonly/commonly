/**
 * The TASK-330 index migration (scripts/migrate-hosted-mcp-agent-index.js).
 * Before it runs, the old `(createdBy, entryId)` index refuses a second agent's
 * key with E11000. After it runs, that key saves, and the old index is gone.
 * Run against a real mongod, because the failure is an index, not a mock.
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

describe('the TASK-330 agent-scoped index migration', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await Integration.init();
  });

  beforeEach(async () => {
    await Integration.deleteMany({});
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  test('before the migration, the old index refuses a second agent key for the same person and entry', async () => {
    // Put the database in the production state: the old index present, the new
    // one absent. The old index is what this migration exists to remove.
    const agentIndex = (await Integration.collection.indexes())
      .find((index) => index.key.createdBy === 1 && index.key['config.agentId'] === 1);
    await Integration.collection.dropIndex(agentIndex.name);
    await Integration.collection.createIndex(
      { createdBy: 1, 'config.entryId': 1 },
      { unique: true, partialFilterExpression: { type: 'hosted-mcp' }, name: OLD_INDEX },
    );

    await Integration.create(keyFor('agent-a'));
    await expect(Integration.create(keyFor('agent-b'))).rejects.toMatchObject({ code: 11000 });
  });

  test('the migration drops the old index, builds the new one, and lets a second agent key save', async () => {
    await run({ apply: true });

    const names = await indexNames();
    expect(names).not.toContain(OLD_INDEX);
    expect(names.some((name) => name.includes('config.agentId'))).toBe(true);
    await expect(Integration.create(keyFor('agent-b'))).resolves.toBeDefined();
  });

  test('a second run is a no-op rather than an error', async () => {
    await run({ apply: true });
    await expect(run({ apply: true })).resolves.toBeUndefined();
    expect(await indexNames()).not.toContain(OLD_INDEX);
  });

  test('read-only by default: a dry run leaves the old index in place', async () => {
    await Integration.collection.createIndex(
      { createdBy: 1, 'config.entryId': 1 },
      { unique: true, partialFilterExpression: { type: 'hosted-mcp' }, name: OLD_INDEX },
    ).catch(() => {});
    await run({ apply: false });
    expect(await indexNames()).toContain(OLD_INDEX);
  });
});
