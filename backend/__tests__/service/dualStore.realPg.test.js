/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 D3: pgTableAdapter's SQL on real PostgreSQL. The version guard in
 * the ON CONFLICT clause is what keeps a late write from overwriting a newer
 * one, so it is proven against the engine that enforces it.
 */
const mongoose = require('mongoose');
const { createRealPgSchema } = require('../utils/realPgSchema');
const {
  pgTableAdapter, createDualStore, dualStorePlugin, dualStoreStats, resetDualStoreStats,
} = require('../../repositories/dualStore');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const ID = '6a692a1be833c668acdb84cf';

real('pgTableAdapter on real PostgreSQL', () => {
  let database;
  let adapter;
  beforeEach(async () => {
    database = await createRealPgSchema();
    // The id column sorts by ICU's root collation ('a' < 'B' < 'b'), not byte
    // order, so the scan's keyset paging holds only through its COLLATE "C".
    await database.pool.query(`CREATE TABLE widgets (
      id TEXT COLLATE "und-x-icu" PRIMARY KEY, title TEXT, payload JSONB, pg_version INTEGER NOT NULL)`);
    adapter = pgTableAdapter({
      pool: database.pool, table: 'widgets', idColumn: 'id', columns: ['title', 'payload'],
    });
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  it('upserts, reads back, and moves only to a higher version', async () => {
    expect(await adapter.get(ID)).toBeNull();
    expect(await adapter.upsert({ id: ID, title: 'v1', payload: { a: 1 } }, 1)).toBe(true);
    expect(await adapter.get(ID)).toEqual({ row: { id: ID, title: 'v1', payload: { a: 1 } }, version: 1 });
    expect(await adapter.upsert({ id: ID, title: 'v3', payload: null }, 3)).toBe(true);
    expect(await adapter.upsert({ id: ID, title: 'late v2', payload: { a: 2 } }, 2)).toBe(false);
    expect(await adapter.upsert({ id: ID, title: 'same v3', payload: null }, 3)).toBe(false);
    expect(await adapter.get(ID)).toEqual({ row: { id: ID, title: 'v3', payload: null }, version: 3 });
  });

  it('keeps a $-leading string as a value', async () => {
    await adapter.upsert({ id: ID, title: '$5 off', payload: null }, 1);
    expect((await adapter.get(ID)).row.title).toBe('$5 off');
  });

  it('removes only a row older than the remove', async () => {
    await adapter.upsert({ id: ID, title: 'v4', payload: null }, 4);
    await adapter.remove(ID, 4);
    expect((await adapter.get(ID)).version).toBe(4);
    await adapter.remove(ID, 5);
    expect(await adapter.get(ID)).toBeNull();
    await adapter.remove(ID, 6);
  });

  it('round-trips arrays in a declared JSON column, which node-postgres would bind as a Postgres array', async () => {
    const json = pgTableAdapter({
      pool: database.pool, table: 'widgets', idColumn: 'id', columns: ['title', 'payload'], jsonColumns: ['payload'],
    });
    expect(await json.upsert({ id: ID, title: 'list', payload: [1, 2] }, 1)).toBe(true);
    expect((await json.get(ID)).row.payload).toEqual([1, 2]);
    expect(await json.replace({ id: ID, title: 'empty', payload: [] }, 1)).toBe(true);
    expect((await json.get(ID)).row.payload).toEqual([]);
    expect(await json.replace({ id: ID, title: 'object', payload: { a: [1] } }, 2)).toBe(true);
    expect((await json.get(ID)).row.payload).toEqual({ a: [1] });
    expect(await json.replace({ id: ID, title: 'none', payload: null }, 3)).toBe(true);
    expect((await json.get(ID)).row.payload).toBeNull();
  });

  it('pg mode replaces and deletes only the version it read', async () => {
    await adapter.upsert({ id: ID, title: 'v1', payload: { a: 1 } }, 1);
    expect(await adapter.replace({ id: ID, title: 'stale', payload: null }, 0)).toBe(false);
    expect(await adapter.replace({ id: ID, title: 'v2', payload: { a: 2 } }, 1)).toBe(true);
    expect(await adapter.get(ID)).toEqual({ row: { id: ID, title: 'v2', payload: { a: 2 } }, version: 2 });
    expect(await adapter.removeAt(ID, 1)).toBe(false);
    expect((await adapter.get(ID)).version).toBe(2);
    expect(await adapter.removeAt(ID, 2)).toBe(true);
    expect(await adapter.get(ID)).toBeNull();
    // A replace never inserts: a row deleted under it stays deleted.
    expect(await adapter.replace({ id: ID, title: 'ghost', payload: null }, 2)).toBe(false);
    expect(await adapter.get(ID)).toBeNull();
  });

  it('scans in id byte order, a page at a time, whatever the collation', async () => {
    const ids = ['b', 'B', 'a:1', 'a', '6a692a1be833c668acdb84cf', 'Z'];
    for (const [i, id] of ids.entries()) await adapter.upsert({ id, title: `t${i}`, payload: null }, i);
    // The fixture must disagree with byte order, or this test proves nothing.
    const natural = (await database.pool.query('SELECT id FROM widgets ORDER BY id')).rows.map((r) => r.id);
    expect(natural).not.toEqual([...ids].sort());
    const seen = [];
    let after = null;
    for (;;) {
      const page = await adapter.scan(after, 2);
      if (!page.length) break;
      expect(page.length).toBeLessThanOrEqual(2);
      seen.push(...page.map((entry) => entry.id));
      after = page[page.length - 1].id;
    }
    expect(seen).toEqual([...ids].sort());
    expect((await adapter.scan(null, 1))[0]).toEqual({
      id: '6a692a1be833c668acdb84cf', row: { id: '6a692a1be833c668acdb84cf', title: 't4', payload: null }, version: 4,
    });
  });

  describe('$in and $exists in a filtered read', () => {
    let marks;
    const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute));
    beforeEach(async () => {
      await database.pool.query(`CREATE TABLE marks (
        id TEXT PRIMARY KEY, title TEXT, n INTEGER, seen_at TIMESTAMPTZ, pg_version INTEGER NOT NULL)`);
      marks = pgTableAdapter({
        pool: database.pool,
        table: 'marks',
        idColumn: 'id',
        columns: ['title', 'n', 'seen_at'],
        presenceColumns: ['seen_at'],
      });
      await marks.upsert({ id: 'a', title: 'one', n: 1, seen_at: null }, 1);
      await marks.upsert({ id: 'b', title: "it's", n: 2, seen_at: at(5) }, 1);
      await marks.upsert({ id: 'c', title: 'three', n: 3, seen_at: at(10) }, 1);
      await marks.upsert({ id: 'd', title: null, n: null, seen_at: null }, 1);
    });
    const ids = (rows) => rows.map(({ row }) => row.id);

    it('binds $in as one array parameter, typed by each column, and never matches NULL', async () => {
      expect(ids(await marks.findWhere({ title: { $in: ["it's", 'three', 'none'] } }))).toEqual(['b', 'c']);
      expect(ids(await marks.findWhere({ n: { $in: [1, 3] } }))).toEqual(['a', 'c']);
      expect(ids(await marks.findWhere({ seen_at: { $in: [at(10), at(99)] } }))).toEqual(['c']);
      expect(ids(await marks.findWhere({ id: { $in: ['d', 'a'] }, n: { $gte: 1 } }))).toEqual(['a']);
      // A string that looks like SQL is one value of the list.
      expect(ids(await marks.findWhere({ title: { $in: ["one') OR true --"] } }))).toEqual([]);
      expect(await marks.findWhere({ title: { $in: ['one', 'three'] } }, 1)).toEqual([
        { row: { id: 'a', title: 'one', n: 1, seen_at: null }, version: 1 },
      ]);
    });

    it('maps $exists to IS NULL and IS NOT NULL on a presence column', async () => {
      expect(ids(await marks.findWhere({ seen_at: { $exists: false } }))).toEqual(['a', 'd']);
      expect(ids(await marks.findWhere({ seen_at: { $exists: true } }))).toEqual(['b', 'c']);
      expect(ids(await marks.findWhere({ seen_at: { $exists: true }, n: { $in: [3] } }))).toEqual(['c']);
    });

    it('refuses an empty $in, a null element and $exists off a presence column, before any query', async () => {
      const query = jest.spyOn(database.pool, 'query');
      await expect(marks.findWhere({ title: { $in: [] } })).rejects.toThrow(/non-empty array/);
      await expect(marks.findWhere({ title: { $in: [null] } })).rejects.toThrow(/never null/);
      await expect(marks.findWhere({ title: { $exists: false } })).rejects.toThrow(/\$exists is not allowed/);
      expect(query).not.toHaveBeenCalled();
      query.mockRestore();
    });
  });

  it('rejects an identifier it would have to interpolate unsafely', () => {
    const { pool } = database;
    expect(() => pgTableAdapter({
      pool, table: 'widgets; DROP TABLE widgets', idColumn: 'id', columns: ['title'],
    })).toThrow(/identifier/);
    expect(() => pgTableAdapter({
      pool, table: 'widgets', idColumn: 'Id', columns: ['title'],
    })).toThrow(/identifier/);
    expect(() => pgTableAdapter({
      pool, table: 'widgets', idColumn: 'id', columns: ['title"'],
    })).toThrow(/identifier/);
    expect(() => pgTableAdapter({
      pool, table: 'widgets', idColumn: 'id', columns: ['pg_version'],
    })).toThrow();
    expect(() => pgTableAdapter({
      pool, table: 'widgets', idColumn: 'id', columns: ['title'], jsonColumns: ['payload'],
    })).toThrow(/jsonColumns must be listed in columns/);
  });
});

