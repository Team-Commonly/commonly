/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
jest.mock('../../../config/db-pg', () => ({ pool: { connect: jest.fn() } }));
jest.mock('../../../config/run-pg-migrations', () => ({ runPgMigrations: jest.fn() }));
const { pool } = require('../../../config/db-pg');
const { runPgMigrations } = require('../../../config/run-pg-migrations');
const initialize = require('../../../config/init-pg-db');

it('reports ready only after all pending migrations complete', async () => {
  runPgMigrations.mockResolvedValue(['0001_legacy_schema.sql']);
  expect(await initialize()).toBe(true);
  expect(runPgMigrations).toHaveBeenCalledWith(pool);
});

it('keeps boot unready on migration failure and can retry', async () => {
  runPgMigrations.mockRejectedValueOnce(new Error('bad migration')).mockResolvedValueOnce([]);
  expect(await initialize()).toBe(false);
  expect(await initialize()).toBe(true);
});
