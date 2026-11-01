/**
 * TASK-718 against a real mongod: the stamp is written as a string, a dry run
 * writes nothing, the apply writes only the frozen ids and derives each creator
 * from its row at apply time, a second apply of the same set is a no-op, an
 * existing stamp is never touched, and the write never overwrites a stamp that
 * landed between scan and write. The creator rule itself is in the unit test.
 */
process.env.PG_HOST = '';

const mongoose = require('mongoose');
const Task = require('../../models/Task');
const {
  backfillTaskCreatedBy,
  planBackfill,
  writeStamps,
} = require('../../scripts/backfill-task-created-by');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');

// A row as it sat before TASK-669: no createdByUserId key at all.
const legacyRow = (taskId, updates, extra = {}) => ({
  podId: new mongoose.Types.ObjectId(),
  taskNum: 1,
  taskId,
  title: `legacy ${taskId}`,
  status: 'pending',
  source: 'human',
  updates,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

// Production stores authorId as a string (models/Task.ts: type String).
const update = (text, authorId = null) => ({
  text, author: 'x', authorId, createdAt: new Date(),
});

const insert = async (doc) => (await Task.collection.insertOne(doc)).insertedId;

// The SRE flow: the dry run names the ids, and the apply takes exactly that set.
const dryRunIds = async () => (await backfillTaskCreatedBy({ apply: false }))
  .plan.toStamp.map((row) => String(row._id));

describe('backfill-task-created-by (service)', () => {
  beforeAll(async () => {
    await setupMongoDb();
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  beforeEach(async () => {
    await Task.collection.deleteMany({});
  });

  it('stamps a row whose first update is "Created by" with an author, as a string', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-001', [update('Created by wren · assigned to wren', wren)]));

    const summary = await backfillTaskCreatedBy({ apply: true, ids: await dryRunIds() });

    expect(summary.stamped).toBe(1);
    const row = await Task.collection.findOne({ _id });
    expect(row.createdByUserId).toBe(wren);
  });

  it('refuses an apply without a frozen id set, and writes nothing', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-005', [update('Created by wren', wren)]));

    await expect(backfillTaskCreatedBy({ apply: true })).rejects.toThrow('frozen id set');

    const row = await Task.collection.findOne({ _id });
    expect(row.createdByUserId ?? null).toBeNull();
  });

  it('applies only the frozen ids, even when another row is derivable', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const frozen = await insert(legacyRow('TASK-006', [update('Created by wren', wren)]));
    const unfrozen = await insert(legacyRow('TASK-007', [update('Created by wren', wren)]));

    const summary = await backfillTaskCreatedBy({ apply: true, ids: [String(frozen)] });

    expect(summary.stamped).toBe(1);
    expect((await Task.collection.findOne({ _id: frozen })).createdByUserId).toBe(wren);
    expect((await Task.collection.findOne({ _id: unfrozen })).createdByUserId ?? null).toBeNull();
  });

  it('derives the creator from the row at apply time, not from the dry run', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-008', [update('Created by wren', wren)]));
    expect(await dryRunIds()).toEqual([String(_id)]);
    // Between the dry run and the apply, the row's first update becomes a claim.
    await Task.collection.updateOne({ _id }, { $set: { updates: [update('Claimed by wren', wren)] } });

    const summary = await backfillTaskCreatedBy({ apply: true, ids: [String(_id)] });

    expect(summary.stamped).toBe(0);
    expect(summary.plan.leftNull.map((row) => row.reason)).toEqual(['no-created-by-first-update']);
    expect((await Task.collection.findOne({ _id })).createdByUserId ?? null).toBeNull();
  });

  it('counts a frozen id with no row as missing, and still applies the rest', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-009', [update('Created by wren', wren)]));
    const gone = String(new mongoose.Types.ObjectId());

    const summary = await backfillTaskCreatedBy({ apply: true, ids: [String(_id), gone] });

    expect(summary.plan.missing).toBe(1);
    expect(summary.stamped).toBe(1);
  });

  it('leaves every row it cannot attribute null, and counts why', async () => {
    const claimant = String(new mongoose.Types.ObjectId());
    const ids = await Promise.all([
      insert(legacyRow('TASK-002', [update('Claimed by wren', claimant), update('Created by lily-shen', claimant)])),
      insert(legacyRow('TASK-003', [update('Created by system', null)])),
      insert(legacyRow('TASK-004', [])),
    ]);

    const dry = await backfillTaskCreatedBy({ apply: false });
    expect(dry.plan.leftNull.map((row) => row.reason).sort()).toEqual([
      'created-by-without-author',
      'no-created-by-first-update',
      'no-created-by-first-update',
    ]);

    const summary = await backfillTaskCreatedBy({ apply: true, ids: ids.map((_id) => String(_id)) });

    expect(summary.stamped).toBe(0);
    expect(summary.plan.leftNull).toHaveLength(3);
    const rows = await Promise.all(ids.map((_id) => Task.collection.findOne({ _id })));
    rows.forEach((row) => expect(row.createdByUserId ?? null).toBeNull());
  });

  it('a dry run reports what it would stamp and writes nothing', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-010', [update('Created by wren', wren)]));

    const summary = await backfillTaskCreatedBy({ apply: false });

    expect(summary.apply).toBe(false);
    expect(summary.plan.toStamp).toHaveLength(1);
    expect(summary.stamped).toBe(0);
    const row = await Task.collection.findOne({ _id });
    expect(row.createdByUserId ?? null).toBeNull();
  });

  it('a second apply of the same frozen set is a no-op', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-020', [update('Created by wren', wren)]));
    const frozen = [String(_id)];
    await backfillTaskCreatedBy({ apply: true, ids: frozen });

    const again = await backfillTaskCreatedBy({ apply: true, ids: frozen });

    expect(again.plan.scanned).toBe(0);
    expect(again.plan.alreadyStamped).toBe(1);
    expect(again.stamped).toBe(0);
  });

  it('an existing stamp is never touched, even when the row derives another id', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-040', [update('Created by wren', wren)], { createdByUserId: 'original' }));

    const summary = await backfillTaskCreatedBy({ apply: true, ids: [String(_id)] });

    expect(summary.plan.alreadyStamped).toBe(1);
    expect(summary.plan.scanned).toBe(0);
    const row = await Task.collection.findOne({ _id });
    expect(row.createdByUserId).toBe('original');
  });

  it('never overwrites a stamp that landed between the scan and the write', async () => {
    const wren = String(new mongoose.Types.ObjectId());
    const _id = await insert(legacyRow('TASK-030', [update('Created by wren', wren)]));
    const plan = await planBackfill();
    expect(plan.toStamp).toHaveLength(1);
    // Another writer stamps the row after the scan and before the write.
    await Task.collection.updateOne({ _id }, { $set: { createdByUserId: 'winner' } });

    const written = await writeStamps(plan.toStamp);

    expect(written).toBe(0);
    const row = await Task.collection.findOne({ _id });
    expect(row.createdByUserId).toBe('winner');
  });
});
