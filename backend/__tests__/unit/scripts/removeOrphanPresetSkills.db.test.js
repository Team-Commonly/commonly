// The script deletes production rows, so these arms pin what it leaves alone:
// a hand-imported skill of the same name, a preset skill outside the eight, a
// non-skill asset, and every row when ACTION is unset.
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');
const {
  removeOrphanPresetSkills, exitCodeFor, DEFAULT_BACKUP_COLLECTION,
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

  it('a restore from the backup is one insertMany', async () => {
    await removeOrphanPresetSkills(db, { action: 'delete' });
    const backup = await db.collection(DEFAULT_BACKUP_COLLECTION).find({}).toArray();
    await db.collection('podassets').insertMany(backup);
    expect(await all()).toHaveLength(6);
  });

  it('a second delete finds nothing and does not touch the backup', async () => {
    await removeOrphanPresetSkills(db, { action: 'delete' });
    const r = await removeOrphanPresetSkills(db, { action: 'delete' });
    expect(r).toMatchObject({
      action: 'delete', matched: 0, deleted: 0, remaining: 0, 
    });
    expect(await db.collection(DEFAULT_BACKUP_COLLECTION).countDocuments({})).toBe(3);
  });

  it('refuses to delete when the backup already holds a matched row', async () => {
    const [first] = await db.collection('podassets').find({ 'metadata.skillName': 'tavily' }).toArray();
    await db.collection(DEFAULT_BACKUP_COLLECTION).insertOne(first);
    await expect(removeOrphanPresetSkills(db, { action: 'delete' })).rejects.toThrow(/duplicate key/);
    expect(await all()).toHaveLength(6);
  });
});
