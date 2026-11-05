/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 D3: the dual-store helper on a real Mongo, with an in-memory
 * Postgres adapter that keeps the SQL's version guard and lets a test delay or
 * fail any call. No production model adopts the helper yet, so these tests are
 * its whole proof.
 */
const mongoose = require('mongoose');
const {
  createDualStore, dualStorePlugin, storeMode, dualStoreStats, resetDualStoreStats,
} = require('../../../repositories/dualStore');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');

const schema = new mongoose.Schema({ title: String, count: Number, note: String });
dualStorePlugin(schema);
const Widget = mongoose.models.DualStoreTestWidget || mongoose.model('DualStoreTestWidget', schema);

const ENV = 'STORE_MODE_DUAL_STORE_TEST_WIDGET';
const NAME = 'DualStoreTestWidget';
const toRow = (doc) => ({
  id: String(doc._id), title: doc.title ?? null, count: doc.count ?? null, note: doc.note ?? null,
});
const fromRow = (row) => ({
  _id: new mongoose.Types.ObjectId(row.id),
  ...(row.title != null && { title: row.title }),
  ...(row.count != null && { count: row.count }),
  ...(row.note != null && { note: row.note }),
});

const { fakePg } = require('../../utils/fakeDualStorePg');

const store = (pg, extra = {}) => createDualStore({
  name: NAME, model: Widget, pg, toRow, fromRow, ...extra,
});

