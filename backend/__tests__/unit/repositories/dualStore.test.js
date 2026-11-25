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
      const hold = pg.hold('upsert');
      const writing = s.upsert(key, raise(2));
      await hold.arrived;
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
        scanned: 4, inserted: 2, alreadyCurrent: 1, skippedPending: 1,
      });
      expect(pg.calls.filter((c) => c === 'upsert')).toHaveLength(1);
      expect(pg.rows.size).toBe(1);

      expect(await s.backfill({ dryRun: false, batchSize: 2 })).toEqual({
        scanned: 4, inserted: 2, alreadyCurrent: 1, skippedPending: 1,
      });
      expect(pg.rows.size).toBe(3);
      const history = await Widget.findOne({ title: 'history' }).lean();
      expect(pg.rows.get(String(history._id))).toEqual({ row: toRow(history), version: 0 });
      expect(pg.rows.get(String(current._id)).version).toBe(1);
      expect(await s.backfill({ dryRun: false })).toMatchObject({ inserted: 0, alreadyCurrent: 3 });
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
        scanned: 2, inserted: 2, alreadyCurrent: 0, skippedPending: 0,
      });
      expect(pg.rows.get(String(b.insertedId))).toMatchObject({ row: { title: 'B' }, version: 2 });
      expect(pg.rows.has(String(a.insertedId))).toBe(true);
      expect(await s.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
      // One still pending at the end stays repair's, and is counted.
      await Widget.updateOne({ _id: b.insertedId }, { $set: { pgVersion: 3, pgPending: 3 } });
      expect(await s.backfill({ dryRun: false })).toMatchObject({ skippedPending: 1 });
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
});
