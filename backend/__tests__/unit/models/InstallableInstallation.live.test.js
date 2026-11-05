// The derived `live` flag behind installable_live_target_unique_v2.
//
// FerretDB refuses `$in` in a partial index filter, so the live-target unique
// index filters on `live: true` instead. That only holds if `live` matches
// `status` after every write path the code uses; these tests pin each one,
// plus the index behaviour and the backfill for rows written before the flag.

const mongoose = require('mongoose');

const InstallableInstallation = require('../../../models/InstallableInstallation');
const {
  backfillInstallationLive,
  countLiveMismatches,
} = require('../../../scripts/backfill-installation-live');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

const { LIVE_INSTALLATION_STATUSES } = InstallableInstallation;
const ALL_STATUSES = [
  'installing', 'activating', 'uninstalling', 'active', 'paused', 'uninstalled', 'error', 'stale',
];
const NOT_LIVE = ALL_STATUSES.filter((s) => !LIVE_INSTALLATION_STATUSES.includes(s));

const baseDoc = (overrides = {}) => ({
  installableId: 'slack',
  installableVersion: '1.0.0',
  targetType: 'user',
  targetId: new mongoose.Types.ObjectId(),
  scope: 'user',
  installedBy: new mongoose.Types.ObjectId(),
  installSource: 'ui',
  ...overrides,
});

const rawLive = async (_id) => {
  const row = await InstallableInstallation.collection.findOne({ _id });
  return { status: row.status, live: row.live };
};

const expectConsistent = async (_id) => {
  const { status, live } = await rawLive(_id);
  expect(live).toBe(LIVE_INSTALLATION_STATUSES.includes(status));
  return { status, live };
};

