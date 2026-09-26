process.env.PG_HOST = '';

const Task = require('../../models/Task');
const {
  migrateTaskSourceRefIdentity,
} = require('../../scripts/migrate-task-source-ref-identity');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

const LEGACY_INDEX = 'podId_1_sourceRef_1_partial';
const PAIR_INDEX = 'podId_1_sourceRef_1_title_1_partial';

// TASK-063's migration is load-bearing, not housekeeping: autoIndex CREATES the
// declared pair index but never DROPS the legacy ref-only index, and the legacy
// index is STRICTER — while it exists, a second ask under one sourceRef cannot
// be inserted at all (the route answers that with a named 503). So this
// exercises the drop/create against a real mongod rather than trusting the
// script's shape.
describe('migrate-task-source-ref-identity', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const indexNames = async () => {
    try {
      return (await Task.collection.indexes()).map((i) => String(i.name));
    } catch (error) {
      // A database that has never held a task has no `tasks` collection to list
      // indexes from, and mongod answers NamespaceNotFound (code 26).
      if (error.code === 26) return [];
      throw error;
    }
  };

  const seedLegacyIndex = async () => {
    // Reproduce a pre-TASK-063 database: the declared pair index absent, the
    // ref-only index present.
    const names = await indexNames();
    if (names.includes(PAIR_INDEX)) await Task.collection.dropIndex(PAIR_INDEX);
    if (!names.includes(LEGACY_INDEX)) {
      await Task.collection.createIndex(
        { podId: 1, sourceRef: 1 },
        { unique: true, name: LEGACY_INDEX, partialFilterExpression: { sourceRef: { $type: 'string' } } },
      );
    }
  };

  beforeEach(async () => {
    await clearMongoDb();
    await seedLegacyIndex();
  });

  it('reports the legacy index and changes nothing on a dry run', async () => {
    const result = await migrateTaskSourceRefIdentity({ dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      legacyIndexPresent: true,
      pairIndexPresentBefore: false,
      pairIndexPresentAfter: false,
      droppedLegacy: false,
    });
    const names = await indexNames();
    expect(names).toContain(LEGACY_INDEX);
    expect(names).not.toContain(PAIR_INDEX);
  });

  it('drops the legacy index and creates the pair index', async () => {
    const result = await migrateTaskSourceRefIdentity();

    expect(result).toMatchObject({
      dryRun: false,
      legacyIndexPresent: true,
      pairIndexPresentBefore: false,
      pairIndexPresentAfter: true,
      droppedLegacy: true,
    });
    const names = await indexNames();
    expect(names).not.toContain(LEGACY_INDEX);
    expect(names).toContain(PAIR_INDEX);
  });

  it('is idempotent, and the pair index is what a second ask needs', async () => {
    await migrateTaskSourceRefIdentity();
    const second = await migrateTaskSourceRefIdentity();
    expect(second).toMatchObject({
      legacyIndexPresent: false,
      pairIndexPresentBefore: true,
      pairIndexPresentAfter: true,
      droppedLegacy: false,
    });

    const podId = new (require('mongoose').Types.ObjectId)();
    const base = {
      podId,
      source: 'import',
      sourceRef: 'external:ticket:697',
      updates: [],
    };
    await Task.create({ ...base, taskNum: 1, taskId: 'TASK-001', title: 'First ask' });
    await Task.create({ ...base, taskNum: 2, taskId: 'TASK-002', title: 'Second ask' });

    expect(await Task.countDocuments({ podId, sourceRef: 'external:ticket:697' })).toBe(2);
  });
});