describe('dual-store helper (ADR-034 D3)', () => {
  let warn;
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Widget.deleteMany({});
    resetDualStoreStats();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env[ENV];
  });

  const logged = () => warn.mock.calls.map((args) => args.join(' ')).join('\n');

  it('reads the mode from env, defaulting to mongo and warning once on an invalid value', () => {
    expect(storeMode(NAME)).toBe('mongo');
    process.env[ENV] = 'pg-read';
    expect(storeMode(NAME)).toBe('pg-read');
    process.env[ENV] = 'postgres';
    expect(storeMode(NAME)).toBe('mongo');
    expect(storeMode(NAME)).toBe('mongo');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(logged()).toContain(ENV);
  });

  it('adds the markers and a sparse pgPending index to the schema', () => {
    expect(schema.path('pgVersion').instance).toBe('Number');
    expect(schema.path('pgPending').instance).toBe('Number');
    expect(schema.path('pgDeleted').instance).toBe('Boolean');
    expect(schema.indexes()).toEqual(expect.arrayContaining([[{ pgPending: 1 }, expect.objectContaining({ sparse: true })]]));
  });

  it('1. makes no Postgres call at all in the default mode', async () => {
    const pg = fakePg();
    const s = store(pg, { sampleRate: 1 });
    const doc = await s.create({ title: 'a', count: 1 });
    expect(await s.update(doc._id, { count: 2 })).toMatchObject({ count: 2 });
    expect(await s.findById(doc._id)).toMatchObject({ title: 'a', count: 2 });
    expect(await s.remove(doc._id)).toBe(true);
    expect(await s.findById(doc._id)).toBeNull();
    await Widget.create({ title: 'flagged', pgVersion: 3, pgPending: 3 });
    await s.repair({ limit: 10 });
    expect(pg.calls).toEqual([]);
    const raw = await Widget.findOne({ title: 'a' }).lean();
    expect(raw).toBeNull();
  });

  it('2. dual create and update commit to Mongo first, copy toRow to Postgres, and clear the marker', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg, { sampleRate: 0 });
    const hold = pg.hold('upsert');
    const creating = s.create({ title: 'a', count: 1 });
    await hold.arrived;
    const committed = await Widget.findOne({ title: 'a' }).lean();
    expect(committed).toMatchObject({ count: 1, pgVersion: 1, pgPending: 1 });
    hold.release();
    const doc = await creating;
    expect(doc.pgPending).toBeUndefined();
    expect(pg.rows.get(String(doc._id))).toEqual({ row: toRow(committed), version: 1 });

    const updated = await s.update(doc._id, { count: 2, note: undefined, title: 'b' });
    expect(updated).toMatchObject({ title: 'b', count: 2 });
    const raw = await Widget.findById(doc._id).lean();
    expect(raw.pgVersion).toBe(2);
    expect(raw.pgPending).toBeUndefined();
    expect(pg.rows.get(String(doc._id))).toEqual({ row: toRow(raw), version: 2 });
    expect(dualStoreStats(NAME)).toEqual({
      missing: 0, differs: 0, 'pg-write-failed': 0, 'pg-ahead': 0,
    });
  });

  it('unsets a field whose value is undefined', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg);
    const doc = await s.create({ title: 'a', note: 'gone soon' });
    await s.update(doc._id, { note: undefined });
    const raw = await Widget.findById(doc._id).lean();
    expect('note' in raw).toBe(false);
    expect(pg.rows.get(String(doc._id)).row.note).toBeNull();
  });

  describe('3. two writes interleaving', () => {
    it('a late upsert of an earlier write never overwrites a later one', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'v1' });
      const hold = pg.hold('upsert');
      const writeA = s.update(doc._id, { title: 'A' });
      await hold.arrived;
      await s.update(doc._id, { title: 'B' });
      expect(pg.rows.get(String(doc._id))).toMatchObject({ row: { title: 'B' }, version: 3 });
      hold.release();
      await writeA;
      expect(pg.rows.get(String(doc._id))).toMatchObject({ row: { title: 'B' }, version: 3 });
      expect((await Widget.findById(doc._id).lean()).pgPending).toBeUndefined();
    });

    it("an earlier write's late marker clear leaves a later write's marker set", async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'v1' });
      const hold = pg.hold('upsert');
      const writeA = s.update(doc._id, { title: 'A' });
      await hold.arrived;
      pg.failNext('upsert');
      await s.update(doc._id, { title: 'B' });
      hold.release();
      await writeA;
      const raw = await Widget.findById(doc._id).lean();
      expect(raw).toMatchObject({ title: 'B', pgVersion: 3, pgPending: 3 });
      expect(await s.repair({ limit: 10 })).toMatchObject({ copied: 1, failed: 0 });
      expect(pg.rows.get(String(doc._id))).toMatchObject({ row: { title: 'B' }, version: 3 });
    });

    it('a late upsert after a finished delete does not leave the row behind', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'v1' });
      const hold = pg.hold('upsert');
      const writeA = s.update(doc._id, { title: 'A' });
      await hold.arrived;
      expect(await s.remove(doc._id)).toBe(true);
      expect(await Widget.findById(doc._id).lean()).toBeNull();
      hold.release();
      await writeA;
      expect(pg.rows.has(String(doc._id))).toBe(false);
    });
  });

  it('4. a failed Postgres write keeps the caller whole, leaves the marker, and repair re-copies', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg);
    pg.failNext('upsert');
    const doc = await s.create({ title: 'a', count: 7 });
    expect(doc).toMatchObject({ title: 'a', count: 7 });
    expect((await Widget.findById(doc._id).lean()).pgPending).toBe(1);
    expect(pg.rows.has(String(doc._id))).toBe(false);
    expect(dualStoreStats(NAME)['pg-write-failed']).toBe(1);
    expect(logged()).toMatch(/\[dual-store\] mismatch model=DualStoreTestWidget id=[0-9a-f]{12} kind=pg-write-failed/);

    expect(await s.repair({ limit: 10 })).toEqual({
      scanned: 1, copied: 1, deleted: 0, failed: 0,
    });
    expect((await Widget.findById(doc._id).lean()).pgPending).toBeUndefined();
    expect(pg.rows.get(String(doc._id))).toMatchObject({ row: { title: 'a', count: 7 }, version: 1 });
    expect(await s.repair({ limit: 10 })).toEqual({
      scanned: 0, copied: 0, deleted: 0, failed: 0,
    });
  });

  describe('5. a delete crashing at each step', () => {
    const setup = async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'doomed' });
      return { pg, s, id: doc._id };
    };

    it('after the mark: repair removes the Postgres row and then the document', async () => {
      const { pg, s, id } = await setup();
      pg.failNext('remove');
      expect(await s.remove(id)).toBe(true);
      expect(await Widget.findById(id).lean()).toMatchObject({ pgDeleted: true, pgPending: 2 });
      expect(pg.rows.has(String(id))).toBe(true);
      expect(await s.findById(id)).toBeNull();
      expect(await s.update(id, { title: 'zombie' })).toBeNull();
      expect(await s.repair({ limit: 10 })).toMatchObject({ deleted: 1, failed: 0 });
      expect(pg.rows.has(String(id))).toBe(false);
      expect(await Widget.findById(id).lean()).toBeNull();
      expect(await s.findById(id)).toBeNull();
    });

    it('after the Postgres remove: repair removes the document', async () => {
      const { pg, s, id } = await setup();
      const deleteOne = jest.spyOn(Widget, 'deleteOne').mockRejectedValueOnce(new Error('crash'));
      await expect(s.remove(id)).rejects.toThrow('crash');
      deleteOne.mockRestore();
      expect(pg.rows.has(String(id))).toBe(false);
      expect(await Widget.findById(id).lean()).toMatchObject({ pgDeleted: true });
      expect(await s.findById(id)).toBeNull();
      expect(await s.repair({ limit: 10 })).toMatchObject({ deleted: 1, failed: 0 });
      expect(await Widget.findById(id).lean()).toBeNull();
      expect(pg.rows.has(String(id))).toBe(false);
    });

    it('a pgDeleted document reads as absent in mongo mode too', async () => {
      const { pg, s, id } = await setup();
      pg.failNext('remove');
      await s.remove(id);
      delete process.env[ENV];
      expect(await s.findById(id)).toBeNull();
    });
  });

  it('6. pg-read reads Mongo while anything is flagged, even from a new instance, and Postgres after repair', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg, { sampleRate: 0 });
    const doc = await s.create({ title: 'mongo-truth' });
    pg.failNext('upsert');
    await s.update(doc._id, { title: 'newer' });
    pg.rows.get(String(doc._id)).row.title = 'pg-copy';

    process.env[ENV] = 'pg-read';
    const fresh = store(pg, { sampleRate: 0 });
    expect(await fresh.findById(doc._id)).toMatchObject({ title: 'newer' });

    await fresh.repair({ limit: 10 });
    pg.rows.get(String(doc._id)).row.title = 'read-from-pg';
    expect(await fresh.findById(doc._id)).toMatchObject({ title: 'read-from-pg' });
    expect(await store(pg).findById(doc._id)).toMatchObject({ title: 'read-from-pg' });
  });

  it('pg-read returns the same plain shape as a Mongo read', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg, { sampleRate: 0 });
    const doc = await s.create({ title: 'same', count: 3 });
    const fromMongo = await s.findById(doc._id);
    process.env[ENV] = 'pg-read';
    const fromPg = await store(pg).findById(doc._id);
    expect(String(fromPg._id)).toBe(String(fromMongo._id));
    expect({ ...fromPg, _id: String(fromPg._id) }).toEqual({ ...fromMongo, _id: String(fromMongo._id) });
  });

  it('7. a sampled compare logs a mismatch with field names and never a value', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg, { sampleRate: 1 });
    const doc = await s.create({ title: 'ok', note: 'SECRET-NOTE-123' });
    expect(await s.findById(doc._id)).toMatchObject({ title: 'ok' });
    expect(dualStoreStats(NAME)).toEqual({
      missing: 0, differs: 0, 'pg-write-failed': 0, 'pg-ahead': 0,
    });

    pg.rows.get(String(doc._id)).row.note = 'SECRET-DRIFT-456';
    expect(await s.findById(doc._id)).toMatchObject({ note: 'SECRET-NOTE-123' });
    expect(dualStoreStats(NAME).differs).toBe(1);
    expect(logged()).toMatch(/\[dual-store\] mismatch model=DualStoreTestWidget id=[0-9a-f]{12} kind=differs fields=note$/m);

    pg.rows.delete(String(doc._id));
    await s.findById(doc._id);
    expect(dualStoreStats(NAME).missing).toBe(1);
    expect(logged()).toContain('kind=missing');
    expect(logged()).not.toMatch(/SECRET|ok/);
    expect(logged()).not.toContain(String(doc._id));
  });

  it('8. a string starting with $ round-trips through update', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg);
    const doc = await s.create({ title: 'plain', note: 'n' });
    expect(await s.update(doc._id, { title: '$note', note: '$5 off' })).toMatchObject({ title: '$note', note: '$5 off' });
    expect(await Widget.findById(doc._id).lean()).toMatchObject({ title: '$note', note: '$5 off' });
    expect(pg.rows.get(String(doc._id)).row).toMatchObject({ title: '$note', note: '$5 off' });
  });

  it('casts update values through the schema', async () => {
    process.env[ENV] = 'dual';
    const s = store(fakePg());
    const doc = await s.create({ title: 'a' });
    await s.update(doc._id, { count: '42' });
    expect((await Widget.findById(doc._id).lean()).count).toBe(42);
  });

  it('pg mode reads and writes Postgres only', async () => {
    process.env[ENV] = 'pg';
    const pg = fakePg();
    const s = store(pg);
    const doc = await s.create({ title: 'pg-only', count: 1 });
    expect(await Widget.countDocuments({})).toBe(0);
    expect(pg.rows.get(String(doc._id))).toMatchObject({ row: { title: 'pg-only' }, version: 1 });
    expect(await s.update(doc._id, { count: 2, title: undefined })).toMatchObject({ count: 2 });
    expect(pg.rows.get(String(doc._id))).toEqual({
      row: {
        id: String(doc._id), title: null, count: 2, note: null,
      },
      version: 2,
    });
    expect(await s.findById(doc._id)).toEqual({ _id: doc._id, count: 2 });
    expect(await s.remove(doc._id)).toBe(true);
    expect(await s.findById(doc._id)).toBeNull();
    expect(await s.remove(doc._id)).toBe(false);
    expect(await s.update(doc._id, { count: 3 })).toBeNull();
    expect(await Widget.countDocuments({})).toBe(0);
  });

  describe('9. pg mode: an update and a delete interleaving', () => {
    it('an update that read the row before a delete does not bring it back', async () => {
      process.env[ENV] = 'pg';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'racing', count: 1 });
      const held = pg.hold('replace');
      const updating = s.update(doc._id, { count: 2 });
      await held.arrived;
      expect(await s.remove(doc._id)).toBe(true);
      held.release();
      expect(await updating).toBeNull();
      expect(pg.rows.has(String(doc._id))).toBe(false);
    });

    it('a delete that read the row before an update still deletes it, and says so truthfully', async () => {
      process.env[ENV] = 'pg';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'racing', count: 1 });
      const held = pg.hold('removeAt');
      const removing = s.remove(doc._id);
      await held.arrived;
      expect(await s.update(doc._id, { count: 2 })).toMatchObject({ count: 2 });
      held.release();
      expect(await removing).toBe(true);
      expect(pg.rows.has(String(doc._id))).toBe(false);
    });
  });

  it('10. dual: Postgres ahead of Mongo (a rollback from pg) is counted and keeps reads on Mongo', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const s = store(pg);
    const doc = await s.create({ title: 'rolled back', count: 1 });
    // pg mode wrote versions Mongo never saw, then the model went back to dual.
    pg.rows.set(String(doc._id), { row: { ...pg.rows.get(String(doc._id)).row, count: 9 }, version: 7 });
    await s.update(doc._id, { count: 2 });
    expect(dualStoreStats(NAME)['pg-ahead']).toBe(1);
    expect((await Widget.findById(doc._id).lean()).pgPending).toBe(2);
    process.env[ENV] = 'pg-read';
    expect(await s.findById(doc._id)).toMatchObject({ count: 2 });
  });

  it('refuses a model whose schema lacks the plugin, which would drop every marker silently', () => {
    const bare = mongoose.models.DualStoreBare
      || mongoose.model('DualStoreBare', new mongoose.Schema({ title: String }));
    expect(() => createDualStore({
      name: 'DualStoreBare', model: bare, pg: fakePg(), toRow, fromRow,
    })).toThrow(/dualStorePlugin/);
  });
});
