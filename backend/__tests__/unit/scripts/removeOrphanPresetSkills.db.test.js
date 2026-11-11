// The script deletes production rows, so these arms pin what it leaves alone:
// a hand-imported skill of the same name, a preset skill outside the eight, a
// non-skill asset, and every row when ACTION is unset.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const {
  removeOrphanPresetSkills, exitCodeFor, tally, main, DEFAULT_BACKUP_COLLECTION,
} = require('../../../scripts/remove-orphan-preset-skills');

let mongod;
let db;
const podA = new mongoose.Types.ObjectId();
const podB = new mongoose.Types.ObjectId();

const asset = (podId, skillName, autoImportedBy, type = 'skill') => ({
  podId,
  type,
  title: `Skill: ${skillName}`,
  metadata: { skillName, scope: 'pod', ...(autoImportedBy ? { autoImportedBy } : {}) },
});

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
  ({ db } = mongoose.connection);
});
beforeEach(async () => {
  await db.collection('podassets').deleteMany({});
  await db.collection(DEFAULT_BACKUP_COLLECTION).deleteMany({});
  await db.collection('podassets').insertMany([
    asset(podA, 'github', 'preset.defaultSkills'),
    asset(podA, 'tavily', 'preset.defaultSkills'),
    asset(podB, 'github', 'preset.defaultSkills'),
    asset(podB, 'github', undefined), // imported by a person
    asset(podB, 'weather', 'preset.defaultSkills'), // not one of the eight
    asset(podB, 'github', 'preset.defaultSkills', 'note'), // not a skill
  ]);
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

const all = () => db.collection('podassets').find({}).toArray();
const sortById = (docs) => [...docs].sort((a, b) => String(a._id).localeCompare(String(b._id)));

describe('removeOrphanPresetSkills', () => {
  it.each([[undefined], [''], ['apply'], ['DELETE']])('ACTION=%p refuses and touches nothing', async (action) => {
    const r = await removeOrphanPresetSkills(db, { action });
    expect(r.action).toBe('refused');
    expect(exitCodeFor(r)).toBe(2);
    expect(r.matched).toBe(0);
    expect(await all()).toHaveLength(6);
    expect(await db.collection(DEFAULT_BACKUP_COLLECTION).countDocuments({})).toBe(0);
  });

  it('dry-run counts per skill and per pod and writes nothing', async () => {
    const r = await removeOrphanPresetSkills(db, { action: 'dry-run' });
    expect(r.matched).toBe(3);
    expect(r.perSkill).toEqual({ github: 2, tavily: 1 });
    expect(r.perPod).toEqual({ [String(podA)]: 2, [String(podB)]: 1 });
    expect(exitCodeFor(r)).toBe(0);
    expect(await all()).toHaveLength(6);
    expect(await db.collection(DEFAULT_BACKUP_COLLECTION).countDocuments({})).toBe(0);
  });

  it('delete backs up the matched rows whole, then removes only them', async () => {
    const before = await db.collection('podassets').find({ 'metadata.autoImportedBy': 'preset.defaultSkills', type: 'skill' }).toArray();
    const r = await removeOrphanPresetSkills(db, { action: 'delete' });
    expect(r).toMatchObject({
      action: 'delete', matched: 3, backedUp: 3, deleted: 3, remaining: 0, problem: null, 
    });
    expect(exitCodeFor(r)).toBe(0);

    const left = await all();
    expect(left.map((d) => `${d.type}:${d.metadata.skillName}:${d.metadata.autoImportedBy}`).sort()).toEqual([
      'note:github:preset.defaultSkills',
      'skill:github:undefined',
      'skill:weather:preset.defaultSkills',
    ]);

    const backup = await db.collection(DEFAULT_BACKUP_COLLECTION).find({}).toArray();
    const expected = before.filter((d) => d.metadata.skillName !== 'weather');
    expect(backup.sort((a, b) => String(a._id).localeCompare(String(b._id))))
      .toEqual(expected.sort((a, b) => String(a._id).localeCompare(String(b._id))));
  });

  it('the histogram and both breakdowns are computed from the rows and reconcile to matched', async () => {
    const r = await removeOrphanPresetSkills(db, { action: 'dry-run' });
    expect(tally(r)).toEqual({
      histogram: { 1: 1, 2: 1 }, pods: 2, podRows: 3, skillRows: 3, reconciles: true,
    });
    expect(tally({ ...r, matched: 4 }).reconciles).toBe(false);
  });

  it('a restore from the backup is one insertMany and gives back the same documents', async () => {
    const original = await all();
    await removeOrphanPresetSkills(db, { action: 'delete' });
    const backup = await db.collection(DEFAULT_BACKUP_COLLECTION).find({}).toArray();
    await db.collection('podassets').insertMany(backup);
    expect(sortById(await all())).toEqual(sortById(original));
  });

  it('BACKUP_FILE is Extended JSON that restores ObjectIds and Dates typed', async () => {
    await db.collection('podassets').updateMany({}, { $set: { createdAt: new Date('2026-05-01T00:00:00Z') } });
    const original = await all();
    const file = path.join(os.tmpdir(), `f415-backup-${process.pid}.json`);
    const r = await removeOrphanPresetSkills(db, { action: 'delete', backupFile: file });
    expect(r.backupFile).toBe(file);
    const docs = mongoose.mongo.BSON.EJSON.parse(fs.readFileSync(file, 'utf8'), { relaxed: false });
    fs.unlinkSync(file);
    expect(docs).toHaveLength(3);
    expect(docs[0]._id).toBeInstanceOf(mongoose.mongo.ObjectId);
    expect(docs[0].createdAt).toBeInstanceOf(Date);
    await db.collection('podassets').insertMany(docs);
    expect(sortById(await all())).toEqual(sortById(original));
  });

  it('a row a person re-imports between the find and the delete survives', async () => {
    const target = await db.collection('podassets').findOne({ 'metadata.skillName': 'tavily' });
    const assets = db.collection('podassets');
    const racing = {
      collection: (name) => {
        if (name !== 'podassets') return db.collection(name);
        return {
          ...assets,
          countDocuments: (q) => assets.countDocuments(q),
          insertMany: (d, o) => assets.insertMany(d, o),
          find: (q) => ({
            toArray: async () => {
              const docs = await assets.find(q).toArray();
              // the upsert rewrites metadata whole, so autoImportedBy goes
              await assets.updateOne({ _id: target._id }, { $set: { metadata: { skillName: 'tavily', scope: 'pod' } } });
              return docs;
            },
          }),
          deleteMany: (q) => assets.deleteMany(q),
        };
      },
    };
    const r = await removeOrphanPresetSkills(racing, { action: 'delete' });
    expect(r).toMatchObject({ matched: 3, backedUp: 3, deleted: 2 });
    expect(r.problem).toMatch(/deleted 2 of 3/);
    expect(exitCodeFor(r)).toBe(3);
    expect(await assets.findOne({ _id: target._id })).not.toBeNull();
  });

  it('a second delete finds nothing and does not touch the backup', async () => {
    await removeOrphanPresetSkills(db, { action: 'delete' });
    const r = await removeOrphanPresetSkills(db, { action: 'delete' });
    expect(r).toMatchObject({
      action: 'delete', matched: 0, deleted: 0, remaining: 0, 
    });
    expect(await db.collection(DEFAULT_BACKUP_COLLECTION).countDocuments({})).toBe(3);
  });

  it('refuses before writing when the backup already holds a matched row', async () => {
    const [first] = await db.collection('podassets').find({ 'metadata.skillName': 'tavily' }).toArray();
    await db.collection(DEFAULT_BACKUP_COLLECTION).insertOne(first);
    const r = await removeOrphanPresetSkills(db, { action: 'delete' });
    expect(r.problem).toMatch(/already holds 1 of the 3/);
    expect(exitCodeFor(r)).toBe(3);
    expect(await all()).toHaveLength(6);
    expect(await db.collection(DEFAULT_BACKUP_COLLECTION).countDocuments({})).toBe(1);
  });
});

describe('main', () => {
  it.each([[undefined], ['apply']])('ACTION=%p refuses with exit 2 before connecting', async (action) => {
    const connect = jest.spyOn(mongoose, 'connect');
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    const before = process.exitCode;
    await main({ ACTION: action, MONGO_URI: 'mongodb://unused' });
    expect(process.exitCode).toBe(2);
    expect(connect).not.toHaveBeenCalled();
    process.exitCode = before;
    connect.mockRestore();
    err.mockRestore();
  });
});
