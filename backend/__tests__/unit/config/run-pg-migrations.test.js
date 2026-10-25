/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { newDb, DataType } = require('pg-mem');
const { runPgMigrations } = require('../../../config/run-pg-migrations');

// pg-mem executes the DDL/ledger contract. It cannot prove locks or rollback;
// those assertions live in service/pgMigrations.test.js against real Postgres.
describe('Postgres migrations (pg-mem)', () => {
  let pool;
  let directory;
  const write = (name, sql) => fs.writeFileSync(path.join(directory, name), sql);
  beforeEach(() => {
    // pg-mem misreports coverage on repeated CREATE TABLE IF NOT EXISTS.
    const db = newDb({ noAstCoverageCheck: true });
    ['pg_advisory_lock', 'pg_advisory_unlock'].forEach((name) => db.public.registerFunction({
      name,
      args: [DataType.integer, DataType.integer],
      returns: DataType.integer,
      implementation: () => 1,
    }));
    pool = new (db.adapters.createPg().Pool)();
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-migration-unit-'));
    write('0001_initial.sql', 'CREATE TABLE example (id INTEGER PRIMARY KEY);');
  });
  afterEach(async () => {
    await pool.end();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it('orders files, upgrades an existing table, preserves data and skips completed work', async () => {
    expect(await runPgMigrations(pool, directory)).toEqual(['0001_initial.sql']);
    await pool.query('INSERT INTO example (id) VALUES (7)');
    write('0003_third.sql', "UPDATE example SET label = 'kept' WHERE id = 7;");
    write('0002_second.sql', 'ALTER TABLE example ADD COLUMN label TEXT;');
    expect(await runPgMigrations(pool, directory)).toEqual(['0002_second.sql', '0003_third.sql']);
    expect((await pool.query('SELECT * FROM example')).rows).toEqual([{ id: 7, label: 'kept' }]);
    const history = (await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    expect(history).toHaveLength(3);
    expect(history[0]).toMatchObject({ checksum: expect.stringMatching(/^[a-f0-9]{64}$/), applied_at: expect.any(Date) });
    expect(await runPgMigrations(pool, directory)).toEqual([]);
    expect((await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(history);
  });

  it('refuses changed applied SQL before executing a later migration', async () => {
    await runPgMigrations(pool, directory);
    write('0001_initial.sql', 'DROP TABLE example;');
    write('0002_later.sql', 'CREATE TABLE should_not_exist (id INTEGER);');
    await expect(runPgMigrations(pool, directory)).rejects.toThrow('history mismatch');
    expect((await pool.query('SELECT * FROM example')).rows).toEqual([]);
    expect((await pool.query("SELECT table_name FROM information_schema.tables WHERE table_name = 'should_not_exist'")).rows).toEqual([]);
  });

  it('refuses missing files and migrations inserted before already-applied history', async () => {
    await runPgMigrations(pool, directory);
    write('0000_earlier.sql', 'DROP TABLE example;');
    await expect(runPgMigrations(pool, directory)).rejects.toThrow('history mismatch');
    fs.rmSync(path.join(directory, '0000_earlier.sql'));
    fs.rmSync(path.join(directory, '0001_initial.sql'));
    await expect(runPgMigrations(pool, directory)).rejects.toThrow('missing');
  });

  it.each([
    ['0001_duplicate.sql', 'SELECT 1;', 'duplicate'],
    ['oops.sql', 'SELECT 1;', 'Invalid'],
    ['0002_empty.sql', '', 'Empty'],
  ])('refuses invalid migration %s before connecting', async (name, sql, error) => {
    write(name, sql);
    const connect = jest.spyOn(pool, 'connect');
    await expect(runPgMigrations(pool, directory)).rejects.toThrow(error);
    expect(connect).not.toHaveBeenCalled();
  });

  it('releases its client when the advisory lock query fails', async () => {
    const client = { query: jest.fn().mockRejectedValue(new Error('offline')), release: jest.fn() };
    await expect(runPgMigrations({ connect: async () => client }, directory)).rejects.toThrow('offline');
    expect(client.release).toHaveBeenCalledWith(false);
  });

  it('destroys a client whose unlock fails instead of pooling a held lock', async () => {
    const query = jest.fn(async (sql) => {
      if (sql.includes('pg_advisory_unlock')) throw new Error('offline');
      return { rows: [] };
    });
    const client = { query, release: jest.fn() };
    await expect(runPgMigrations({ connect: async () => client }, directory)).rejects.toThrow('release');
    expect(client.release).toHaveBeenCalledWith(true);
  });
});
