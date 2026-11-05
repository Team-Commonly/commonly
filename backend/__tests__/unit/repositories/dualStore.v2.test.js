/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 F0: the dual-store helper's second half, which Wave 1's callers need.
 * They read by field, write with operators ($inc, $max, $push, upserts), and
 * update or delete many documents at once; Wave 0's helper was by-id only.
 *
 * Every write still goes through the same marker (pgVersion/pgPending), so a
 * crash leaves a flagged document that repair finishes. Reads by field take
 * both halves from the caller: the Mongo filter and a Postgres query, because
 * a model's repository knows its own few query shapes and a generic
 * Mongo-to-SQL translator is the thing ADR-034 chose not to build.
 */
const mongoose = require('mongoose');
const {
  applyUpdateOperators, createDualStore, dualStorePlugin, dualStoreStats, resetDualStoreStats,
} = require('../../../repositories/dualStore');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakeDualStorePg');

const schema = new mongoose.Schema({
  owner: String, title: String, count: Number, peak: Number, tags: [String], note: String, firstSeen: Date,
});
schema.index({ owner: 1, title: 1 }, { unique: true });
dualStorePlugin(schema);
const Gadget = mongoose.models.DualStoreV2Gadget || mongoose.model('DualStoreV2Gadget', schema);

const ENV = 'STORE_MODE_DUAL_STORE_V2_GADGET';
const NAME = 'DualStoreV2Gadget';
const FIELDS = ['owner', 'title', 'count', 'peak', 'tags', 'note', 'firstSeen'];
const toRow = (doc) => ({
  id: String(doc._id),
  ...Object.fromEntries(FIELDS.map((f) => [f, doc[f] instanceof Date ? doc[f].toISOString() : (doc[f] ?? null)])),
});
const fromRow = (row) => ({
  _id: new mongoose.Types.ObjectId(row.id),
  ...Object.fromEntries(FIELDS.filter((f) => row[f] != null)
    .map((f) => [f, f === 'firstSeen' ? new Date(row[f]) : row[f]])),
});

// The Postgres half of a read, the way a repository writes it: here, a scan of
// the fake's rows. A real repository runs its own SQL.
const pgWhere = (pg, predicate) => async () => [...pg.rows.values()].map((r) => r.row).filter(predicate);

const store = (pg) => createDualStore({
  name: NAME, model: Gadget, pg, toRow, fromRow, sampleRate: 1,
});
const ids = (docs) => docs.map((d) => String(d._id)).sort();

