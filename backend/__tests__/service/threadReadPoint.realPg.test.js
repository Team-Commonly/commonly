/* eslint-disable import/no-unresolved, import/extensions, global-require -- CJS TS models, loaded per test. */
/**
 * The thread read point's forward-only upsert on real PostgreSQL. pg-mem has
 * its own parser (review-checklist rule 55), and the guard is a WHERE on an
 * ON CONFLICT DO UPDATE comparing timestamptz values.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa01';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb01';

real('the thread read point on real PostgreSQL', () => {
  let database;
  let pool;
  let rootId;
  let ThreadUserState;

  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    await pool.query("INSERT INTO users (_id, username) VALUES ($1, 'reader')", [USER]);
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'One', 'chat', $2)", [POD, USER]);
    const { rows } = await pool.query(
      "INSERT INTO messages (pod_id, user_id, content) VALUES ($1, $2, 'a question') RETURNING id",
      [POD, USER],
    );
    rootId = rows[0].id;
    // The model binds the pool when it loads, and each test has a new one.
    jest.isolateModules(() => { ThreadUserState = require('../../models/pg/ThreadUserState'); });
  });
  afterEach(async () => {
    mockDbPg.pool = undefined;
    if (database) await database.close();
  });

  const rowOf = async () => {
    const { rows } = await pool.query(
      'SELECT following, collapsed, last_read_at FROM thread_user_state WHERE thread_root_id = $1 AND user_id = $2',
      [rootId, USER],
    );
    return rows[0];
  };

  it('keeps the newer point when an older write arrives, and leaves follow and collapse alone', async () => {
    await ThreadUserState.follow(rootId, USER, POD);
    await ThreadUserState.setCollapsed(rootId, USER, POD, false);
    const newer = '2026-11-01T10:05:00.000Z';
    const older = '2026-11-01T10:00:00.000Z';

    expect(await ThreadUserState.markRead(rootId, USER, POD, new Date(newer))).toBe(newer);
    expect(await ThreadUserState.markRead(rootId, USER, POD, new Date(older))).toBe(newer);

    const row = await rowOf();
    expect(row.last_read_at.toISOString()).toBe(newer);
    expect(row.following).toBe(true);
    expect(row.collapsed).toBe(false);
  });

  it('creates a row with the schema defaults when the first touch is a read', async () => {
    const at = '2026-11-01T10:00:00.000Z';
    expect(await ThreadUserState.markRead(rootId, USER, POD, new Date(at))).toBe(at);
    const row = await rowOf();
    expect(row.following).toBeNull();
    expect(row.collapsed).toBe(true);
  });

  it('clamps a point in the future to now', async () => {
    const before = Date.now();
    const stored = await ThreadUserState.markRead(rootId, USER, POD, new Date(Date.now() + 86400000));
    expect(Date.parse(stored)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(stored)).toBeLessThanOrEqual(Date.now());
  });
});