/**
 * findOneAndUpdateWhere end to end: decided on a real Mongo, copied to a real
 * Postgres table through pgTableAdapter, then checked by the helper's own
 * verify. The AgentProviderKey shapes: an $inc upsert and a generation lock.
 */
real('findOneAndUpdateWhere on real Mongo and real PostgreSQL', () => {
  const ENV = 'STORE_MODE_DUAL_STORE_REAL_PG_KEY';
  const keySchema = new mongoose.Schema({
    agent: { type: String, required: true, unique: true },
    owner: { type: String, required: true },
    generation: { type: Number, default: 0 },
    secretRef: { type: String, default: null },
  }, { timestamps: true });
  dualStorePlugin(keySchema);
  const Key = mongoose.models.DualStoreRealPgKey || mongoose.model('DualStoreRealPgKey', keySchema);
  const toRow = (doc) => ({
    id: String(doc._id),
    agent: doc.agent,
    owner: doc.owner,
    generation: doc.generation ?? null,
    secret_ref: doc.secretRef ?? null,
    created_at: doc.createdAt ?? null,
    updated_at: doc.updatedAt ?? null,
  });
  const filter = { agent: 'a1', owner: 'o1' };
  let database;
  let pg;
  let store;

  beforeAll(async () => {
    await setupMongoDb();
    await Key.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    process.env[ENV] = 'dual';
    await Key.deleteMany({});
    database = await createRealPgSchema();
    await database.pool.query(`CREATE TABLE provider_keys (
      id TEXT PRIMARY KEY, agent TEXT, owner TEXT, generation DOUBLE PRECISION, secret_ref TEXT,
      created_at TIMESTAMPTZ, updated_at TIMESTAMPTZ, pg_version INTEGER NOT NULL)`);
    pg = pgTableAdapter({
      pool: database.pool,
      table: 'provider_keys',
      idColumn: 'id',
      columns: ['agent', 'owner', 'generation', 'secret_ref', 'created_at', 'updated_at'],
    });
    store = createDualStore({
      name: 'DualStoreRealPgKey', model: Key, pg, toRow, fromRow: (row) => row,
    });
  });
  afterEach(async () => {
    delete process.env[ENV];
    if (database) await database.close();
  });

  const expectClean = async () => {
    const counts = await store.verify();
    expect(counts).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    expect(counts.checksumPg).toBe(counts.checksumMongo);
    return counts;
  };

  it('racing $inc upserts make one document, and Postgres holds the same number at the same version', async () => {
    const steps = [1, 1, 1, 1, 0.5, -0.25, 1, 1];
    const results = await Promise.all(steps.map((by) => store.findOneAndUpdateWhere(
      filter, { $inc: { generation: by } }, { returnDocument: 'after', upsert: true },
    )));
    expect(results.every(Boolean)).toBe(true);
    const raw = await Key.findOne(filter).lean();
    expect(raw).toMatchObject({ generation: 6.25, pgVersion: 8 });
    expect(raw.pgPending).toBeUndefined();
    const got = await pg.get(String(raw._id));
    expect(got.version).toBe(8);
    expect(got.row.generation).toBe(6.25);
    expect(await expectClean()).toMatchObject({ mongo: 1, pg: 1 });
  });

  it('racing generation locks have one winner; the pre-image is the old row and Postgres the new one', async () => {
    await store.findOneAndUpdateWhere(filter, { $inc: { generation: 1 } }, { returnDocument: 'after', upsert: true });
    const outcomes = await Promise.all(Array.from({ length: 6 }, (_, i) => store.findOneAndUpdateWhere(
      { ...filter, generation: 1 }, { $set: { secretRef: `r${i}` }, $inc: { generation: 1 } },
      { returnDocument: 'before' },
    )));
    const winners = outcomes.filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(winners[0]).toMatchObject({ generation: 1, secretRef: null });
    const raw = await Key.findOne(filter).lean();
    expect(raw).toMatchObject({ generation: 2, pgVersion: 2 });
    expect((await pg.get(String(raw._id))).row.secret_ref).toBe(raw.secretRef);
    await expectClean();
  });

  it('refuses pg mode before touching either store', async () => {
    process.env[ENV] = 'pg';
    const query = jest.spyOn(database.pool, 'query');
    await expect(store.findOneAndUpdateWhere(filter, { $inc: { generation: 1 } }, {
      returnDocument: 'after', upsert: true,
    })).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(query).not.toHaveBeenCalled();
    expect(await Key.countDocuments({})).toBe(0);
    query.mockRestore();
  });
});