describe('dual-store helper v2 (ADR-034 F0)', () => {
  let warn;
  beforeAll(async () => {
    await setupMongoDb();
    await Gadget.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await Gadget.deleteMany({});
    resetDualStoreStats();
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    delete process.env[ENV];
  });

  describe('applyUpdateOperators (pg mode applies an update in process)', () => {
    it('applies $set, $unset, $inc, $max, $min, $push, $push $each and dotted paths', () => {
      const doc = { a: 1, b: 2, c: 5, d: 5, tags: ['x'], nested: { n: 1 } };
      expect(applyUpdateOperators(doc, {
        $set: { a: 10, 'nested.m': 2 },
        $unset: { b: 1 },
        $inc: { c: 2, fresh: 3 },
        $max: { d: 9, e: 4 },
        $min: { d: 7 },
        $push: { tags: 'y', more: { $each: ['p', 'q'] } },
      })).toEqual({
        a: 10, c: 7, d: 7, e: 4, tags: ['x', 'y'], more: ['p', 'q'], fresh: 3, nested: { n: 1, m: 2 },
      });
      // The input is not mutated.
      expect(doc).toEqual({ a: 1, b: 2, c: 5, d: 5, tags: ['x'], nested: { n: 1 } });
    });

    it('applies $setOnInsert only when inserting', () => {
      expect(applyUpdateOperators({ a: 1 }, { $setOnInsert: { a: 2, b: 3 } })).toEqual({ a: 1 });
      expect(applyUpdateOperators({}, { $setOnInsert: { a: 2 } }, { inserting: true })).toEqual({ a: 2 });
    });

    it('refuses an operator it does not implement, rather than dropping it', () => {
      expect(() => applyUpdateOperators({}, { $rename: { a: 'b' } })).toThrow(/\$rename/);
      expect(() => applyUpdateOperators({}, { $push: { t: { $each: [1], $slice: 2 } } })).toThrow(/\$slice/);
      expect(() => applyUpdateOperators({}, { plain: 1 })).toThrow(/operator/);
    });
  });

  describe.each(['dual', 'pg-read'])('%s writes', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('updateOne applies operators in Mongo and copies the result, clearing the marker', async () => {
      const pg = fakePg();
      const s = store(pg);
      const made = await s.create({ owner: 'o', title: 't', count: 1, peak: 3, tags: ['a'] });

      const doc = await s.updateOne({ owner: 'o', title: 't' }, {
        $inc: { count: 2 }, $max: { peak: 2 }, $push: { tags: 'b' }, $set: { note: '$5 off' },
      });

      expect(doc).toMatchObject({ count: 3, peak: 3, tags: ['a', 'b'], note: '$5 off' });
      const stored = await Gadget.findById(made._id).lean();
      expect(stored.pgPending).toBeUndefined();
      expect(stored.pgVersion).toBe(2);
      expect(pg.rows.get(String(made._id))).toEqual({ row: toRow(stored), version: 2 });
    });

    it('updateOne with no match returns null and writes nothing', async () => {
      const pg = fakePg();
      expect(await store(pg).updateOne({ owner: 'nobody' }, { $inc: { count: 1 } })).toBeNull();
      expect(pg.calls).not.toContain('upsert');
    });

    it('an upsert inserts with the filter\'s equality fields, $setOnInsert and the operators', async () => {
      const pg = fakePg();
      const s = store(pg);
      const when = new Date('2026-11-05T00:00:00Z');

      const first = await s.updateOne({ owner: 'o', title: 't' }, {
        $setOnInsert: { firstSeen: when }, $inc: { count: 1 }, $max: { peak: 4 }, $push: { tags: 'a' },
      }, { upsert: true });
      const second = await s.updateOne({ owner: 'o', title: 't' }, {
        $setOnInsert: { firstSeen: new Date() }, $inc: { count: 1 }, $max: { peak: 2 }, $push: { tags: 'b' },
      }, { upsert: true });

      expect(first).toMatchObject({ owner: 'o', title: 't', count: 1, peak: 4, tags: ['a'], firstSeen: when });
      expect(second).toMatchObject({ count: 2, peak: 4, tags: ['a', 'b'], firstSeen: when });
      expect(await Gadget.countDocuments({})).toBe(1);
      const stored = await Gadget.findById(first._id).lean();
      expect(pg.rows.get(String(first._id)).row).toEqual(toRow(stored));
    });

    it('two racing upserts make one document: the loser retries as an update', async () => {
      const pg = fakePg();
      const s = store(pg);
      await Promise.all([1, 2, 3].map(() => s.updateOne({ owner: 'race', title: 't' }, { $inc: { count: 1 } }, { upsert: true })));

      const docs = await Gadget.find({ owner: 'race' }).lean();
      expect(docs).toHaveLength(1);
      expect(docs[0].count).toBe(3);
      expect(pg.rows.get(String(docs[0]._id)).row.count).toBe(3);
    });

    it('updateMany changes every match, copies each, and leaves the rest alone', async () => {
      const pg = fakePg();
      const s = store(pg);
      const a = await s.create({ owner: 'o', title: 'a', count: 1 });
      const b = await s.create({ owner: 'o', title: 'b', count: 2 });
      const other = await s.create({ owner: 'x', title: 'c', count: 9 });

      expect(await s.updateMany({ owner: 'o' }, { $inc: { count: 10 } })).toEqual({ matched: 2 });

      expect(pg.rows.get(String(a._id)).row.count).toBe(11);
      expect(pg.rows.get(String(b._id)).row.count).toBe(12);
      expect(pg.rows.get(String(other._id))).toEqual({ row: toRow(other), version: 1 });
      expect(await Gadget.countDocuments({ pgPending: { $exists: true } })).toBe(0);
    });

    it('a copy that fails leaves the document flagged, and repair finishes it', async () => {
      const pg = fakePg();
      const s = store(pg);
      const a = await s.create({ owner: 'o', title: 'a', count: 1 });
      pg.failNext('upsert');

      await s.updateMany({ owner: 'o' }, { $inc: { count: 1 } });

      expect((await Gadget.findById(a._id).lean()).pgPending).toBe(2);
      expect(dualStoreStats(NAME)['pg-write-failed']).toBe(1);
      expect(await s.repair()).toMatchObject({ copied: 1, failed: 0 });
      expect(pg.rows.get(String(a._id)).row.count).toBe(2);
    });

    it('deleteMany removes every match from both stores and nothing else', async () => {
      const pg = fakePg();
      const s = store(pg);
      const a = await s.create({ owner: 'o', title: 'a' });
      const b = await s.create({ owner: 'o', title: 'b' });
      const keep = await s.create({ owner: 'x', title: 'c' });

      expect(await s.deleteMany({ owner: 'o' })).toEqual({ deleted: 2 });

      expect(await Gadget.countDocuments({})).toBe(1);
      expect(pg.rows.has(String(a._id))).toBe(false);
      expect(pg.rows.has(String(b._id))).toBe(false);
      expect(pg.rows.has(String(keep._id))).toBe(true);
    });

    it('deleteOne removes only the first match', async () => {
      const pg = fakePg();
      const s = store(pg);
      await s.create({ owner: 'o', title: 'a' });
      await s.create({ owner: 'o', title: 'b' });

      expect(await s.deleteOne({ owner: 'o' })).toEqual({ deleted: 1 });
      expect(await Gadget.countDocuments({})).toBe(1);
      expect(pg.rows.size).toBe(1);
    });
  });

  describe('filter reads', () => {
    const seed = async (pg) => {
      const s = store(pg);
      process.env[ENV] = 'dual';
      const docs = [];
      for (const [title, count] of [['a', 1], ['b', 2], ['c', 3]]) {
        // eslint-disable-next-line no-await-in-loop
        docs.push(await s.create({ owner: 'o', title, count }));
      }
      return { s, docs };
    };

    it('mongo and dual read Mongo; dual compares what it read against Postgres', async () => {
      const pg = fakePg();
      const { s, docs } = await seed(pg);
      pg.rows.get(String(docs[1]._id)).row.count = 99;
      const pgQuery = pgWhere(pg, (r) => r.owner === 'o');

      const found = await s.find({ mongo: { owner: 'o' }, pg: pgQuery, sort: { title: 1 } });

      expect(found.map((d) => d.title)).toEqual(['a', 'b', 'c']);
      expect(found[1].count).toBe(2);
      expect(dualStoreStats(NAME).differs).toBe(1);
      process.env[ENV] = 'mongo';
      expect(ids(await s.find({ mongo: { owner: 'o' }, pg: pgQuery }))).toEqual(ids(docs));
    });

    it('pg-read reads Postgres, and Mongo while any document is flagged', async () => {
      const pg = fakePg();
      const { s, docs } = await seed(pg);
      process.env[ENV] = 'pg-read';
      pg.rows.get(String(docs[0]._id)).row.note = 'only in pg';
      const read = () => s.find({ mongo: { owner: 'o' }, pg: pgWhere(pg, (r) => r.owner === 'o') });

      expect((await read()).find((d) => d.title === 'a').note).toBe('only in pg');

      await Gadget.updateOne({ _id: docs[2]._id }, { $set: { pgPending: 9 } });
      const fresh = store(pg); // a new instance asks Mongo, no cached flag
      expect((await fresh.find({ mongo: { owner: 'o' }, pg: pgWhere(pg, (r) => r.owner === 'o') }))
        .find((d) => d.title === 'a').note).toBeUndefined();
    });

    it('findOne returns the first match or null, in every mode', async () => {
      const pg = fakePg();
      const { s } = await seed(pg);
      for (const mode of ['mongo', 'dual', 'pg-read', 'pg']) {
        process.env[ENV] = mode;
        // eslint-disable-next-line no-await-in-loop
        const one = await s.findOne({ mongo: { title: 'b' }, pg: pgWhere(pg, (r) => r.title === 'b') });
        expect(one).toMatchObject({ title: 'b', count: 2 });
        // eslint-disable-next-line no-await-in-loop
        expect(await s.findOne({ mongo: { title: 'z' }, pg: pgWhere(pg, () => false) })).toBeNull();
      }
    });

    it('a read never returns a document mid-delete', async () => {
      const pg = fakePg();
      const { s, docs } = await seed(pg);
      await Gadget.updateOne({ _id: docs[0]._id }, { $set: { pgDeleted: true } });
      expect((await s.find({ mongo: { owner: 'o' }, pg: pgWhere(pg, () => true) })).map((d) => d.title)).toEqual(['b', 'c']);
    });
  });

  describe('pg mode', () => {
    it('updateMany, upsert and deleteMany work on Postgres alone, by the ids the caller selects', async () => {
      const pg = fakePg();
      const s = store(pg);
      process.env[ENV] = 'pg';
      const a = await s.create({ owner: 'o', title: 'a', count: 1 });
      await s.create({ owner: 'o', title: 'b', count: 2 });
      const byOwner = pgWhere(pg, (r) => r.owner === 'o');

      expect(await s.updateMany({ owner: 'o' }, { $inc: { count: 5 } }, { pg: byOwner })).toEqual({ matched: 2 });
      expect(pg.rows.get(String(a._id)).row.count).toBe(6);

      const up = await s.updateOne({ owner: 'n', title: 'new' }, { $inc: { count: 1 }, $setOnInsert: { note: 'hi' } },
        { upsert: true, pg: pgWhere(pg, (r) => r.owner === 'n') });
      expect(up).toMatchObject({ owner: 'n', title: 'new', count: 1, note: 'hi' });

      expect(await s.deleteMany({ owner: 'o' }, { pg: byOwner })).toEqual({ deleted: 2 });
      expect([...pg.rows.values()].map((r) => r.row.title)).toEqual(['new']);
      expect(await Gadget.countDocuments({})).toBe(0);
    });

    it('a filter write in pg mode without its Postgres query is refused, not run against nothing', async () => {
      process.env[ENV] = 'pg';
      await expect(store(fakePg()).updateMany({ owner: 'o' }, { $inc: { count: 1 } }))
        .rejects.toThrow(/Postgres query/);
    });
  });

  describe('backfill and verify', () => {
    it('backfill copies every Mongo document; verify then reports zero mismatches', async () => {
      const pg = fakePg();
      // Written while the model was still mongo-only: no row, no marker.
      await Gadget.create([{ owner: 'o', title: 'a', count: 1 }, { owner: 'o', title: 'b', count: 2 }]);
      process.env[ENV] = 'dual';
      const s = store(pg);

      expect((await s.verify()).missing).toHaveLength(2);
      expect(await s.backfill({ batch: 1 })).toEqual({ scanned: 2, copied: 2, failed: 0 });
      expect(await s.verify()).toEqual({
        checked: 2, pending: 0, missing: [], differs: [], pgOnly: [],
      });
    });

    it('verify names each kind of mismatch: missing, differs (with fields), pgOnly, pending', async () => {
      const pg = fakePg();
      process.env[ENV] = 'dual';
      const s = store(pg);
      const a = await s.create({ owner: 'o', title: 'a', count: 1 });
      const b = await s.create({ owner: 'o', title: 'b', count: 2 });
      const c = await s.create({ owner: 'o', title: 'c', count: 3 });
      pg.rows.delete(String(a._id));
      pg.rows.get(String(b._id)).row.count = 20;
      pg.rows.set('ffffffffffffffffffffffff', { row: { id: 'ffffffffffffffffffffffff', owner: 'ghost' }, version: 1 });
      await Gadget.updateOne({ _id: c._id }, { $set: { pgPending: 5 } });

      const report = await s.verify();

      expect(report.missing).toEqual([String(a._id)]);
      expect(report.differs).toEqual([{ id: String(b._id), fields: ['count'] }]);
      expect(report.pgOnly).toEqual(['ffffffffffffffffffffffff']);
      expect(report.pending).toBe(1);
    });

    it('backfill is safe to run twice and against live writes', async () => {
      const pg = fakePg();
      await Gadget.create({ owner: 'o', title: 'a', count: 1 });
      process.env[ENV] = 'dual';
      const s = store(pg);
      await s.backfill();
      await s.updateOne({ title: 'a' }, { $inc: { count: 1 } });
      await s.backfill();

      expect((await s.verify()).differs).toEqual([]);
      expect(pg.rows.size).toBe(1);
      expect([...pg.rows.values()][0].row.count).toBe(2);
    });

    it('backfill and verify do nothing in mongo mode', async () => {
      const pg = fakePg();
      await Gadget.create({ owner: 'o', title: 'a' });
      const s = store(pg);
      expect(await s.backfill()).toEqual({ scanned: 0, copied: 0, failed: 0 });
      expect(pg.calls).toEqual([]);
    });
  });
});
