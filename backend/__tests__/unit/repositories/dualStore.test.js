/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 D3: the dual-store helper on a real Mongo, with an in-memory
 * Postgres adapter that keeps the SQL's version guard and lets a test delay or
 * fail any call. No production model adopts the helper yet, so these tests are
 * its whole proof.
 */
const mongoose = require('mongoose');
const {
  createDualStore, dualStorePlugin, storeMode, dualStoreStats, resetDualStoreStats, pgTableAdapter,
} = require('../../../repositories/dualStore');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

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

// These tests exercise the helper's delete path, so they opt in to it; a
// store without the opt-in refuses remove outside mongo (test 14).
const store = (pg, extra = {}) => createDualStore({
  name: NAME, model: Widget, pg, toRow, fromRow, allowDeletes: true, ...extra,
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
    jest.restoreAllMocks();
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

  it('4b. a toRow that throws after the Mongo write is a failed copy, never a failed write; repair goes on past it', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    let refuse = 'poison';
    const s = store(pg, {
      toRow: (doc) => {
        if (doc.title === refuse) throw new Error('unmappable');
        return toRow(doc);
      },
    });
    const bad = await s.create({ title: 'poison', count: 1 });
    expect(bad).toMatchObject({ title: 'poison' });
    expect(await s.update(bad._id, { count: 2 })).toMatchObject({ count: 2 });
    expect((await Widget.findById(bad._id).lean())).toMatchObject({ count: 2, pgVersion: 2, pgPending: 2 });
    expect(dualStoreStats(NAME)['pg-write-failed']).toBe(2);
    const good = await s.create({ title: 'fine', count: 1 });
    await Widget.updateOne({ _id: good._id }, { $set: { pgPending: 1 } });

    expect(await s.repair({ limit: 10 })).toEqual({
      scanned: 2, copied: 1, deleted: 0, failed: 1,
    });
    expect(pg.rows.has(String(bad._id))).toBe(false);
    refuse = null;
    expect(await s.repair({ limit: 10 })).toEqual({
      scanned: 1, copied: 1, deleted: 0, failed: 0,
    });
    expect(pg.rows.get(String(bad._id))).toMatchObject({ row: { title: 'poison', count: 2 }, version: 2 });
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

  describe('11. upsert: one atomic create-or-change', () => {
    // The change in both languages: count only rises, title is set on the first write only.
    const raise = (n, title = 'first') => ({
      pipeline: [{
        $set: {
          count: { $max: ['$count', { $literal: n }] },
          title: { $ifNull: ['$title', { $literal: title }] },
        },
      }],
      merge: (current) => ({
        ...(current || {}),
        count: Math.max(current?.count ?? -Infinity, n),
        title: current?.title ?? title,
      }),
    });
    const id = () => new mongoose.Types.ObjectId();

    it('mongo: creates, then applies the pipeline, with no Postgres call and no markers', async () => {
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      expect(await s.upsert(key, raise(3))).toEqual({ _id: key, count: 3, title: 'first' });
      expect(await s.upsert(key, raise(1, 'second'))).toEqual({ _id: key, count: 3, title: 'first' });
      expect(await s.upsert(key, raise(5))).toMatchObject({ count: 5 });
      const raw = await Widget.findById(key).lean();
      expect(raw.pgVersion).toBeUndefined();
      expect(raw.pgPending).toBeUndefined();
      expect(pg.calls).toEqual([]);
    });

    it.each(['mongo', 'dual'])('%s: twenty racing first writes converge on one document at the maximum', async (mode) => {
      if (mode !== 'mongo') process.env[ENV] = mode;
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      await Promise.all(Array.from({ length: 20 }, (_, i) => s.upsert(key, raise(i))));
      expect(await Widget.countDocuments({ _id: key })).toBe(1);
      const raw = await Widget.findById(key).lean();
      expect(raw.count).toBe(19);
      if (mode === 'dual') {
        expect(raw.pgVersion).toBe(20);
        expect(raw.pgPending).toBeUndefined();
        expect(pg.rows.get(String(key))).toEqual({ row: toRow(raw), version: 20 });
      }
    });

    it('retries a duplicate-key first write without the upsert, and propagates any other error', async () => {
      const s = store(fakePg());
      const key = id();
      await s.upsert(key, raise(1));
      const spy = jest.spyOn(Widget, 'findOneAndUpdate');
      spy.mockImplementationOnce(() => ({ lean: () => Promise.reject(Object.assign(new Error('dup'), { code: 11000 })) }));
      expect(await s.upsert(key, raise(4))).toMatchObject({ count: 4 });
      expect(spy.mock.calls[1][2]).toEqual({ new: true });
      spy.mockImplementationOnce(() => ({ lean: () => Promise.reject(new Error('down')) }));
      await expect(s.upsert(key, raise(9))).rejects.toThrow('down');
      spy.mockRestore();
      expect((await Widget.findById(key).lean()).count).toBe(4);
    });

    it('dual: commits the change, version and marker in one write, then copies and clears', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      // Every Mongo write path the helper could use, so a second write before the copy shows.
      const writes = ['findOneAndUpdate', 'updateOne', 'updateMany', 'bulkWrite', 'create', 'replaceOne']
        .map((method) => [method, jest.spyOn(Widget, method)]);
      const hold = pg.hold('upsert');
      const writing = s.upsert(key, raise(2));
      await hold.arrived;
      const called = writes.flatMap(([method, spy]) => spy.mock.calls.map((args) => [method, args]));
      writes.forEach(([, spy]) => spy.mockRestore());
      // Exactly one Mongo write before the copy, carrying the payload, the version and the marker.
      expect(called.map(([method]) => method)).toEqual(['findOneAndUpdate']);
      const stages = JSON.stringify(called[0][1][1]);
      expect(stages).toContain('"count"');
      expect(stages).toContain('"pgVersion"');
      expect(stages).toContain('"pgPending":"$pgVersion"');
      expect(await Widget.findById(key).lean()).toMatchObject({ count: 2, pgVersion: 1, pgPending: 1 });
      hold.release();
      expect(await writing).toEqual({ _id: key, count: 2, title: 'first' });
      await s.upsert(key, raise(7));
      const raw = await Widget.findById(key).lean();
      expect(raw).toMatchObject({ count: 7, pgVersion: 2 });
      expect(raw.pgPending).toBeUndefined();
      expect(pg.rows.get(String(key))).toEqual({ row: toRow(raw), version: 2 });
    });

    it('dual: a failed copy leaves the marker for repair', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      pg.failNext('upsert');
      expect(await s.upsert(key, raise(6))).toMatchObject({ count: 6 });
      expect((await Widget.findById(key).lean()).pgPending).toBe(1);
      expect(dualStoreStats(NAME)['pg-write-failed']).toBe(1);
      expect(await s.repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(pg.rows.get(String(key))).toMatchObject({ row: { count: 6 }, version: 1 });
    });

    it('pg: inserts at version 1, then replaces onto the version it read', async () => {
      process.env[ENV] = 'pg';
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      expect(await s.upsert(key, raise(3))).toEqual({ _id: key, count: 3, title: 'first' });
      expect(pg.rows.get(String(key)).version).toBe(1);
      expect(await s.upsert(key, raise(1, 'second'))).toEqual({ _id: key, count: 3, title: 'first' });
      expect(pg.rows.get(String(key))).toMatchObject({ row: { count: 3, title: 'first' }, version: 2 });
      expect(await Widget.countDocuments({})).toBe(0);
    });

    it('pg: a first write that loses the insert race re-reads and applies onto the winner', async () => {
      process.env[ENV] = 'pg';
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      const hold = pg.hold('upsert');
      const loser = s.upsert(key, raise(2, 'loser'));
      await hold.arrived;
      await s.upsert(key, raise(5, 'winner'));
      hold.release();
      expect(await loser).toMatchObject({ count: 5, title: 'winner' });
      expect(pg.rows.get(String(key))).toMatchObject({ row: { count: 5, title: 'winner' }, version: 2 });
    });

    it('pg: an update that lost to a concurrent one re-reads instead of overwriting it', async () => {
      process.env[ENV] = 'pg';
      const pg = fakePg();
      const s = store(pg);
      const key = id();
      await s.upsert(key, raise(1));
      const hold = pg.hold('replace');
      const slow = s.upsert(key, raise(4));
      await hold.arrived;
      await s.upsert(key, raise(9));
      hold.release();
      expect(await slow).toMatchObject({ count: 9 });
      expect(pg.rows.get(String(key))).toMatchObject({ row: { count: 9 }, version: 3 });
    });

    describe('onto a document marked deleted', () => {
      const midDelete = async () => {
        process.env[ENV] = 'dual';
        const pg = fakePg();
        const s = store(pg);
        const key = id();
        await s.upsert(key, raise(8, 'old'));
        await s.update(key, { note: 'old note' });
        pg.failNext('remove');
        expect(await s.remove(key)).toBe(true);
        expect(await Widget.findById(key).lean()).toMatchObject({ pgDeleted: true, pgPending: 3 });
        return { pg, s, key };
      };

      it('starts from an empty document: nothing of the deleted one comes back', async () => {
        const { pg, s, key } = await midDelete();
        expect(await s.upsert(key, raise(2, 'new'))).toEqual({ _id: key, count: 2, title: 'new' });
        const raw = await Widget.findById(key).lean();
        expect(raw).toEqual({
          _id: key, count: 2, title: 'new', pgVersion: 4,
        });
        expect(pg.rows.get(String(key))).toEqual({ row: toRow(raw), version: 4 });
      });

      it("the delete's own late steps cannot take the new document or its row", async () => {
        const { pg, s, key } = await midDelete();
        await s.upsert(key, raise(2, 'new'));
        expect(await s.repair()).toEqual({
          scanned: 0, copied: 0, deleted: 0, failed: 0,
        });
        // What the delete, or a repair that read it earlier, does next:
        // remove the row at its version, then the document by its marker.
        await pg.remove(String(key), 3);
        await Widget.deleteOne({ _id: key, pgPending: 3 });
        expect(await s.findById(key)).toMatchObject({ count: 2, title: 'new' });
        expect(pg.rows.get(String(key))).toMatchObject({ row: { count: 2, title: 'new' }, version: 4 });
      });

      it('mongo mode after a rollback: the same fresh start, without markers', async () => {
        const { s, key } = await midDelete();
        delete process.env[ENV];
        expect(await s.upsert(key, raise(1, 'new'))).toEqual({ _id: key, count: 1, title: 'new' });
        expect(await Widget.findById(key).lean()).toEqual({
          _id: key, count: 1, title: 'new', pgVersion: 3,
        });
      });
    });
  });

  describe('12. backfill', () => {
    const seed = (fields) => Widget.collection.insertOne({ _id: new mongoose.Types.ObjectId(), ...fields });

    it.each([undefined, 'mongo', 'pg'])('refuses outside dual and pg-read (mode %p)', async (mode) => {
      if (mode) process.env[ENV] = mode;
      const pg = fakePg();
      await expect(store(pg).backfill({ dryRun: false })).rejects.toThrow(/STORE_MODE_DUAL_STORE_TEST_WIDGET=dual/);
      expect(pg.calls).toEqual([]);
    });

    it('a dry run counts without writing, --apply copies, and a second run finds everything current', async () => {
      await seed({ title: 'history', count: 1 });
      await seed({ title: 'history2' });
      await seed({ title: 'gone', pgDeleted: true, pgVersion: 2 });
      await seed({ title: 'in flight', pgVersion: 4, pgPending: 4 });
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const current = await s.create({ title: 'dual-written' });

      expect(await s.backfill({ dryRun: true, batchSize: 2 })).toEqual({
        scanned: 4, inserted: 3, alreadyCurrent: 1, deferredPending: 1,
      });
      expect(pg.calls.filter((c) => c === 'upsert')).toHaveLength(1);
      expect(pg.rows.size).toBe(1);

      expect(await s.backfill({ dryRun: false, batchSize: 2 })).toEqual({
        scanned: 4, inserted: 3, alreadyCurrent: 1, deferredPending: 1,
      });
      expect(pg.rows.size).toBe(4);
      const inFlight = await Widget.findOne({ title: 'in flight' }).lean();
      expect(pg.rows.get(String(inFlight._id)).version).toBe(4);
      const history = await Widget.findOne({ title: 'history' }).lean();
      expect(pg.rows.get(String(history._id))).toEqual({ row: toRow(history), version: 0 });
      expect(pg.rows.get(String(current._id)).version).toBe(1);
      expect(await s.backfill({ dryRun: false })).toMatchObject({ inserted: 0, alreadyCurrent: 4 });
    });

    it('copies a document that was pending when scanned and has settled by the end, which repair would never see', async () => {
      // B's dual write copied its row, then the table was emptied, and B's
      // marker clears while the backfill is still running: an unflagged
      // document with no row.
      const b = await seed({ title: 'B', pgVersion: 2, pgPending: 2 });
      const a = await seed({ title: 'A' });
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const hold = pg.hold('upsert');
      const copying = s.backfill({ dryRun: false });
      await hold.arrived; // B scanned and skipped; A's copy is in flight
      await Widget.updateOne({ _id: b.insertedId, pgPending: 2 }, { $unset: { pgPending: 1 } });
      hold.release();
      expect(await copying).toEqual({
        scanned: 2, inserted: 2, alreadyCurrent: 0, deferredPending: 1,
      });
      expect(pg.rows.get(String(b.insertedId))).toMatchObject({ row: { title: 'B' }, version: 2 });
      expect(pg.rows.has(String(a.insertedId))).toBe(true);
      expect(await s.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('copies a document still pending through the whole run, whose marker clears only afterwards', async () => {
      // B's dual write copied its row, then the table was emptied; B stays
      // pending through the scan and the final pass, and its in-flight copy
      // clears the marker only after the backfill ends. Without the final
      // pass's copy that leaves no row and no flag, which repair never sees.
      const b = await seed({ title: 'B', pgVersion: 2, pgPending: 2 });
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      expect(await s.backfill({ dryRun: false })).toEqual({
        scanned: 1, inserted: 1, alreadyCurrent: 0, deferredPending: 1,
      });
      await Widget.updateOne({ _id: b.insertedId, pgPending: 2 }, { $unset: { pgPending: 1 } });
      expect(pg.rows.get(String(b.insertedId))).toMatchObject({ row: { title: 'B' }, version: 2 });
      expect(await s.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
      // A newer write still wins over the final pass's copy.
      await s.update(b.insertedId, { title: 'B2' });
      expect(await s.backfill({ dryRun: false })).toMatchObject({ alreadyCurrent: 1 });
      expect(pg.rows.get(String(b.insertedId))).toMatchObject({ row: { title: 'B2' }, version: 3 });
    });

    it('a dual write racing the copy always wins, whichever lands first', async () => {
      const { insertedId } = await seed({ title: 'v0' });
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      // The copy read v0 and is held while the dual write lands.
      const hold = pg.hold('upsert');
      const copying = s.backfill({ dryRun: false });
      await hold.arrived;
      await s.update(insertedId, { title: 'v1' });
      hold.release();
      expect(await copying).toMatchObject({ scanned: 1, alreadyCurrent: 1 });
      expect(pg.rows.get(String(insertedId))).toMatchObject({ row: { title: 'v1' }, version: 1 });
      // Copied first, then written: the write's higher version replaces the copy.
      await s.update(insertedId, { title: 'v2' });
      expect(await s.backfill({ dryRun: false })).toMatchObject({ alreadyCurrent: 1 });
      expect(pg.rows.get(String(insertedId))).toMatchObject({ row: { title: 'v2' }, version: 2 });
    });
  });

  describe('13. verify', () => {
    it('matches on a clean copy, and counts missing, differing and extra rows with hashed ids only', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const a = await s.create({ title: 'a', note: 'SECRET-A' });
      const b = await s.create({ title: 'b' });
      const c = await s.create({ title: 'c' });
      const clean = await s.verify({ batchSize: 2 });
      expect(clean).toMatchObject({
        mongo: 3, pg: 3, missing: 0, differs: 0, extra: 0,
      });
      expect(clean.checksumMongo).toMatch(/^[0-9a-f]{64}$/);
      expect(clean.checksumPg).toBe(clean.checksumMongo);
      expect(warn).not.toHaveBeenCalled();

      pg.rows.get(String(a._id)).row.note = 'SECRET-DRIFT';
      pg.rows.delete(String(b._id));
      const ghost = new mongoose.Types.ObjectId();
      pg.rows.set(String(ghost), { row: toRow({ _id: ghost, title: 'ghost' }), version: 1 });
      const drift = await s.verify({ batchSize: 2 });
      expect(drift).toMatchObject({
        mongo: 3, pg: 3, missing: 1, differs: 1, extra: 1,
      });
      expect(drift.checksumPg).not.toBe(drift.checksumMongo);
      expect(logged()).toMatch(/verify model=DualStoreTestWidget id=[0-9a-f]{12} kind=differs fields=note$/m);
      expect(logged()).toContain('kind=missing');
      expect(logged()).toContain('kind=extra');
      [a, b, c].forEach((doc) => expect(logged()).not.toContain(String(doc._id)));
      expect(logged()).not.toContain(String(ghost));
      expect(logged()).not.toMatch(/SECRET/);
    });

    it('leaves out a document marked deleted', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'doomed' });
      pg.failNext('remove');
      await s.remove(doc._id);
      pg.rows.delete(String(doc._id));
      expect(await s.verify()).toMatchObject({ mongo: 0, pg: 0, missing: 0 });
    });
  });

  describe('14. deletes need an explicit opt-in outside mongo', () => {
    const bare = (pg) => createDualStore({
      name: NAME, model: Widget, pg, toRow, fromRow,
    });

    it.each(['dual', 'pg-read', 'pg'])('%s: remove throws and writes nothing to either store', async (mode) => {
      const doc = await Widget.create({ title: 'kept', pgVersion: 1 });
      const pg = fakePg();
      pg.rows.set(String(doc._id), { row: toRow(doc), version: 1 });
      process.env[ENV] = mode;
      const writes = ['findOneAndUpdate', 'updateOne', 'deleteOne', 'deleteMany']
        .map((method) => jest.spyOn(Widget, method));
      await expect(bare(pg).remove(doc._id)).rejects.toThrow(/refuses remove in .*tombstones/);
      writes.forEach((spy) => expect(spy).not.toHaveBeenCalled());
      expect(pg.calls).toEqual([]);
      expect(await Widget.findById(doc._id).lean()).toMatchObject({ title: 'kept', pgVersion: 1 });
      expect(pg.rows.has(String(doc._id))).toBe(true);
    });

    it('mongo: remove works without the opt-in', async () => {
      const doc = await Widget.create({ title: 'gone' });
      const pg = fakePg();
      expect(await bare(pg).remove(doc._id)).toBe(true);
      expect(await Widget.findById(doc._id).lean()).toBeNull();
      expect(pg.calls).toEqual([]);
    });
  });

  describe('15. verify and backfill arguments and modes', () => {
    it.each([0, -1, 1.5, Number.NaN])('reject batchSize %p before opening either side', async (batchSize) => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const find = jest.spyOn(Widget, 'find');
      await expect(store(pg).verify({ batchSize })).rejects.toThrow(/batchSize must be a positive integer/);
      await expect(store(pg).backfill({ batchSize })).rejects.toThrow(/batchSize must be a positive integer/);
      expect(find).not.toHaveBeenCalled();
      expect(pg.calls).toEqual([]);
    });

    it.each([undefined, 'mongo', 'pg'])('verify refuses in mode %p without calling Postgres', async (mode) => {
      if (mode) process.env[ENV] = mode;
      const pg = fakePg();
      await expect(store(pg).verify()).rejects.toThrow(/verify needs STORE_MODE_DUAL_STORE_TEST_WIDGET=dual or pg-read/);
      expect(pg.calls).toEqual([]);
    });

    it.each(['dual', 'pg-read'])('verify runs in %s', async (mode) => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      await store(pg).create({ title: 'x' });
      process.env[ENV] = mode;
      expect(await store(pg).verify()).toMatchObject({ mongo: 1, pg: 1, differs: 0 });
    });

    it('verify counts equal payloads at different versions as differs, naming pgVersion', async () => {
      process.env[ENV] = 'dual';
      const pg = fakePg();
      const s = store(pg);
      const doc = await s.create({ title: 'same' });
      pg.rows.get(String(doc._id)).version = 5;
      expect(await s.verify()).toMatchObject({ differs: 1, missing: 0, extra: 0 });
      expect(logged()).toMatch(/kind=differs fields=pgVersion$/m);
    });
  });

  it('16. pg-read: a failing flag check falls back to the Postgres row and warns without ids', async () => {
    process.env[ENV] = 'dual';
    const pg = fakePg();
    const doc = await store(pg).create({ title: 'in pg' });
    process.env[ENV] = 'pg-read';
    jest.spyOn(Widget, 'exists').mockImplementation(() => Promise.reject(new Error('mongo down')));
    expect(await store(pg).findById(doc._id)).toMatchObject({ title: 'in pg' });
    expect(logged()).toContain('[dual-store] flag check failed model=DualStoreTestWidget');
    expect(logged()).not.toContain(String(doc._id));
  });
  describe('17. claims: insertIfAbsent and setWhere', () => {
    // A model keyed by a unique pair, like a first-contact marker, with a map of claim dates.
    const pairSchema = new mongoose.Schema({
      owner: String, name: String, seen: { type: Map, of: Date, default: {} },
    });
    pairSchema.index({ owner: 1, name: 1 }, { unique: true });
    dualStorePlugin(pairSchema);
    const Pair = mongoose.models.DualStoreTestPair || mongoose.model('DualStoreTestPair', pairSchema);
    const PAIR_ENV = 'STORE_MODE_DUAL_STORE_TEST_PAIR';
    const pairRow = (doc) => ({
      id: String(doc._id), owner: doc.owner, name: doc.name, seen: { ...(doc.seen || {}) },
    });
    const pairs = (pg) => createDualStore({
      name: 'DualStoreTestPair', model: Pair, pg, toRow: pairRow, fromRow: (row) => row,
    });
    const key = { owner: 'u1', name: 'scout' };
    const at = (day) => new Date(Date.UTC(2026, 10, day));
    // Claim `seen.p1` unless it is newer than `before`.
    const unclaimed = (before) => ({
      ...key, $or: [{ 'seen.p1': { $exists: false } }, { 'seen.p1': { $lt: before } }],
    });

    beforeAll(async () => { await Pair.init(); });
    beforeEach(async () => { await Pair.deleteMany({}); });
    afterEach(() => { delete process.env[PAIR_ENV]; });

    it('mongo: inserts once, changes nothing on a match, and makes no Postgres call', async () => {
      const pg = fakePg();
      const s = pairs(pg);
      expect(await s.insertIfAbsent(key, { ...key, seen: { p0: at(1) } })).toEqual({ inserted: true });
      expect(await s.insertIfAbsent(key, { ...key, seen: { p9: at(2) } })).toEqual({ inserted: false });
      const raw = await Pair.findOne(key).lean();
      expect(raw.seen).toEqual({ p0: at(1) });
      expect(raw.pgVersion).toBeUndefined();
      expect(await s.setWhere(unclaimed(at(1)), { 'seen.p1': at(3) })).toBe(true);
      expect(await s.setWhere(unclaimed(at(1)), { 'seen.p1': at(4) })).toBe(false);
      expect((await Pair.findOne(key).lean()).seen).toEqual({ p0: at(1), p1: at(3) });
      expect(pg.calls).toEqual([]);
    });

    it.each(['dual', 'pg-read'])('%s: the insert takes version 1 in the same write, and is copied', async (mode) => {
      process.env[PAIR_ENV] = mode;
      const pg = fakePg();
      const s = pairs(pg);
      const update = jest.spyOn(Pair, 'findOneAndUpdate');
      const hold = pg.hold('upsert');
      const inserting = s.insertIfAbsent(key, { ...key, seen: { p0: at(1) } });
      await hold.arrived;
      // One Mongo write, carrying the document, its version and its marker.
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0][1].$setOnInsert).toMatchObject({ pgVersion: 1, pgPending: 1 });
      hold.release();
      expect(await inserting).toEqual({ inserted: true });
      const raw = await Pair.findOne(key).lean();
      expect(raw.pgVersion).toBe(1);
      expect(raw.pgPending).toBeUndefined();
      expect(pg.rows.get(String(raw._id))).toEqual({ row: pairRow(raw), version: 1 });
    });

    it('dual: racing inserts produce one winner, and a loser bumps no version and copies nothing', async () => {
      process.env[PAIR_ENV] = 'dual';
      const pg = fakePg();
      const s = pairs(pg);
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => s.insertIfAbsent(key, { ...key })));
      expect(outcomes.filter((o) => o.inserted === true)).toHaveLength(1);
      expect(outcomes.every((o) => typeof o.inserted === 'boolean')).toBe(true);
      expect(await s.insertIfAbsent(key, { ...key })).toEqual({ inserted: false });
      const raw = await Pair.findOne(key).lean();
      expect(raw.pgVersion).toBe(1);
      expect(pg.calls.filter((c) => c === 'upsert')).toHaveLength(1);
      expect(pg.rows.get(String(raw._id)).version).toBe(1);
    });

    it('dual: a loser of the unique-key race is retried once and reads as found', async () => {
      process.env[PAIR_ENV] = 'dual';
      const pg = fakePg();
      const s = pairs(pg);
      await s.insertIfAbsent(key, { ...key });
      const callsBefore = pg.calls.length;
      // The insert lost the race: the winner committed between its miss and its insert.
      const update = jest.spyOn(Pair, 'findOneAndUpdate')
        .mockImplementationOnce(() => Promise.reject(Object.assign(new Error('E11000'), { code: 11000 })));
      expect(await s.insertIfAbsent(key, { ...key })).toEqual({ inserted: false });
      expect(update).toHaveBeenCalledTimes(2);
      update.mockRestore();
      expect((await Pair.findOne(key).lean()).pgVersion).toBe(1);
      expect(pg.calls.length).toBe(callsBefore);
    });

    it('dual: a duplicate key that survives the retry propagates', async () => {
      process.env[PAIR_ENV] = 'dual';
      const s = pairs(fakePg());
      const duplicate = () => Promise.reject(Object.assign(new Error('E11000'), { code: 11000 }));
      const update = jest.spyOn(Pair, 'findOneAndUpdate')
        .mockImplementationOnce(duplicate).mockImplementationOnce(duplicate);
      await expect(s.insertIfAbsent(key, { ...key })).rejects.toMatchObject({ code: 11000 });
      expect(update).toHaveBeenCalledTimes(2);
      update.mockRestore();
    });

    it('dual: setWhere bumps and copies only when its filter matches', async () => {
      process.env[PAIR_ENV] = 'dual';
      const pg = fakePg();
      const s = pairs(pg);
      await s.insertIfAbsent(key, { ...key });
      const [first, second] = await Promise.all([
        s.setWhere(unclaimed(at(1)), { 'seen.p1': at(5) }),
        s.setWhere(unclaimed(at(1)), { 'seen.p1': at(5) }),
      ]);
      expect([first, second].filter(Boolean)).toHaveLength(1);
      let raw = await Pair.findOne(key).lean();
      expect(raw).toMatchObject({ pgVersion: 2, seen: { p1: at(5) } });
      expect(raw.pgPending).toBeUndefined();
      expect(pg.rows.get(String(raw._id))).toEqual({ row: pairRow(raw), version: 2 });
      // Too soon: no match, no bump, no copy.
      const copies = pg.calls.length;
      expect(await s.setWhere(unclaimed(at(2)), { 'seen.p1': at(6) })).toBe(false);
      expect(pg.calls).toHaveLength(copies);
      expect((await Pair.findOne(key).lean()).pgVersion).toBe(2);
      // Past the window, the claim renews.
      expect(await s.setWhere(unclaimed(at(10)), { 'seen.p1': at(20) })).toBe(true);
      raw = await Pair.findOne(key).lean();
      expect(raw).toMatchObject({ pgVersion: 3, seen: { p1: at(20) } });
      expect(pg.rows.get(String(raw._id)).version).toBe(3);
    });

    it('dual: setWhere on a document with no map yet creates it, and a $ value stays a value', async () => {
      process.env[PAIR_ENV] = 'dual';
      const pg = fakePg();
      const s = pairs(pg);
      await Pair.collection.insertOne({ ...key });
      expect(await s.setWhere(key, { 'seen.p1': at(3) })).toBe(true);
      const raw = await Pair.findOne(key).lean();
      expect(raw).toMatchObject({ seen: { p1: at(3) }, pgVersion: 1 });
      await s.setWhere(key, { owner: '$owner' });
      expect((await Pair.findById(raw._id).lean()).owner).toBe('$owner');
    });

    it.each(['dual', 'pg-read'])('%s: a timestamped model stamps the insert only; a found call changes nothing',
      async (mode) => {
      // Mongoose would $set updatedAt on a found document too, with no version
      // and no copy, so the row's updated_at would fall behind the document's.
      const stampedSchema = new mongoose.Schema({ _id: String, owner: String, note: String }, { timestamps: true });
      dualStorePlugin(stampedSchema);
      const Stamped = mongoose.models.DualStoreTestStamped || mongoose.model('DualStoreTestStamped', stampedSchema);
      await Stamped.deleteMany({});
      const stampedRow = (doc) => ({
        id: String(doc._id), owner: doc.owner ?? null, note: doc.note ?? null,
        created_at: doc.createdAt ?? null, updated_at: doc.updatedAt ?? null,
      });
      process.env.STORE_MODE_DUAL_STORE_TEST_STAMPED = mode;
      try {
        const pg = fakePg();
        const s = createDualStore({
          name: 'DualStoreTestStamped', model: Stamped, pg, toRow: stampedRow, fromRow: (row) => row,
        });
        expect(await s.insertIfAbsent({ _id: 'k1' }, { owner: 'u1' })).toEqual({ inserted: true });
        const inserted = await Stamped.findById('k1').lean();
        expect(inserted.createdAt).toBeInstanceOf(Date);
        expect(inserted.updatedAt).toEqual(inserted.createdAt);
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        expect(await s.insertIfAbsent({ _id: 'k1' }, { owner: 'u2', note: 'later' })).toEqual({ inserted: false });
        expect(await Stamped.findById('k1').lean()).toEqual(inserted);
        expect(pg.rows.get('k1')).toEqual({ row: stampedRow(inserted), version: 1 });
        // The stamp wins over a caller's own createdAt, as Mongoose's upsert does in mongo mode.
        expect(await s.insertIfAbsent({ _id: 'k2' }, { createdAt: at(1) })).toEqual({ inserted: true });
        expect((await Stamped.findById('k2').lean()).createdAt).not.toEqual(at(1));
        delete process.env.STORE_MODE_DUAL_STORE_TEST_STAMPED;
        const mongoSide = await Stamped.findOneAndUpdate(
          { _id: 'k3' }, { $setOnInsert: { createdAt: at(1) } }, { upsert: true, new: true },
        ).lean();
        expect(mongoSide.createdAt).not.toEqual(at(1));
      } finally {
        delete process.env.STORE_MODE_DUAL_STORE_TEST_STAMPED;
      }
    });

    it('dual: a failed copy leaves the claim standing and the marker for repair', async () => {
      process.env[PAIR_ENV] = 'dual';
      const pg = fakePg();
      const s = pairs(pg);
      pg.failNext('upsert');
      expect(await s.insertIfAbsent(key, { ...key })).toEqual({ inserted: true });
      expect((await Pair.findOne(key).lean()).pgPending).toBe(1);
      expect(await s.repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(pg.rows.size).toBe(1);
    });

    it('refuses a path segment starting with $, and both claims in pg mode, before any write', async () => {
      process.env[PAIR_ENV] = 'dual';
      const pg = fakePg();
      const s = pairs(pg);
      await expect(s.setWhere(key, { 'seen.$x': at(1) })).rejects.toThrow(/\$/);
      process.env[PAIR_ENV] = 'pg';
      await expect(s.insertIfAbsent(key, { ...key })).rejects.toThrow(/not supported in pg mode until step 4/);
      await expect(s.setWhere(key, { 'seen.p1': at(1) })).rejects.toThrow(/not supported in pg mode until step 4/);
      expect(await Pair.countDocuments({})).toBe(0);
      expect(pg.calls).toEqual([]);
    });
  });

  describe('18. $in, $exists and updateManyWhere', () => {
    const FILTERS = {
      _id: 'id', title: 'title', count: 'count', note: 'note',
    };
    // note is never written as an explicit null, so it may be tested with $exists.
    const filtered = (pg) => store(pg, { filterColumns: FILTERS, sampleRate: 0 });
    const presencePg = () => fakePg({ presenceColumns: ['note'] });
    const seed = async (s) => {
      const a = await s.create({ title: 'a', count: 1 });
      const b = await s.create({ title: 'b', count: 2, note: 'held' });
      const c = await s.create({ title: 'c', count: 3 });
      return { a, b, c };
    };
    const titles = (docs) => docs.map((doc) => doc.title).sort();

    it('pg-read: $in reads Postgres, each element cast as equality casts it', async () => {
      process.env[ENV] = 'pg-read';
      const pg = presencePg();
      const s = filtered(pg);
      const { a, c } = await seed(s);
      pg.calls.length = 0;
      // ObjectIds and their hex strings both cast to the id column's hex.
      expect(titles(await s.findWhere({ _id: { $in: [a._id, String(c._id)] } }))).toEqual(['a', 'c']);
      expect(titles(await s.findWhere({ title: { $in: ['b', 'c', 'zz'] }, count: { $gte: 3 } }))).toEqual(['c']);
      expect(pg.calls).toEqual(['findWhere', 'findWhere']);
    });

    it('pg-read: $exists false is a missing field and true a present one, on a presence column', async () => {
      process.env[ENV] = 'pg-read';
      const pg = presencePg();
      const s = filtered(pg);
      await seed(s);
      pg.calls.length = 0;
      expect(titles(await s.findWhere({ note: { $exists: false } }))).toEqual(['a', 'c']);
      expect(titles(await s.findWhere({ note: { $exists: true } }))).toEqual(['b']);
      expect(pg.calls).toEqual(['findWhere', 'findWhere']);
      // Mongo answers the same in dual.
      process.env[ENV] = 'dual';
      expect(titles(await s.findWhere({ note: { $exists: false } }))).toEqual(['a', 'c']);
      expect(titles(await s.findWhere({ note: { $exists: true } }))).toEqual(['b']);
    });

    it.each(['dual', 'pg-read'])('%s: refuses a $in or $exists Postgres could not run the same, before any read',
      async (mode) => {
        process.env[ENV] = mode;
        const pg = presencePg();
        const s = filtered(pg);
        await seed(s);
        pg.calls.length = 0;
        const find = jest.spyOn(Widget, 'find');
        await expect(s.findWhere({ title: { $in: [] } })).rejects.toThrow(/non-empty array/);
        await expect(s.findWhere({ title: { $in: 'a' } })).rejects.toThrow(/non-empty array/);
        await expect(s.findWhere({ title: { $in: ['a', null] } })).rejects.toThrow(/holding null/);
        // Mongo would match a RegExp as a pattern; the cast would make it a literal "/^a/" in Postgres.
        await expect(s.findWhere({ title: { $in: ['b', /^a/] } })).rejects.toThrow(/regular expression/);
        await expect(s.findWhere({ title: /^a/ })).rejects.toThrow(/regular expression/);
        await expect(s.findWhere({ title: { $gte: /^a/ } })).rejects.toThrow(/regular expression/);
        await expect(s.findWhere({ count: { $in: [1], $gt: 0 } })).rejects.toThrow(/cannot combine \$in/);
        // title can be written as null, so Postgres could not tell it from missing.
        await expect(s.findWhere({ title: { $exists: false } })).rejects.toThrow(/not a declared presence column/);
        await expect(s.findWhere({ note: { $exists: 0 } })).rejects.toThrow(/true or false/);
        await expect(s.findOneWhere({ note: { $exists: true, $gt: 'a' } })).rejects.toThrow(/cannot combine \$exists/);
        expect(find).not.toHaveBeenCalled();
        expect(pg.calls).toEqual([]);
      });

    it('refuses $exists on every column of a store that declares no presence columns', async () => {
      process.env[ENV] = 'pg-read';
      const pg = fakePg();
      const s = filtered(pg);
      await expect(s.findWhere({ note: { $exists: false } })).rejects.toThrow(/not a declared presence column/);
      expect(pg.calls).toEqual([]);
    });

    describe("the Postgres adapter's $in and $exists", () => {
      const recordingPool = () => {
        const queries = [];
        return {
          queries,
          query: async (sql, params) => {
            queries.push({ sql, params });
            return { rows: [], rowCount: 0 };
          },
        };
      };
      const adapter = (pool) => pgTableAdapter({
        pool,
        table: 'widgets',
        idColumn: 'id',
        columns: ['title', 'seen_at', 'payload'],
        jsonColumns: ['payload'],
        presenceColumns: ['seen_at'],
      });

      it('binds a $in list as one array parameter and $exists as IS [NOT] NULL', async () => {
        const pool = recordingPool();
        const since = new Date('2026-01-01T00:00:00Z');
        await adapter(pool).findWhere({
          title: { $in: ["a'; DROP TABLE x; --", 'b'] }, id: { $in: ['x1'] }, seen_at: { $exists: false },
        });
        await adapter(pool).findWhere({ seen_at: { $exists: true }, title: { $in: [since] } }, 2);
        const [first, second] = pool.queries;
        expect(first.sql).toContain('WHERE title = ANY($1) AND id = ANY($2) AND seen_at IS NULL ORDER BY');
        expect(first.params).toEqual([["a'; DROP TABLE x; --", 'b'], ['x1']]);
        expect(first.sql).not.toContain('DROP');
        expect(second.sql).toContain('WHERE seen_at IS NOT NULL AND title = ANY($1) ORDER BY id COLLATE "C" LIMIT $2');
        expect(second.params).toEqual([[since], 2]);
        expect(adapter(pool).presenceColumns).toEqual(['seen_at']);
      });

      it.each([
        ['an empty $in', { title: { $in: [] } }, /\$in needs a non-empty array/],
        ['a $in that is not an array', { title: { $in: 'a' } }, /\$in needs a non-empty array/],
        ['a null $in element', { title: { $in: ['a', null] } }, /never null/],
        ['an object $in element', { title: { $in: [{ $literal: 'a' }] } }, /never null/],
        ['$in on a JSON column', { payload: { $in: ['a'] } }, /is JSON/],
        ['$in mixed with a range', { title: { $in: ['a'], $gt: 'a' } }, /\$in cannot be combined/],
        ['$exists on an undeclared presence column', { title: { $exists: false } },
          /\$exists is not allowed on widgets.title/],
        ['$exists on the id column', { id: { $exists: true } }, /\$exists is not allowed/],
        ['a $exists that is not a boolean', { seen_at: { $exists: 1 } }, /true or false/],
        ['$exists mixed with a range', { seen_at: { $exists: true, $lt: new Date() } }, /\$exists cannot be combined/],
      ])('refuses %s before any query', async (_, where, message) => {
        const pool = recordingPool();
        await expect(adapter(pool).findWhere(where)).rejects.toThrow(message);
        expect(pool.queries).toEqual([]);
      });

      it('refuses a presence column that is not a plain declared column', () => {
        const pool = recordingPool();
        const base = {
          pool, table: 'widgets', idColumn: 'id', columns: ['title', 'payload'], jsonColumns: ['payload'],
        };
        expect(() => pgTableAdapter({ ...base, presenceColumns: ['missing'] })).toThrow(/presenceColumns/);
        expect(() => pgTableAdapter({ ...base, presenceColumns: ['payload'] })).toThrow(/presenceColumns/);
        expect(() => pgTableAdapter({ ...base, presenceColumns: ['id'] })).toThrow(/presenceColumns/);
      });
    });

    describe('updateManyWhere', () => {
      const tag = [{ $set: { note: { $literal: 'tagged' } } }];

      it('mongo: one updateMany, no markers and no Postgres call', async () => {
        const pg = presencePg();
        const s = filtered(pg);
        await seed(s);
        const updateMany = jest.spyOn(Widget, 'updateMany');
        expect(await s.updateManyWhere({ count: { $gte: 2 }, note: { $exists: false } }, tag)).toBe(1);
        expect(updateMany).toHaveBeenCalledTimes(1);
        expect((await Widget.findOne({ title: 'c' }).lean())).toMatchObject({ note: 'tagged' });
        expect((await Widget.findOne({ title: 'c' }).lean()).pgVersion).toBeUndefined();
        expect(pg.calls).toEqual([]);
      });

      it.each(['dual', 'pg-read'])('%s: changes only matching documents, each with its own version and one copy',
        async (mode) => {
          process.env[ENV] = mode;
          const pg = presencePg();
          const s = filtered(pg);
          const { a, b, c } = await seed(s);
          pg.calls.length = 0;
          expect(await s.updateManyWhere(
            { _id: { $in: [a._id, b._id, c._id] }, note: { $exists: false } }, tag,
          )).toBe(2);
          expect(pg.calls.filter((call) => call === 'upsert')).toHaveLength(2);
          for (const doc of [a, c]) {
            // eslint-disable-next-line no-await-in-loop
            const raw = await Widget.findById(doc._id).lean();
            expect(raw).toMatchObject({ note: 'tagged', pgVersion: 2 });
            expect(raw.pgPending).toBeUndefined();
            expect(pg.rows.get(String(doc._id))).toEqual({ row: toRow(raw), version: 2 });
          }
          const untouched = await Widget.findById(b._id).lean();
          expect(untouched).toMatchObject({ note: 'held', pgVersion: 1 });
          expect(pg.rows.get(String(b._id)).version).toBe(1);
          // A second pass matches nothing and writes nothing.
          pg.calls.length = 0;
          expect(await s.updateManyWhere({ _id: { $in: [a._id, c._id] }, note: { $exists: false } }, tag)).toBe(0);
          expect(pg.calls).toEqual([]);
        });

      it('dual: a document that stops matching between the find and its write is skipped', async () => {
        process.env[ENV] = 'dual';
        const pg = presencePg();
        const s = filtered(pg);
        const { a, c } = await seed(s);
        // Hold a's copy; c changes under the loop before its own write.
        const hold = pg.hold('upsert');
        const running = s.updateManyWhere({ title: { $in: ['a', 'c'] }, note: { $exists: false } }, tag);
        await hold.arrived;
        await s.update(c._id, { note: 'someone else' });
        hold.release();
        expect(await running).toBe(1);
        expect(await Widget.findById(a._id).lean()).toMatchObject({ note: 'tagged', pgVersion: 2 });
        const raw = await Widget.findById(c._id).lean();
        expect(raw).toMatchObject({ note: 'someone else', pgVersion: 2 });
        expect(pg.rows.get(String(c._id))).toEqual({ row: toRow(raw), version: 2 });
      });

      it('dual: a failed copy counts the write and leaves its marker for repair', async () => {
        process.env[ENV] = 'dual';
        const pg = presencePg();
        const s = filtered(pg);
        const { a, c } = await seed(s);
        pg.failNext('upsert');
        expect(await s.updateManyWhere({ note: { $exists: false } }, tag)).toBe(2);
        expect((await Widget.findById(a._id).lean()).pgPending).toBe(2);
        expect(pg.rows.get(String(a._id)).version).toBe(1);
        expect((await Widget.findById(c._id).lean()).pgPending).toBeUndefined();
        expect(await s.repair()).toMatchObject({ copied: 1, failed: 0 });
        const raw = await Widget.findById(a._id).lean();
        expect(pg.rows.get(String(a._id))).toEqual({ row: toRow(raw), version: 2 });
      });

      it('refuses empty stages, and pg mode before any write', async () => {
        process.env[ENV] = 'dual';
        const pg = presencePg();
        const s = filtered(pg);
        await seed(s);
        await expect(s.updateManyWhere({ title: 'a' }, [])).rejects.toThrow(/needs pipeline stages/);
        process.env[ENV] = 'pg';
        pg.calls.length = 0;
        await expect(s.updateManyWhere({ title: 'a' }, tag)).rejects.toThrow(/not supported in pg mode until step 4/);
        expect(pg.calls).toEqual([]);
        expect(await Widget.countDocuments({ note: 'tagged' })).toBe(0);
      });
    });
  });

  describe('19. fields the schema hides with select: false', () => {
    const hiddenSchema = new mongoose.Schema({
      title: String, secret: { type: String, select: false }, note: String,
    }, { timestamps: true });
    dualStorePlugin(hiddenSchema);
    const Locker = mongoose.models.DualStoreTestLocker || mongoose.model('DualStoreTestLocker', hiddenSchema);
    const LOCKER_ENV = 'STORE_MODE_DUAL_STORE_TEST_LOCKER';
    const lockerRow = (doc) => ({
      id: String(doc._id),
      title: doc.title ?? null,
      secret: doc.secret ?? null,
      note: doc.note ?? null,
      created_at: doc.createdAt ?? null,
      updated_at: doc.updatedAt ?? null,
    });
    const lockerFromRow = (row) => ({
      _id: new mongoose.Types.ObjectId(row.id),
      ...(row.title != null && { title: row.title }),
      ...(row.secret != null && { secret: row.secret }),
      ...(row.note != null && { note: row.note }),
      ...(row.created_at != null && { createdAt: new Date(row.created_at) }),
      ...(row.updated_at != null && { updatedAt: new Date(row.updated_at) }),
    });
    const lockers = (pg) => createDualStore({
      name: 'DualStoreTestLocker',
      model: Locker,
      pg,
      toRow: lockerRow,
      fromRow: lockerFromRow,
      sampleRate: 1,
      filterColumns: { _id: 'id', title: 'title', note: 'note' },
    });
    // Obviously fake secrets.
    const SECRET = 'fake-secret-0001';
    const rawWithSecret = (id) => Locker.findById(id).select('+secret').lean();
    const secretOf = (pg, id) => pg.rows.get(String(id))?.row.secret;

    beforeEach(async () => { await Locker.deleteMany({}); });
    afterEach(() => { delete process.env[LOCKER_ENV]; });

    it.each(['dual', 'pg-read'])('%s: every copy keeps the hidden field, and no write hands it back', async (mode) => {
      process.env[LOCKER_ENV] = mode;
      const pg = fakePg();
      const s = lockers(pg);
      const created = await s.create({ title: 'a', secret: SECRET });
      // create answers as Mongoose's create does: with what the caller just wrote.
      expect(created.secret).toBe(SECRET);
      expect(secretOf(pg, created._id)).toBe(SECRET);

      const updated = await s.update(created._id, { title: 'b' });
      expect(updated).toMatchObject({ title: 'b' });
      expect('secret' in updated).toBe(false);
      expect(pg.rows.get(String(created._id)))
        .toEqual({ row: lockerRow(await rawWithSecret(created._id)), version: 2 });

      // Each write's row is checked before the next write, which would restore a lost secret.
      expect(await s.updateWhere({ _id: created._id }, [{ $set: { note: { $literal: 'n' } } }])).toBe(true);
      expect(pg.rows.get(String(created._id)))
        .toEqual({ row: lockerRow(await rawWithSecret(created._id)), version: 3 });
      expect(await s.setWhere({ _id: created._id }, { title: 'c' })).toBe(true);
      expect(pg.rows.get(String(created._id)))
        .toEqual({ row: lockerRow(await rawWithSecret(created._id)), version: 4 });
      const upserted = await s.upsert(created._id, {
        pipeline: [{ $set: { note: { $literal: 'u' } } }], merge: (current) => ({ ...current, note: 'u' }),
      });
      expect('secret' in upserted).toBe(false);
      expect(pg.rows.get(String(created._id)))
        .toEqual({ row: lockerRow(await rawWithSecret(created._id)), version: 5 });
      const other = await s.create({ title: 'z', secret: 'fake-secret-0002' });
      expect(await s.updateManyWhere({ title: { $in: ['c', 'z'] } }, [{ $set: { note: { $literal: 'm' } } }])).toBe(2);
      expect(secretOf(pg, created._id)).toBe(SECRET);
      expect(secretOf(pg, other._id)).toBe('fake-secret-0002');
      expect(pg.rows.get(String(created._id)))
        .toEqual({ row: lockerRow(await rawWithSecret(created._id)), version: 6 });
      expect(await s.insertIfAbsent({ title: 'fresh' }, { secret: 'fake-secret-0003' })).toEqual({ inserted: true });
      const fresh = await Locker.findOne({ title: 'fresh' }).lean();
      expect(secretOf(pg, fresh._id)).toBe('fake-secret-0003');
      expect(dualStoreStats('DualStoreTestLocker')).toMatchObject({ differs: 0, missing: 0, 'pg-write-failed': 0 });
    });

    it('dual: repair and backfill, its deferred re-read included, copy the hidden field', async () => {
      process.env[LOCKER_ENV] = 'dual';
      const pg = fakePg();
      const s = lockers(pg);
      const doc = await s.create({ title: 'a', secret: SECRET });
      pg.failNext('upsert');
      await s.update(doc._id, { title: 'b' });
      expect(secretOf(pg, doc._id)).toBe(SECRET);
      expect(pg.rows.get(String(doc._id)).version).toBe(1);
      expect(await s.repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(pg.rows.get(String(doc._id))).toEqual({ row: lockerRow(await rawWithSecret(doc._id)), version: 2 });

      // Written before dual, one of them still flagged, so backfill defers and re-reads it.
      const plainOne = await Locker.collection.insertOne({ title: 'old', secret: 'fake-secret-0004' });
      const pendingOne = await Locker.collection.insertOne({
        title: 'pending', secret: 'fake-secret-0005', pgVersion: 1, pgPending: 1,
      });
      expect(await s.backfill({ dryRun: false })).toMatchObject({ scanned: 3, deferredPending: 1 });
      expect(secretOf(pg, plainOne.insertedId)).toBe('fake-secret-0004');
      expect(secretOf(pg, pendingOne.insertedId)).toBe('fake-secret-0005');
    });

    it('dual: verify compares the hidden field: equal stores equal, a changed secret different', async () => {
      process.env[LOCKER_ENV] = 'dual';
      const pg = fakePg();
      const s = lockers(pg);
      const doc = await s.create({ title: 'a', secret: SECRET });
      await s.create({ title: 'b', secret: 'fake-secret-0006' });
      const equal = await s.verify();
      expect(equal).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      expect(equal.checksumMongo).toBe(equal.checksumPg);
      pg.rows.get(String(doc._id)).row.secret = 'fake-secret-tampered';
      const changed = await s.verify();
      expect(changed).toMatchObject({ differs: 1 });
      expect(changed.checksumMongo).not.toBe(changed.checksumPg);
      expect(logged()).toContain('fields=secret');
    });

    it.each(['mongo', 'dual', 'pg-read'])('%s: reads leave the hidden field out unless named', async (mode) => {
      process.env[LOCKER_ENV] = 'dual';
      const pg = fakePg();
      const s = lockers(pg);
      const doc = await s.create({ title: 'a', secret: SECRET, note: 'n' });
      if (mode === 'mongo') delete process.env[LOCKER_ENV];
      else process.env[LOCKER_ENV] = mode;
      pg.calls.length = 0;
      const byId = await s.findById(doc._id);
      expect(byId).toMatchObject({ title: 'a', note: 'n' });
      expect('secret' in byId).toBe(false);
      const one = await s.findOneWhere({ title: 'a' });
      expect(one).toMatchObject({ title: 'a' });
      expect('secret' in one).toBe(false);
      const [listed] = await s.findWhere({ note: 'n' });
      expect('secret' in listed).toBe(false);
      expect(await s.findOneWhere({ title: 'a' }, { fields: ['note'] })).toEqual({ _id: doc._id, note: 'n' });
      expect(await s.findOneWhere({ title: 'a' }, { fields: ['secret'] })).toEqual({ _id: doc._id, secret: SECRET });
      expect(pg.calls.includes('findWhere')).toBe(mode === 'pg-read');
    });

    it('pg: writes and reads from Postgres leave the hidden field out too', async () => {
      process.env[LOCKER_ENV] = 'pg';
      const pg = fakePg();
      const s = lockers(pg);
      const doc = await s.create({ title: 'a', secret: SECRET });
      expect(secretOf(pg, doc._id)).toBe(SECRET);
      const updated = await s.update(doc._id, { title: 'b' });
      expect('secret' in updated).toBe(false);
      expect(secretOf(pg, doc._id)).toBe(SECRET);
      expect('secret' in await s.findById(doc._id)).toBe(false);
    });

    it('refuses a nested hidden path, which it could not strip', () => {
      const nested = new mongoose.Schema({ inner: { key: { type: String, select: false } } });
      dualStorePlugin(nested);
      const Nested = mongoose.models.DualStoreTestNested || mongoose.model('DualStoreTestNested', nested);
      expect(() => createDualStore({
        name: 'DualStoreTestNested', model: Nested, pg: fakePg(), toRow, fromRow,
      })).toThrow(/nested path/);
    });

    it.each([
      ['a sub-document', (sub) => ({ sub })],
      ['an array of sub-documents', (sub) => ({ subs: [sub] })],
      ['a sub-document two levels down', (sub) => ({ outer: new mongoose.Schema({ sub }) })],
    ])('refuses a hidden path inside %s, which eachPath alone would miss', (label, shape) => {
      const sub = new mongoose.Schema({ key: { type: String, select: false } });
      const schema = new mongoose.Schema(shape(sub));
      dualStorePlugin(schema);
      const modelName = `DualStoreTestHiddenInside${label.replace(/[^a-z]/gi, '')}`;
      const Inside = mongoose.models[modelName] || mongoose.model(modelName, schema);
      expect(() => createDualStore({
        name: modelName, model: Inside, pg: fakePg(), toRow, fromRow,
      })).toThrow(/nested path/);
    });

    it('accepts sub-documents with nothing hidden', () => {
      const sub = new mongoose.Schema({ key: String });
      const schema = new mongoose.Schema({ sub, subs: [sub] });
      dualStorePlugin(schema);
      const Plain = mongoose.models.DualStoreTestPlainSubs || mongoose.model('DualStoreTestPlainSubs', schema);
      expect(() => createDualStore({
        name: 'DualStoreTestPlainSubs', model: Plain, pg: fakePg(), toRow, fromRow,
      })).not.toThrow();
    });

    it('a model with no hidden path never adds a projection: the old query runs unchanged', async () => {
      // The seven live models have no select: false path, so this is their path.
      process.env[ENV] = 'dual';
      const select = jest.spyOn(mongoose.Query.prototype, 'select');
      const pg = fakePg();
      const s = store(pg, { sampleRate: 1, filterColumns: { _id: 'id', title: 'title' } });
      const doc = await s.create({ title: 'a' });
      await s.update(doc._id, { count: 1 });
      await s.updateWhere({ _id: doc._id }, [{ $set: { note: { $literal: 'x' } } }]);
      await s.setWhere({ _id: doc._id }, { title: 'b' });
      await s.upsert(doc._id, { pipeline: [{ $set: { count: 2 } }], merge: (c) => ({ ...c, count: 2 }) });
      await s.insertIfAbsent({ title: 'c' }, {});
      await s.updateManyWhere({ title: { $in: ['b', 'c'] } }, [{ $set: { note: { $literal: 'y' } } }]);
      await s.findById(doc._id);
      await s.findWhere({ title: 'b' });
      pg.failNext('upsert');
      await s.update(doc._id, { count: 3 });
      await s.repair();
      await s.backfill({ dryRun: false });
      await s.verify();
      process.env[ENV] = 'pg-read';
      await s.findOneWhere({ title: 'b' });
      await s.findById(doc._id);
      // Mongoose calls select itself for a projection argument; the helper's
      // reveal is the only caller that passes a +path.
      const reveals = select.mock.calls.filter(([projection]) => typeof projection === 'string'
        && projection.includes('+'));
      expect(reveals).toEqual([]);
      // Positive control: the spy does see a reveal on a model with a hidden path.
      await lockers(fakePg()).findById(new mongoose.Types.ObjectId());
      expect(select.mock.calls.filter(([projection]) => projection === '+secret')).toHaveLength(1);
    });
  });
});