/**
 * Tombstone deletes on real PostgreSQL: the tombstone SQL against a table with
 * a UNIQUE column, the row lock that makes a late lower-version copy a no-op,
 * and a re-insert under the same unique key right after a delete (I6).
 */
real('tombstone deletes on real PostgreSQL', () => {
  const ROW = (id, deliveryId, label = 'payload') => ({ id, delivery_id: deliveryId, label });
  let database;
  let adapter;
  beforeEach(async () => {
    database = await createRealPgSchema();
    // The per-model migration shape: a plain UNIQUE, nullable payload columns
    // (one with a DEFAULT a tombstone must not take), and the partial index.
    await database.pool.query(`CREATE TABLE deliveries (
      id TEXT PRIMARY KEY, delivery_id TEXT UNIQUE, label TEXT DEFAULT 'filled-by-default',
      pg_version INTEGER NOT NULL, pg_deleted BOOLEAN NOT NULL DEFAULT false, deleted_at TIMESTAMPTZ)`);
    await database.pool.query('CREATE INDEX deliveries_deleted ON deliveries (deleted_at) WHERE pg_deleted');
    adapter = pgTableAdapter({
      pool: database.pool, table: 'deliveries', idColumn: 'id', columns: ['delivery_id', 'label'], tombstones: true,
    });
  });
  afterEach(async () => {
    if (database) await database.close();
  });
  const raw = async (id) => (await database.pool.query('SELECT * FROM deliveries WHERE id = $1', [id])).rows[0];

  it('keeps the version, NULLs every payload column (defaults included), frees the unique key, and hides the row', async () => {
    expect(await adapter.upsert(ROW('a', 'd-1'), 1)).toBe(true);
    await adapter.remove('a', 1);
    expect(await adapter.get('a')).toMatchObject({ version: 1, row: { delivery_id: 'd-1' } });
    await adapter.remove('a', 2);
    expect(await adapter.get('a')).toBeNull();
    expect(await adapter.getAny('a')).toEqual({ deleted: true, version: 2 });
    const dead = await raw('a');
    expect(dead).toMatchObject({
      delivery_id: null, label: null, pg_version: 2, pg_deleted: true,
    });
    expect(dead.deleted_at).toBeInstanceOf(Date);
    // A late copy at or below the tombstone's version is refused by the guard.
    expect(await adapter.upsert(ROW('a', 'd-1'), 1)).toBe(false);
    expect(await adapter.upsert(ROW('a', 'd-1'), 2)).toBe(false);
    expect(await adapter.get('a')).toBeNull();
    // The dead row holds no key: a new id takes the same delivery_id.
    expect(await adapter.upsert(ROW('b', 'd-1'), 1)).toBe(true);
    // A delete of a row never written inserts a tombstone, NULLs and all.
    await adapter.remove('never', 4);
    expect(await raw('never')).toMatchObject({ label: null, pg_version: 4, pg_deleted: true });
    expect(await adapter.upsert(ROW('never', 'd-9'), 0)).toBe(false);
    // Reads leave tombstones out; a scan that asks for them flags them.
    expect((await adapter.findWhere({ delivery_id: null })).map(({ row }) => row.id)).toEqual([]);
    expect((await adapter.scan(null, 10)).map(({ id }) => id)).toEqual(['b']);
    expect((await adapter.scan(null, 10, { includeDeleted: true })).map(({ id, deleted }) => [id, deleted]))
      .toEqual([['a', true], ['b', false], ['never', true]]);
    // A copy above the tombstone's version revives the row.
    expect(await adapter.upsert(ROW('never', 'd-9'), 5)).toBe(true);
    expect(await raw('never')).toMatchObject({ pg_deleted: false, deleted_at: null, label: 'payload' });
  });

  it('pg mode: removeAt is a compare-and-set to a tombstone at the next version; replace never touches one', async () => {
    await adapter.upsert(ROW('a', 'd-1'), 1);
    expect(await adapter.removeAt('a', 0)).toBe(false);
    expect(await adapter.removeAt('a', 1)).toBe(true);
    expect(await adapter.getAny('a')).toEqual({ deleted: true, version: 2 });
    expect(await adapter.removeAt('a', 2)).toBe(false);
    expect(await adapter.replace(ROW('a', 'd-1', 'ghost'), 2)).toBe(false);
    expect(await raw('a')).toMatchObject({ label: null, pg_deleted: true, pg_version: 2 });
  });

  it('refuses pg_deleted or deleted_at as payload columns', () => {
    expect(() => pgTableAdapter({
      pool: database.pool, table: 'deliveries', idColumn: 'id', columns: ['label', 'pg_deleted'], tombstones: true,
    })).toThrow(/pg_deleted or deleted_at/);
  });

  describe('a tombstone and a lower-version copy from two pool clients', () => {
    let clients;
    let first;
    let second;
    beforeEach(async () => {
      clients = [await database.pool.connect(), await database.pool.connect()];
      [first, second] = clients.map((client) => pgTableAdapter({
        pool: client, table: 'deliveries', idColumn: 'id', columns: ['delivery_id', 'label'], tombstones: true,
      }));
    });
    afterEach(() => clients.forEach((client) => client.release()));
    const blocked = async (promise) => {
      const state = await Promise.race([promise.then(() => 'done'), new Promise((resolve) => {
        setTimeout(() => resolve('waiting'), 150);
      })]);
      expect(state).toBe('waiting');
    };

    it.each([
      ['an existing row', true],
      ['a row never written (a backfill copy at version 0)', false],
    ])('the copy waits on the uncommitted tombstone, then is a no-op: %s', async (_label, existing) => {
      if (existing) await adapter.upsert(ROW('a', 'd-1'), 1);
      await clients[0].query('BEGIN');
      await first.remove('a', 3);
      const copying = second.upsert(ROW('a', 'd-1', 'late'), existing ? 2 : 0);
      await blocked(copying);
      await clients[0].query('COMMIT');
      expect(await copying).toBe(false);
      expect(await adapter.get('a')).toBeNull();
      expect(await adapter.getAny('a')).toEqual({ deleted: true, version: 3 });
    });

    it('the tombstone waits on an uncommitted lower-version copy, then wins', async () => {
      await clients[0].query('BEGIN');
      await first.upsert(ROW('a', 'd-1', 'late'), 2);
      const deleting = second.remove('a', 3);
      await blocked(deleting);
      await clients[0].query('COMMIT');
      await deleting;
      expect(await adapter.get('a')).toBeNull();
      expect(await raw('a')).toMatchObject({ label: null, pg_version: 3, pg_deleted: true });
    });

    it('raced 100 times in either start order, never leaves a live row', async () => {
      for (let i = 0; i < 100; i += 1) {
        const id = `race-${i}`;
        // eslint-disable-next-line no-await-in-loop
        if (i % 3) await adapter.upsert(ROW(id, `d-${i}`), 1);
        const tombstone = () => first.remove(id, 3);
        const copy = () => second.upsert(ROW(id, `d-${i}`, 'late'), 2);
        // eslint-disable-next-line no-await-in-loop
        await Promise.all(i % 2 ? [tombstone(), copy()] : [copy(), tombstone()]);
        // eslint-disable-next-line no-await-in-loop
        expect(await adapter.get(id)).toBeNull();
        // eslint-disable-next-line no-await-in-loop
        expect(await adapter.getAny(id)).toEqual({ deleted: true, version: 3 });
      }
      const { rows } = await database.pool.query(
        'SELECT count(*)::int AS live FROM deliveries WHERE NOT pg_deleted OR delivery_id IS NOT NULL',
      );
      expect(rows[0].live).toBe(0);
    });
  });

  describe('I6: a re-insert under the same unique key, on real Mongo and real PostgreSQL', () => {
    const ENV = 'STORE_MODE_DUAL_STORE_REAL_PG_DELIVERY';
    const deliverySchema = new mongoose.Schema({
      deliveryId: { type: String, required: true, unique: true },
      label: String,
    });
    dualStorePlugin(deliverySchema);
    const Delivery = mongoose.models.DualStoreRealPgDelivery
      || mongoose.model('DualStoreRealPgDelivery', deliverySchema);
    const toRow = (doc) => ({ id: String(doc._id), delivery_id: doc.deliveryId ?? null, label: doc.label ?? null });
    let store;
    beforeAll(async () => {
      await setupMongoDb();
      await Delivery.init();
    });
    afterAll(closeMongoDb);
    beforeEach(async () => {
      process.env[ENV] = 'dual';
      await Delivery.deleteMany({});
      store = createDualStore({
        name: 'DualStoreRealPgDelivery',
        model: Delivery,
        pg: adapter,
        toRow,
        fromRow: (row) => row,
        deletes: 'tombstone',
        releaseKeys: { deliveryId: 'sentinel' },
      });
    });
    afterEach(() => { delete process.env[ENV]; });

    const expectClean = async (tombstones) => {
      const counts = await store.verify();
      expect(counts).toMatchObject({
        mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0, tombstones,
      });
      expect(counts.checksumPg).toBe(counts.checksumMongo);
      expect(await Delivery.countDocuments({ pgPending: { $exists: true } })).toBe(0);
    };

    it('right after a delete: the new row copies, and the tombstone holds no key', async () => {
      const old = await store.create({ deliveryId: 'redelivered', label: 'old' });
      expect(await store.remove(old._id)).toBe(true);
      const fresh = await store.create({ deliveryId: 'redelivered', label: 'new' });
      expect((await adapter.get(String(fresh._id))).row).toMatchObject({ delivery_id: 'redelivered', label: 'new' });
      expect(await raw(String(old._id))).toMatchObject({ delivery_id: null, pg_deleted: true });
      await expectClean(1);
    });

    // The stores are asymmetric (a real delete in Mongo, a kept row in
    // Postgres), so every Postgres read must leave a tombstone out. This pins
    // the `NOT pg_deleted` clause itself: the second half re-marks a live row
    // with its payload intact, so a read that skipped the clause would match
    // on the unique key even though tombstones are normally NULLed.
    it('every pg-read path skips a tombstone, the unique deliveryId lookup included', async () => {
      const reader = createDualStore({
        name: 'DualStoreRealPgDelivery',
        model: Delivery,
        pg: adapter,
        toRow,
        fromRow: (row) => ({ _id: row.id, deliveryId: row.delivery_id, label: row.label }),
        deletes: 'tombstone',
        releaseKeys: { deliveryId: 'sentinel' },
        filterColumns: { _id: 'id', deliveryId: 'delivery_id', label: 'label' },
      });
      const gone = await reader.create({ deliveryId: 'd-gone', label: 'gone' });
      const kept = await reader.create({ deliveryId: 'd-kept', label: 'kept' });
      expect(await reader.remove(gone._id)).toBe(true);
      process.env[ENV] = 'pg-read';
      const query = jest.spyOn(database.pool, 'query');
      const reads = async (id, deliveryId) => ({
        byId: await reader.findById(id),
        byKey: await reader.findOneWhere({ deliveryId }),
        byKeyMany: await reader.findWhere({ deliveryId }),
        byIdFilter: await reader.findWhere({ _id: id }),
        all: (await reader.findWhere({})).map((doc) => String(doc._id)),
        scan: (await adapter.scan(null, 10)).map(({ id: rowId }) => rowId),
      });

      const afterDelete = await reads(gone._id, 'd-gone');
      expect(afterDelete).toEqual({
        byId: null, byKey: null, byKeyMany: [], byIdFilter: [], all: [String(kept._id)], scan: [String(kept._id)],
      });
      // These reads were served by Postgres, not the Mongo fallback.
      expect(query.mock.calls.some(([sql]) => /NOT pg_deleted/.test(sql))).toBe(true);
      expect((await reader.findOneWhere({ deliveryId: 'd-kept' }))).toMatchObject({ label: 'kept' });

      await database.pool.query('UPDATE deliveries SET pg_deleted = true, deleted_at = now() WHERE id = $1', [String(kept._id)]);
      expect(await raw(String(kept._id))).toMatchObject({ delivery_id: 'd-kept', pg_deleted: true });
      expect(await reads(kept._id, 'd-kept')).toEqual({
        byId: null, byKey: null, byKeyMany: [], byIdFilter: [], all: [], scan: [],
      });
      query.mockRestore();
    });

    it('while the Postgres remove fails: Mongo takes the re-insert, and repair converges both stores', async () => {
      const old = await store.create({ deliveryId: 'redelivered', label: 'old' });
      const remove = jest.spyOn(adapter, 'remove').mockRejectedValueOnce(new Error('pg down'));
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      expect(await store.remove(old._id)).toBe(true);
      remove.mockRestore();
      // releaseKeys freed the key in Mongo, so the re-insert gets no 11000;
      // its copy fails on the old row's key (23505) and stays flagged.
      const fresh = await store.create({ deliveryId: 'redelivered', label: 'new' });
      expect((await Delivery.findById(fresh._id).lean()).pgPending).toBe(1);
      expect(await adapter.get(String(fresh._id))).toBeNull();
      let passes = 0;
      // eslint-disable-next-line no-await-in-loop
      while (await Delivery.exists({ pgPending: { $exists: true } }) && passes < 3) {
        passes += 1;
        await store.repair({ limit: 10 }); // eslint-disable-line no-await-in-loop
      }
      warn.mockRestore();
      expect(passes).toBeGreaterThanOrEqual(1);
      expect(passes).toBeLessThanOrEqual(2);
      expect(await Delivery.findById(old._id).lean()).toBeNull();
      expect((await adapter.get(String(fresh._id))).row).toMatchObject({ delivery_id: 'redelivered', label: 'new' });
      await expectClean(1);
    });

    it('a reused id is a tombstoned mismatch: the flag stays, and verify names the tombstone', async () => {
      resetDualStoreStats();
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
      const old = await store.create({ deliveryId: 'first', label: 'old' });
      await store.remove(old._id);
      // Reused behind the helper's back, as a mongo-mode period after a rollback could.
      await Delivery.collection.insertOne({ _id: old._id, deliveryId: 'second' });
      expect(await store.update(old._id, { label: 'written' })).toMatchObject({ label: 'written' });
      expect(dualStoreStats('DualStoreRealPgDelivery').tombstoned).toBe(1);
      expect((await Delivery.findById(old._id).lean()).pgPending).toBe(1);
      expect(await adapter.get(String(old._id))).toBeNull();
      expect(await store.repair({ limit: 10 })).toMatchObject({ scanned: 1, failed: 1 });
      expect(await store.verify()).toMatchObject({
        mongo: 1, pg: 0, differs: 1, missing: 0, tombstones: 1,
      });
      expect(warn.mock.calls.map((args) => args.join(' ')).join('\n')).toMatch(/kind=differs fields=pg_deleted/);
      warn.mockRestore();
    });
  });
});
