/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * Case-insensitive account labels without collation. FerretDB ignores a
 * read's collation, so a check built on it passes a case-variant duplicate.
 * These run on the default in-memory Mongo and, with TEST_MONGO_URI pointed at
 * a FerretDB server, on FerretDB: the same answers on both stores.
 */
const mongoose = require('mongoose');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const { accountLabelClause, labelKeysFor } = require('../../../models/accountLabelKeys');
const { isFreeUsername } = require('../../../services/derivedUsername');
const { backfillUserLabelKeys } = require('../../../scripts/backfill-user-label-keys');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAccountNameConflict: jest.fn().mockResolvedValue(null),
}));

const human = (fields) => ({
  email: `${fields.username}@example.test`, password: 'x'.repeat(60), verified: true, ...fields,
});
const keysOf = async (id) => (await User.findById(id).select('labelKeys').lean()).labelKeys;

describe('account label keys', () => {
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await User.deleteMany({});
    await AgentInstallation.deleteMany({});
  });

  describe('the keys follow every write path', () => {
    it('save and create', async () => {
      const user = await User.create(human({ username: 'Sam', displayName: 'Sam X', previousUsernames: ['OldSam'] }));
      expect(await keysOf(user._id)).toEqual({
        username: 'sam', previousUsernames: ['oldsam'], displayName: 'sam x', botDisplayName: null,
      });
      user.displayName = 'SAMMY';
      await user.save();
      expect((await keysOf(user._id)).displayName).toBe('sammy');
    });

    it('insertMany', async () => {
      const [user] = await User.insertMany([human({ username: 'Ada', botMetadata: { displayName: 'Ada Bot' } })]);
      expect(await keysOf(user._id)).toMatchObject({ username: 'ada', botDisplayName: 'ada bot' });
    });

    it('updateOne, findOneAndUpdate and updateMany, by $set, a plain object, $unset, $addToSet and $push', async () => {
      const user = await User.create(human({ username: 'lin' }));
      await User.updateOne({ _id: user._id }, { $set: { username: 'Lin2' }, $addToSet: { previousUsernames: 'LIN' } });
      expect(await keysOf(user._id)).toMatchObject({ username: 'lin2', previousUsernames: ['lin'] });

      await User.findOneAndUpdate({ _id: user._id }, { displayName: 'Lin Display' });
      expect((await keysOf(user._id)).displayName).toBe('lin display');

      await User.updateMany({ _id: user._id }, { $set: { botMetadata: { displayName: 'Lin Agent' } } });
      expect((await keysOf(user._id)).botDisplayName).toBe('lin agent');
      await User.updateOne({ _id: user._id }, { $set: { 'botMetadata.displayName': 'LA' } });
      expect((await keysOf(user._id)).botDisplayName).toBe('la');

      await User.updateOne({ _id: user._id }, { $push: { previousUsernames: { $each: ['X1', 'x2'] } } });
      expect((await keysOf(user._id)).previousUsernames).toEqual(['lin', 'x1', 'x2']);

      await User.updateOne({ _id: user._id }, { $unset: { displayName: 1 } });
      expect((await keysOf(user._id)).displayName).toBeNull();
    });

    it('refuses a pipeline update that writes a label, rather than leave its key stale', async () => {
      const user = await User.create(human({ username: 'pipe' }));
      await expect(User.updateOne({ _id: user._id }, [{ $set: { username: 'PIPE2' } }])).rejects.toThrow(/pipeline/);
      expect(labelKeysFor({ username: 'PIPE' }).username).toBe('pipe');
    });
  });

  describe('a case-variant duplicate is refused', () => {
    it('isFreeUsername: a username or a previous username in any case', async () => {
      await User.create(human({ username: 'Sam', previousUsernames: ['Samuel'] }));
      expect(await isFreeUsername('sam')).toBe(false);
      expect(await isFreeUsername('SAM')).toBe(false);
      expect(await isFreeUsername('SAMUEL')).toBe(false);
      expect(await isFreeUsername('sam-2')).toBe(true);
    });

    it('a label check finds the holder in any case, for every label', async () => {
      const holder = await User.create(human({ username: 'Rex', displayName: 'Rex Ray', botMetadata: { displayName: 'Robo Rex' } }));
      const found = await Promise.all([['username', 'rEX'], ['displayName', 'REX RAY'], ['botMetadata.displayName', 'robo REX']]
        .map(([field, value]) => User.findOne(accountLabelClause(field, value)).select('_id').lean()));
      found.forEach((hit) => expect(String(hit?._id)).toBe(String(holder._id)));
      expect(await User.findOne(accountLabelClause('username', 're.')).lean()).toBeNull(); // a regex character is literal
    });

    it('still refuses one held by an account written before the keys existed (until the backfill)', async () => {
      // Written past Mongoose, as an older deploy left it: no labelKeys at all.
      await User.collection.insertOne({
        ...human({ username: 'Legacy', displayName: 'Old Name' }), previousUsernames: ['Elder'],
      });
      expect(await isFreeUsername('legacy')).toBe(false);
      expect(await isFreeUsername('ELDER')).toBe(false);
      expect(await User.findOne(accountLabelClause('displayName', 'OLD NAME')).lean()).not.toBeNull();
    });
  });

  describe('the backfill', () => {
    it('keys every older account, leaves keyed ones alone, and then verifies clean', async () => {
      const keyed = await User.create(human({ username: 'kept' }));
      await User.collection.insertMany([
        { ...human({ username: 'Old1', displayName: 'Ünïcode Näme' }), previousUsernames: ['P1'] },
        { ...human({ username: 'old2' }), botMetadata: { displayName: 'Bot Two' } },
      ]);
      await User.collection.updateOne({ _id: keyed._id }, { $set: { 'labelKeys.username': 'stale' } });

      expect(await backfillUserLabelKeys()).toMatchObject({
        scanned: 3, missing: 2, stale: 1, written: 0, 
      });
      expect(await backfillUserLabelKeys({ apply: true })).toMatchObject({ written: 3, raced: 0 });
      expect(await backfillUserLabelKeys()).toMatchObject({ missing: 0, stale: 0 });

      const old1 = await User.findOne({ username: 'Old1' }).lean();
      expect(old1.labelKeys).toEqual({
        username: 'old1', previousUsernames: ['p1'], displayName: 'ünïcode näme', botDisplayName: null,
      });
      expect((await keysOf(keyed._id)).username).toBe('kept');
    });
  });

  describe('runtime identities match in any case without collation', () => {
    it('stores instanceId lowercase and finds it by any case, including inside $in', async () => {
      await AgentInstallation.create({
        agentName: 'openclaw',
        instanceId: 'Nova',
        podId: new mongoose.Types.ObjectId(),
        version: '1.0.0',
        installedBy: new mongoose.Types.ObjectId(),
        status: 'active',
      });
      expect((await AgentInstallation.findOne({}).lean()).instanceId).toBe('nova');
      expect(await AgentInstallation.countDocuments({ agentName: 'OpenClaw', instanceId: 'NOVA' })).toBe(1);
      expect(await AgentInstallation.countDocuments({ agentName: { $in: ['x', 'OPENCLAW'] }, instanceId: 'nOvA' })).toBe(1);
      const res = await AgentInstallation.updateMany({ agentName: 'OPENCLAW', instanceId: 'Nova' }, { $set: { runtimeTokens: [] } });
      expect(res.matchedCount).toBe(1);
    });
  });
});
