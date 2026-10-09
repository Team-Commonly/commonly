process.env.PG_HOST = '';

const { spawnSync } = require('child_process');
const path = require('path');
const mongoose = require('mongoose');
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
//
// The two database states below are the two sides of the ordering guard, and
// the difference between them is what makes a run safe or not: a database where
// only the legacy index exists is one the new code has not booted against, and
// dropping there removes the deployed code's 11000 backstop. `seedLegacyIndex`
// is that state; `seedDeployedIndexes` adds the pair index the deploy's boot
// creates.
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

  const seedDeployedIndexes = async () => {
    // What a deploy leaves behind: boot has created the declared pair index
    // while the legacy one survives, because autoIndex creates and never drops.
    await seedLegacyIndex();
    await Task.createIndexes();
  };

  beforeEach(async () => {
    await clearMongoDb();
    await seedLegacyIndex();
  });

  it('reports the legacy index, would withhold the drop, and changes nothing on a dry run', async () => {
    const result = await migrateTaskSourceRefIdentity({ dryRun: true });

    expect(result).toMatchObject({
      dryRun: true,
      legacyIndexPresent: true,
      pairIndexPresentBefore: false,
      pairIndexPresentAfter: false,
      droppedLegacy: false,
      dropWithheld: true,
    });
    const names = await indexNames();
    expect(names).toContain(LEGACY_INDEX);
    expect(names).not.toContain(PAIR_INDEX);
  });

  it('withholds the drop while the pair index is absent, and writes nothing at all', async () => {
    const result = await migrateTaskSourceRefIdentity();

    expect(result).toMatchObject({
      dryRun: false,
      legacyIndexPresent: true,
      pairIndexPresentBefore: false,
      pairIndexPresentAfter: false,
      droppedLegacy: false,
      dropWithheld: true,
    });
    // The assertions that matter, and the reason the withheld path returns
    // before createIndexes(): if this run created the pair index, the NEXT run
    // would see it, pass the guard, and drop the legacy index — the guard would
    // authorise itself instead of waiting for the deploy.
    const names = await indexNames();
    expect(names).toContain(LEGACY_INDEX);
    expect(names).not.toContain(PAIR_INDEX);

    const second = await migrateTaskSourceRefIdentity();
    expect(second.dropWithheld).toBe(true);
    expect(await indexNames()).toContain(LEGACY_INDEX);
  });

  it('drops it once the pair index is visible, which is the state a deploy leaves behind', async () => {
    await seedDeployedIndexes();

    const result = await migrateTaskSourceRefIdentity();

    expect(result).toMatchObject({
      dryRun: false,
      legacyIndexPresent: true,
      pairIndexPresentBefore: true,
      pairIndexPresentAfter: true,
      droppedLegacy: true,
      dropWithheld: false,
    });
    const names = await indexNames();
    expect(names).not.toContain(LEGACY_INDEX);
    expect(names).toContain(PAIR_INDEX);
  });

  it('drops it on --force while the pair index is still absent', async () => {
    const result = await migrateTaskSourceRefIdentity({ force: true });

    expect(result).toMatchObject({
      legacyIndexPresent: true,
      pairIndexPresentBefore: false,
      pairIndexPresentAfter: true,
      droppedLegacy: true,
      dropWithheld: false,
    });
    const names = await indexNames();
    expect(names).not.toContain(LEGACY_INDEX);
    expect(names).toContain(PAIR_INDEX);
  });

  // The CLI is the artifact an operator runs, and its wiring is not covered by
  // calling the exported function: an earlier version of this change parsed
  // --force in main() and then passed only { dryRun } to the migration, which
  // eslint caught and no unit test could have. Both flags are exercised in a
  // child process, against the same database this suite runs on.
  const runCli = (...args) => spawnSync(
    process.execPath,
    [
      require.resolve('ts-node/dist/bin.js'),
      'scripts/migrate-task-source-ref-identity.ts',
      ...args,
    ],
    {
      cwd: path.join(__dirname, '../..'),
      encoding: 'utf8',
      timeout: 120000,
      env: {
        ...process.env,
        MONGO_URI: `mongodb://${mongoose.connection.host}:${mongoose.connection.port}/${mongoose.connection.name}`,
      },
    },
  );

  // The guard's evidence is a database fact, and the one thing positioned to
  // destroy it quietly is the script's own process: `--dry` prints "no changes
  // written", and `mongoose.set('autoIndex', false)` in the script is what makes
  // that true. Measured with autoIndex left on, this dry run left
  // `podId_1_sourceRef_1_title_1_partial` and `podId_1_taskId_1` behind — the
  // script created the very index its guard reads as "the code that replaces the
  // legacy index is live", and the next run would then drop.
  it('leaves the database untouched on --dry when run the way an operator runs it', async () => {
    // clearMongoDb deletes documents and leaves indexes, so a sibling test that
    // ran Task.createIndexes() would otherwise leave the declared indexes in
    // `before` and make this assertion insensitive to what the child creates.
    // Which is not hypothetical: the first version of this test passed with
    // autoIndex switched back on for exactly that reason.
    await Task.collection.drop().catch(() => {});
    await seedLegacyIndex();
    const before = (await indexNames()).sort();
    expect(before.filter((name) => name !== '_id_')).toEqual([LEGACY_INDEX]);

    const child = runCli('--dry');

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('DRY-RUN');
    expect(child.stdout).toContain('dropWithheld=true');
    // No index this script did not intend, and in particular not the one the
    // guard reads as "the deploy has booted here".
    expect((await indexNames()).sort()).toEqual(before);
  });

  it('drops it on --force when run the way an operator runs it', async () => {
    await Task.collection.drop().catch(() => {});
    await seedLegacyIndex();

    const child = runCli('--force');

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toContain('droppedLegacy=true');
    expect(child.stdout).toContain('dropWithheld=false');
    const names = await indexNames();
    expect(names).not.toContain(LEGACY_INDEX);
    expect(names).toContain(PAIR_INDEX);
  });

  it('is idempotent, and the pair index is what a second ask needs', async () => {
    await seedDeployedIndexes();
    await migrateTaskSourceRefIdentity();
    const second = await migrateTaskSourceRefIdentity();
    expect(second).toMatchObject({
      legacyIndexPresent: false,
      pairIndexPresentBefore: true,
      pairIndexPresentAfter: true,
      droppedLegacy: false,
      dropWithheld: false,
    });

    const podId = new mongoose.Types.ObjectId();
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
