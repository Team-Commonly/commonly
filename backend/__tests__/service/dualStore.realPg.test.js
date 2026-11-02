/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 D3: pgTableAdapter's SQL on real PostgreSQL. The version guard in
 * the ON CONFLICT clause is what keeps a late write from overwriting a newer
 * one, so it is proven against the engine that enforces it.
 */
const { createRealPgSchema } = require('../utils/realPgSchema');
const { pgTableAdapter } = require('../../repositories/dualStore');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const ID = '6a692a1be833c668acdb84cf';

real('pgTableAdapter on real PostgreSQL', () => {
  let database;
  let adapter;
  beforeEach(async () => {
    database = await createRealPgSchema();
    await database.pool.query(`CREATE TABLE widgets (
      id TEXT PRIMARY KEY, title TEXT, payload JSONB, pg_version INTEGER NOT NULL)`);
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
  });
});
