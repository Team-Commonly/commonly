/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * Case-insensitive account labels without collation. FerretDB ignores a
 * read's collation, so a check built on it passes a case-variant duplicate.
 * These run on the default in-memory Mongo and, with JEST_EXTERNAL_MONGO_URI pointed at
 * a FerretDB server, on FerretDB: the same answers on both stores.
 */
const fs = require('fs');
const nodePath = require('path');
const mongoose = require('mongoose');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  accountLabelClause, labelKey, labelKeysFor, LABEL_KEY_PATHS, TRIMMED_LABEL_FIELDS, IGNORABLE_CLASS,
  withLabelKeyWrites,
} = require('../../../models/accountLabelKeys');
const { isFreeUsername } = require('../../../services/derivedUsername');
const { backfillUserLabelKeys, runBackfillCli } = require('../../../scripts/backfill-user-label-keys');
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

  describe('a save writes only the keys of the labels it writes (B1)', () => {
    it('a user loaded with a partial select and saved keeps every key, and the checks still find it', async () => {
      const user = await User.create(human({
        username: 'Partial',
        displayName: 'Part Ial',
        previousUsernames: ['OldPart'],
        botMetadata: { displayName: 'P Bot' },
      }));
      const before = await keysOf(user._id);
      expect(before).toEqual({
        username: 'partial', previousUsernames: ['oldpart'], displayName: 'part ial', botDisplayName: 'p bot',
      });

      // As follow/unfollow does (userController): no label is in memory.
      const slim = await User.findById(user._id).select('_id username following');
      slim.following.push(new mongoose.Types.ObjectId());
      await slim.save();
      const slimmer = await User.findById(user._id).select('_id followedThreads');
      slimmer.followedThreads.push({ postId: new mongoose.Types.ObjectId() });
      await slimmer.save();

      expect(await keysOf(user._id)).toEqual(before);
      expect(await isFreeUsername('PARTIAL')).toBe(false);
      expect(await isFreeUsername('oldPART')).toBe(false);
      expect(await User.findOne(accountLabelClause('displayName', 'PART IAL')).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('botMetadata.displayName', 'p BOT')).lean()).not.toBeNull();
    });

    it('a partial save that writes one label rekeys that label alone, trimmed as the schema stores it', async () => {
      const user = await User.create(human({
        username: 'Solo', displayName: 'Before', botMetadata: { displayName: 'Bot' },
      }));
      const named = await User.findById(user._id).select('_id displayName');
      named.displayName = '  After Name  ';
      await named.save();
      expect(await keysOf(user._id)).toEqual({
        username: 'solo', previousUsernames: [], displayName: 'after name', botDisplayName: 'bot',
      });

      const nested = await User.findById(user._id).select('_id botMetadata.displayName');
      nested.botMetadata.displayName = 'Nested Bot';
      await nested.save();
      expect((await keysOf(user._id)).botDisplayName).toBe('nested bot');

      // The whole botMetadata replaced carries its displayName key.
      const whole = await User.findById(user._id).select('_id botMetadata.description');
      whole.botMetadata = { displayName: 'Whole Bot', description: 'd' };
      await whole.save();
      expect(await keysOf(user._id)).toEqual({
        username: 'solo', previousUsernames: [], displayName: 'after name', botDisplayName: 'whole bot',
      });
    });
  });

  describe('the key folds what the old collation folded (S1)', () => {
    it('full-width, combining vs precomposed accents, ligatures and Greek final sigma', () => {
      expect(labelKey('Ｌｉｌｙ')).toBe(labelKey('lily'));
      expect(labelKey('é')).toBe(labelKey('é'));
      expect(labelKey('Café')).toBe(labelKey('CAFÉ'));
      expect(labelKey('ﬁx')).toBe(labelKey('FIX')); // the ﬁ ligature
      expect(labelKey('ς')).toBe(labelKey('σ')); // ς and σ
      expect(labelKey('Σ')).toBe(labelKey('ς')); // Σ too
      expect(labelKey('lily')).not.toBe(labelKey('lilly'));
    });

    it('a check finds the holder across those forms', async () => {
      const holder = await User.create(human({ username: 'wide', displayName: 'Ｌｉｌｙ Οδός' }));
      const hit = await User.findOne(accountLabelClause('displayName', 'lily οδόσ')).select('_id').lean();
      expect(String(hit?._id)).toBe(String(holder._id));
    });

    it('the regex fallback matches a legacy label in its composed or decomposed spelling', async () => {
      await User.collection.insertOne({ ...human({ username: 'legacycafe', displayName: 'Café' }) });
      expect(await User.findOne(accountLabelClause('displayName', 'CAFÉ')).lean()).not.toBeNull();
    });
  });

  describe('the write paths that could leave a wrong key (S2)', () => {
    it('(a) TRIMMED_LABEL_FIELDS is exactly the labels the User schema trims', () => {
      const trimmedInSchema = Object.keys(LABEL_KEY_PATHS).filter((field) => {
        const path = User.schema.path(field);
        return Boolean(path.options.trim || path.caster?.options?.trim);
      });
      expect(trimmedInSchema.sort()).toEqual([...TRIMMED_LABEL_FIELDS].sort());
    });

    it('(a) an update keys the trimmed display name the schema stores', async () => {
      const user = await User.create(human({ username: 'trimmer' }));
      await User.updateOne({ _id: user._id }, { $set: { displayName: '  Spaced Out  ' } });
      const stored = await User.findById(user._id).lean();
      expect(stored.displayName).toBe('Spaced Out');
      expect(stored.labelKeys.displayName).toBe('spaced out');
      expect(await User.findOne(accountLabelClause('displayName', 'SPACED OUT')).lean()).not.toBeNull();
    });

    it('(b) replaceOne and findOneAndReplace key the replacement', async () => {
      const user = await User.create(human({ username: 'Replaced', displayName: 'Old' }));
      await User.replaceOne({ _id: user._id }, human({ username: 'NewHandle', previousUsernames: ['Replaced'] }));
      expect(await keysOf(user._id)).toEqual({
        username: 'newhandle', previousUsernames: ['replaced'], displayName: null, botDisplayName: null,
      });
      await User.findOneAndReplace({ _id: user._id }, human({ username: 'Third', displayName: ' Three ' }));
      expect(await keysOf(user._id)).toEqual({
        username: 'third', previousUsernames: [], displayName: 'three', botDisplayName: null,
      });
      await expect(User.replaceOne({ _id: user._id }, { ...human({ username: 'x' }), labelKeys: { username: 'y' } }))
        .rejects.toThrow(/labelKeys/);
    });

    it('(c) bulkWrite keys inserts, updates and replaces, and refuses what it cannot key', async () => {
      const existing = await User.create(human({ username: 'bulky' }));
      await User.bulkWrite([
        { insertOne: { document: human({ username: 'BulkIn', displayName: 'Bulk In' }) } },
        { updateOne: { filter: { _id: existing._id }, update: { $set: { displayName: ' Bulk Up ' } } } },
      ]);
      const inserted = await User.findOne({ username: 'BulkIn' }).lean();
      expect(inserted.labelKeys).toMatchObject({ username: 'bulkin', displayName: 'bulk in' });
      expect((await keysOf(existing._id)).displayName).toBe('bulk up');

      await User.bulkWrite([
        { replaceOne: { filter: { _id: existing._id }, replacement: human({ username: 'BulkRep' }) } },
      ]);
      expect((await keysOf(existing._id)).username).toBe('bulkrep');

      await expect(User.bulkWrite([
        { updateOne: { filter: { _id: existing._id }, update: { $pull: { previousUsernames: 'x' } } } },
      ])).rejects.toThrow(/\$pull/);
    });

    it('(d) refuses positional label writes and a $rename into or out of a label', async () => {
      const user = await User.create(human({ username: 'posy', previousUsernames: ['a1'] }));
      const id = { _id: user._id };
      await expect(User.updateOne(id, { $set: { 'previousUsernames.0': 'B1' } })).rejects.toThrow(/positional/);
      await expect(User.updateOne({ ...id, previousUsernames: 'a1' }, { $set: { 'previousUsernames.$': 'B1' } }))
        .rejects.toThrow(/positional/);
      await expect(User.updateOne(id, { $unset: { 'previousUsernames.0': 1 } })).rejects.toThrow(/positional/);
      await expect(User.updateOne(id, { $rename: { username: 'handle' } })).rejects.toThrow(/\$rename/);
      await expect(User.updateOne(id, { $rename: { bio: 'displayName' } })).rejects.toThrow(/\$rename/);
      await expect(User.updateOne(id, { $set: { 'labelKeys.username': 'forged' } })).rejects.toThrow(/labelKeys/);
      // A positive control: a non-label nested botMetadata write still goes through.
      await User.updateOne(id, { $set: { 'botMetadata.description': 'fine' } });
      expect(await keysOf(user._id)).toMatchObject({ username: 'posy', previousUsernames: ['a1'] });
    });

    it('(e) refuses $pull, $pullAll, $pop and a $push $slice on previousUsernames', async () => {
      const user = await User.create(human({ username: 'pully', previousUsernames: ['p1', 'p2'] }));
      const id = { _id: user._id };
      await expect(User.updateOne(id, { $pull: { previousUsernames: 'p1' } })).rejects.toThrow(/\$pull/);
      await expect(User.updateOne(id, { $pullAll: { previousUsernames: ['p1'] } })).rejects.toThrow(/\$pullAll/);
      await expect(User.updateOne(id, { $pop: { previousUsernames: 1 } })).rejects.toThrow(/\$pop/);
      await expect(User.updateOne(id, { $push: { previousUsernames: { $each: ['p3'], $slice: -1 } } }))
        .rejects.toThrow(/modifier/);
      expect(await keysOf(user._id)).toMatchObject({ previousUsernames: ['p1', 'p2'] });
    });

    it('an upsert keys a label it takes from the filter', async () => {
      await User.updateOne(
        { username: 'Upsy' },
        { $setOnInsert: { email: 'upsy@example.test', password: 'x'.repeat(60) } },
        { upsert: true },
      );
      expect((await User.findOne({ username: 'Upsy' }).lean()).labelKeys.username).toBe('upsy');
      expect(await isFreeUsername('upsy')).toBe(false);
    });
  });

  describe('a long label stays a query mongod accepts (the fallback regex has a size limit)', () => {
    it('80 compatibility characters, whose spellings expand, still find an unkeyed holder', async () => {
      const name = '\u33AF'.repeat(80);
      await User.collection.insertOne(human({ username: 'wide', displayName: name }));
      const found = await User.findOne(accountLabelClause('displayName', name)).lean();
      expect(found?.username).toBe('wide');
      const titled = '\u01C5'.repeat(80);
      await expect(User.findOne(accountLabelClause('displayName', titled)).lean()).resolves.toBeNull();
    });

    it('a 64-character username check runs, keyed and unkeyed', async () => {
      const long = `${'a'.repeat(63)}Z`;
      await User.collection.insertOne(human({ username: long }));
      expect(await isFreeUsername(long.toLowerCase())).toBe(false);
      expect(await isFreeUsername('b'.repeat(64))).toBe(true);
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

  describe('default-ignorable code points are invisible to the checks, as the old collation made them (H1)', () => {
    // Each one was refused beside its plain label under { locale: 'en', strength: 2 }.
    const IGNORABLES = [
      ['U+200B zero-width space', '\u200B'],
      ['U+00AD soft hyphen', '\u00AD'],
      ['U+200D zero-width joiner', '\u200D'],
      ['U+FE0F variation selector-16', '\uFE0F'],
      ['U+034F combining grapheme joiner', '\u034F'],
      ['U+2060 word joiner', '\u2060'],
      ['U+180E Mongolian vowel separator', '\u180E'],
    ];

    it('IGNORABLE_CLASS is exactly \\p{Default_Ignorable_Code_Point}', () => {
      const listed = new RegExp(`^${IGNORABLE_CLASS}$`, 'u');
      const property = /^\p{Default_Ignorable_Code_Point}$/u;
      const mismatched = [];
      for (let cp = 0; cp <= 0x10ffff; cp += 1) {
        if (cp < 0xd800 || cp > 0xdfff) {
          const ch = String.fromCodePoint(cp);
          if (listed.test(ch) !== property.test(ch)) mismatched.push(cp.toString(16));
        }
      }
      expect(mismatched).toEqual([]);
    });

    it.each(IGNORABLES)('%s: keyed users are found across it, both ways', async (_name, ch) => {
      expect(labelKey(`sam${ch}`)).toBe('sam');
      expect(labelKey(`Li${ch}ly`)).toBe('lily');
      await User.create(human({ username: 'sam', displayName: 'Lily', botMetadata: { displayName: `Bo${ch}t` } }));
      expect(await isFreeUsername(`sam${ch}`)).toBe(false);
      expect(await User.findOne(accountLabelClause('username', `${ch}SAM`)).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('displayName', `Lily${ch}`)).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('displayName', `L${ch}ILY`)).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('botMetadata.displayName', 'bot')).lean()).not.toBeNull();
    });

    it.each(IGNORABLES)('%s: the regex fallback finds an unkeyed user across it, both ways', async (_name, ch) => {
      await User.collection.insertMany([
        human({ username: 'plain', displayName: 'Lily' }),
        human({ username: `hid${ch}den`, displayName: `Ro${ch}se${ch}` }),
      ]);
      expect(await User.findOne(accountLabelClause('displayName', `Lily${ch}`)).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('displayName', `L${ch}ILY`)).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('username', `PLAIN${ch}`)).lean()).not.toBeNull();
      expect(await User.findOne(accountLabelClause('displayName', 'ROSE')).lean()).not.toBeNull();
      expect(await isFreeUsername('hidden')).toBe(false);
      expect(await User.findOne(accountLabelClause('displayName', 'Rosa')).lean()).toBeNull();
    });
  });

  describe('scripts that write labels through a plugin-less schema write the keys too (M1)', () => {
    const SCRIPTS = [
      'dedupe-agent-display-names.ts',
      'repair-first-party-labels.ts',
      'strip-opaque-displayname-suffixes.ts',
      'migrate-guide-to-scout.ts',
    ];

    it.each(SCRIPTS)('%s keys every User.updateOne it makes', (file) => {
      const source = fs.readFileSync(nodePath.join(__dirname, '../../../scripts', file), 'utf8');
      const calls = source.split('User.updateOne(').slice(1);
      expect(calls.length).toBeGreaterThan(0);
      calls.forEach((call) => expect(call.slice(0, call.indexOf(');'))).toMatch(/withLabelKeyWrites\(\{ \$set:/));
    });

    it('a label written that way is found by the check, where a bare $set left it unprotected', async () => {
      const Raw = mongoose.models.ScriptUser
        || mongoose.model('ScriptUser', new mongoose.Schema({}, { strict: false }), 'users');
      const bot = await User.create(human({ username: 'pixel-demo', botMetadata: { displayName: 'Pixel' } }));
      await Raw.updateOne({ _id: bot._id }, withLabelKeyWrites({ $set: { 'botMetadata.displayName': 'Pixel (Demo)' } }));
      expect(await User.findOne(accountLabelClause('botMetadata.displayName', 'PIXEL (DEMO)')).lean()).not.toBeNull();
      await Raw.updateOne({ _id: bot._id }, withLabelKeyWrites({ $set: { username: 'scout-x', 'botMetadata.agentName': 'scout' } }));
      expect(await isFreeUsername('SCOUT-X')).toBe(false);
    });
  });

  describe('an add to previousUsernames on an unkeyed user keeps the older names reserved (M2)', () => {
    const legacy = async () => (await User.collection.insertOne({
      ...human({ username: 'bob' }), previousUsernames: ['Elder', 'bobby'],
    })).insertedId;

    it('a rename as userController does it: $set username, $addToSet the old one', async () => {
      const id = await legacy();
      await User.findOneAndUpdate({ _id: id }, { $set: { username: 'bob2' }, $addToSet: { previousUsernames: 'bob' } });
      expect((await keysOf(id)).previousUsernames).toEqual(['elder', 'bobby', 'bob']);
      expect(await isFreeUsername('ELDER')).toBe(false);
      expect(await isFreeUsername('Bobby')).toBe(false);
      expect(await isFreeUsername('BOB')).toBe(false);
    });

    it('updateMany and bulkWrite $push key the whole array first too', async () => {
      const id = await legacy();
      await User.updateMany({ _id: id }, { $push: { previousUsernames: 'p1' } });
      expect((await keysOf(id)).previousUsernames).toEqual(['elder', 'bobby', 'p1']);
      const other = (await User.collection.insertOne({ ...human({ username: 'al' }), previousUsernames: ['Old'] })).insertedId;
      await User.bulkWrite([{ updateOne: { filter: { _id: other }, update: { $addToSet: { previousUsernames: 'al' } } } }]);
      expect((await keysOf(other)).previousUsernames).toEqual(['old', 'al']);
    });

    it('a keyed user is added to as before', async () => {
      const user = await User.create(human({ username: 'kay', previousUsernames: ['K1'] }));
      await User.updateOne({ _id: user._id }, { $addToSet: { previousUsernames: 'K2' } });
      expect((await keysOf(user._id)).previousUsernames).toEqual(['k1', 'k2']);
    });

    it('a save that sets one element rekeys the array', async () => {
      const user = await User.create(human({ username: 'el', previousUsernames: ['First', 'Second'] }));
      const loaded = await User.findById(user._id);
      loaded.previousUsernames.set(0, 'Replaced');
      await loaded.save();
      expect((await keysOf(user._id)).previousUsernames).toEqual(['replaced', 'second']);
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

  describe('the backfill CLI', () => {
    it('--verify fails on missing keys; --apply --verify writes, then verifies the fresh counts', async () => {
      await User.collection.insertOne(human({ username: 'Unkeyed' }));
      const lines = [];
      expect(await runBackfillCli(['--verify'], (line) => lines.push(line))).toBe(1);
      expect(await runBackfillCli(['--apply', '--verify'], (line) => lines.push(line))).toBe(0);
      expect(JSON.parse(lines[1])).toMatchObject({ mode: 'apply', missing: 1, written: 1 });
      expect(JSON.parse(lines[2])).toMatchObject({ mode: 'verify', missing: 0, stale: 0 });
      expect(await runBackfillCli(['--verify'], () => {})).toBe(0);
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