describe('InstallableInstallation.live', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await InstallableInstallation.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  afterEach(async () => {
    await clearMongoDb();
  });

  it('declares the live set the legacy $in index used', () => {
    expect([...LIVE_INSTALLATION_STATUSES].sort()).toEqual(
      ['activating', 'active', 'error', 'installing', 'paused', 'uninstalling'],
    );
    expect(NOT_LIVE.sort()).toEqual(['stale', 'uninstalled']);
  });

  it('builds the v2 index on live: true alongside the legacy one', async () => {
    const indexes = await InstallableInstallation.collection.indexes();
    const v2 = indexes.find((i) => i.name === 'installable_live_target_unique_v2');
    expect(v2).toMatchObject({
      unique: true,
      key: { installableId: 1, targetType: 1, targetId: 1 },
      partialFilterExpression: { live: true },
    });
    expect(indexes.find((i) => i.name === 'installable_live_target_unique')).toBeTruthy();
  });

  describe('document writes', () => {
    it.each(ALL_STATUSES)('create with status %s', async (status) => {
      const doc = await InstallableInstallation.create(baseDoc({ status }));
      const { live } = await expectConsistent(doc._id);
      expect(live).toBe(!NOT_LIVE.includes(status));
    });

    it('create with the default status is live', async () => {
      const doc = await InstallableInstallation.create(baseDoc());
      expect(await rawLive(doc._id)).toEqual({ status: 'active', live: true });
    });

    it('save flips live in both directions', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      doc.status = 'uninstalled';
      await doc.save();
      expect(await rawLive(doc._id)).toEqual({ status: 'uninstalled', live: false });
      doc.status = 'error';
      await doc.save();
      expect(await rawLive(doc._id)).toEqual({ status: 'error', live: true });
    });

    it('save with validateBeforeSave: false still derives live', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      doc.status = 'stale';
      await doc.save({ validateBeforeSave: false });
      expect(await rawLive(doc._id)).toEqual({ status: 'stale', live: false });
    });

    it('a hand-set live is overwritten by the derivation', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'uninstalled', live: true }));
      expect(await rawLive(doc._id)).toEqual({ status: 'uninstalled', live: false });
    });

    it('insertMany derives live per document', async () => {
      const docs = await InstallableInstallation.insertMany([
        baseDoc({ status: 'paused' }),
        baseDoc({ status: 'stale' }),
      ]);
      await expectConsistent(docs[0]._id);
      await expectConsistent(docs[1]._id);
    });
  });

  describe('query writes', () => {
    it('updateOne $set.status, both directions (reconciler sites)', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'uninstalling', claimId: 'c1' }));
      await InstallableInstallation.updateOne(
        { _id: doc._id, status: 'uninstalling', claimId: 'c1' },
        { $set: { status: 'uninstalled', errorMessage: null } },
      );
      expect(await rawLive(doc._id)).toEqual({ status: 'uninstalled', live: false });
      await InstallableInstallation.updateOne({ _id: doc._id }, { $set: { status: 'activating' } });
      expect(await rawLive(doc._id)).toEqual({ status: 'activating', live: true });
    });

    it('updateOne with a spread error helper ($set status: error)', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'uninstalled' }));
      await InstallableInstallation.updateOne(
        { _id: doc._id },
        {
          $set: {
            status: 'error',
            errorMessage: 'x',
            errorMessageUserFacing: true,
            'components.$[].status': 'stale',
          },
        },
      );
      expect(await rawLive(doc._id)).toEqual({ status: 'error', live: true });
    });

    it('updateOne with a bare top-level status', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await InstallableInstallation.updateOne({ _id: doc._id }, { status: 'stale' });
      expect(await rawLive(doc._id)).toEqual({ status: 'stale', live: false });
    });

    it('updateMany $set.status, both directions', async () => {
      const a = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      const b = await InstallableInstallation.create(baseDoc({ status: 'paused' }));
      await InstallableInstallation.updateMany({ _id: { $in: [a._id, b._id] } }, { $set: { status: 'stale' } });
      expect((await rawLive(a._id)).live).toBe(false);
      expect((await rawLive(b._id)).live).toBe(false);
      await InstallableInstallation.updateMany({ _id: { $in: [a._id, b._id] } }, { $set: { status: 'paused' } });
      expect((await rawLive(a._id)).live).toBe(true);
      expect((await rawLive(b._id)).live).toBe(true);
    });

    it('findOneAndUpdate $set.status, both directions (pause/resume/uninstall sites)', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      const paused = await InstallableInstallation.findOneAndUpdate(
        { _id: doc._id, status: 'active' },
        { $set: { status: 'paused' } },
        { new: true },
      );
      expect(paused.live).toBe(true);
      await InstallableInstallation.findOneAndUpdate(
        { _id: doc._id },
        { $set: { status: 'uninstalled', errorMessage: null } },
        { new: true },
      );
      expect(await rawLive(doc._id)).toEqual({ status: 'uninstalled', live: false });
      await InstallableInstallation.findByIdAndUpdate(doc._id, { $set: { status: 'uninstalling' } });
      expect(await rawLive(doc._id)).toEqual({ status: 'uninstalling', live: true });
    });

    it('an update that does not touch status leaves live alone', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await InstallableInstallation.updateOne({ _id: doc._id }, { $set: { claimedAt: new Date() } });
      expect(await rawLive(doc._id)).toEqual({ status: 'active', live: true });
    });

    it('$unset.status clears live', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await InstallableInstallation.updateOne({ _id: doc._id }, { $unset: { status: 1 } });
      expect(await rawLive(doc._id)).toEqual({ status: undefined, live: false });
    });

    it('upsert with $setOnInsert.status', async () => {
      const targetId = new mongoose.Types.ObjectId();
      await InstallableInstallation.updateOne(
        { installableId: 'slack', targetType: 'user', targetId },
        { $setOnInsert: { ...baseDoc({ targetId }), status: 'uninstalled' } },
        { upsert: true },
      );
      const row = await InstallableInstallation.collection.findOne({ targetId });
      expect(row).toMatchObject({ status: 'uninstalled', live: false });
    });

    // The non-key required fields, for an upsert whose filter carries the key.
    const upsertSet = () => ({
      $set: {
        installableVersion: '1.0.0',
        scope: 'user',
        installedBy: new mongoose.Types.ObjectId(),
        installSource: 'ui',
      },
    });

    it('upsert whose status comes from the schema default', async () => {
      const targetId = new mongoose.Types.ObjectId();
      await InstallableInstallation.updateOne(
        { installableId: 'slack', targetType: 'user', targetId },
        upsertSet(),
        { upsert: true },
      );
      const row = await InstallableInstallation.collection.findOne({ targetId });
      expect(row).toMatchObject({ status: 'active', live: true });
    });

    it('upsert whose status comes from a filter equality', async () => {
      const targetId = new mongoose.Types.ObjectId();
      await InstallableInstallation.updateOne(
        {
          installableId: 'slack', targetType: 'user', targetId, status: 'uninstalled',
        },
        upsertSet(),
        { upsert: true },
      );
      const row = await InstallableInstallation.collection.findOne({ targetId });
      expect(row).toMatchObject({ status: 'uninstalled', live: false });
    });

    // The install claim in installableInstallationService.claimInstallation:
    // a pipeline findOneAndUpdate, upsert, whose status is a $cond on the old one.
    const claimPipeline = (targetId) => [{
      $set: {
        installableVersion: '1.0.0',
        scope: 'user',
        installedBy: new mongoose.Types.ObjectId(),
        installSource: 'ui',
        status: {
          $cond: [
            { $eq: ['$status', 'activating'] },
            'activating',
            { $cond: [{ $eq: ['$status', 'uninstalling'] }, 'uninstalling', 'installing'] },
          ],
        },
        claimId: 'claim',
        claimedAt: new Date(),
        targetId,
      },
    }];

    it('pipeline findOneAndUpdate upsert inserts a live row (claim, fresh target)', async () => {
      const targetId = new mongoose.Types.ObjectId();
      const row = await InstallableInstallation.findOneAndUpdate(
        {
          installableId: 'slack',
          targetType: 'user',
          targetId,
          $or: [{ status: 'error' }, { status: { $exists: false } }],
        },
        claimPipeline(targetId),
        { new: true, upsert: true },
      );
      expect(row.status).toBe('installing');
      expect(row.live).toBe(true);
    });

    it('pipeline findOneAndUpdate re-claims an error row and keeps it live', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'error' }));
      const row = await InstallableInstallation.findOneAndUpdate(
        { _id: doc._id, status: 'error' },
        claimPipeline(doc.targetId),
        { new: true },
      );
      expect(row.status).toBe('installing');
      await expectConsistent(doc._id);
    });

    it('pipeline update recomputes live in the not-live direction', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await InstallableInstallation.updateOne(
        { _id: doc._id },
        [{ $set: { status: { $cond: [{ $eq: ['$status', 'active'] }, 'uninstalled', '$status'] } } }],
      );
      expect(await rawLive(doc._id)).toEqual({ status: 'uninstalled', live: false });
    });

    it('a pipeline upsert that inserts an existing live target is refused (claim loser path)', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await expect(InstallableInstallation.findOneAndUpdate(
        {
          installableId: doc.installableId,
          targetType: doc.targetType,
          targetId: doc.targetId,
          $or: [{ status: 'error' }, { status: { $exists: false } }],
        },
        claimPipeline(doc.targetId),
        { new: true, upsert: true },
      )).rejects.toMatchObject({ code: 11000 });
    });

    it('replaceOne derives live from the replacement', async () => {
      const doc = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await InstallableInstallation.replaceOne({ _id: doc._id }, baseDoc({ targetId: doc.targetId, status: 'stale' }));
      expect(await rawLive(doc._id)).toEqual({ status: 'stale', live: false });
    });
  });

  describe('uniqueness', () => {
    it('refuses a second live installation for the same target', async () => {
      const first = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await expect(InstallableInstallation.create(baseDoc({ targetId: first.targetId, status: 'error' })))
        .rejects.toMatchObject({ code: 11000 });
    });

    it.each(NOT_LIVE)('allows a %s row beside a live one', async (status) => {
      const first = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      await expect(InstallableInstallation.create(baseDoc({ targetId: first.targetId, status })))
        .resolves.toBeTruthy();
      await expect(InstallableInstallation.create(baseDoc({ targetId: first.targetId, status })))
        .resolves.toBeTruthy();
    });

    it('refuses an update that makes a second row live', async () => {
      const first = await InstallableInstallation.create(baseDoc({ status: 'active' }));
      const old = await InstallableInstallation.create(baseDoc({ targetId: first.targetId, status: 'uninstalled' }));
      await expect(InstallableInstallation.updateOne({ _id: old._id }, { $set: { status: 'error' } }))
        .rejects.toMatchObject({ code: 11000 });
    });

    it('the v2 index alone refuses the duplicate (legacy index dropped, as on FerretDB)', async () => {
      await InstallableInstallation.collection.dropIndex('installable_live_target_unique');
      try {
        const first = await InstallableInstallation.create(baseDoc({ status: 'paused' }));
        await expect(InstallableInstallation.create(baseDoc({ targetId: first.targetId, status: 'installing' })))
          .rejects.toMatchObject({ code: 11000 });
        await expect(InstallableInstallation.create(baseDoc({ targetId: first.targetId, status: 'uninstalled' })))
          .resolves.toBeTruthy();
      } finally {
        await InstallableInstallation.syncIndexes();
      }
    });
  });

  describe('backfill-installation-live', () => {
    it('fixes stale rows, then verify reports 0 and a re-run writes nothing', async () => {
      // Rows written before the flag existed, plus hand-corrupted ones; raw
      // inserts bypass the hooks.
      const raw = (status, live) => {
        const doc = { ...baseDoc(), status };
        if (live !== undefined) doc.live = live;
        return doc;
      };
      await InstallableInstallation.collection.insertMany([
        raw('active'),
        raw('error'),
        raw('uninstalled'),
        raw('stale', true),
        raw('paused', false),
        raw('installing', true),
        raw('uninstalled', false),
      ]);

      const dry = await backfillInstallationLive({ apply: false });
      expect(dry).toMatchObject({
        scanned: 7, wrongShouldBeLive: 3, wrongShouldNotBeLive: 2, setLive: 0,
      });
      expect(await countLiveMismatches()).toMatchObject({ wrongShouldBeLive: 3, wrongShouldNotBeLive: 2 });

      const applied = await backfillInstallationLive({ apply: true });
      expect(applied).toMatchObject({ setLive: 3, setNotLive: 2 });

      expect(await countLiveMismatches()).toEqual({ scanned: 7, wrongShouldBeLive: 0, wrongShouldNotBeLive: 0 });
      const rerun = await backfillInstallationLive({ apply: true });
      expect(rerun).toMatchObject({ setLive: 0, setNotLive: 0 });

      const rows = await InstallableInstallation.collection.find({}).toArray();
      rows.forEach((row) => expect(row.live).toBe(LIVE_INSTALLATION_STATUSES.includes(row.status)));
    });
  });
});
