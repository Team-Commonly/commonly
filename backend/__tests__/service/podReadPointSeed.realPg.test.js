/* eslint-disable import/no-unresolved, import/extensions, global-require -- CJS TS models, loaded per test. */
/**
 * The first pod read point seed on real PostgreSQL, against the shipped
 * messages, thread_user_state and pod_read_points tables. pg-mem has its own
 * parser (review-checklist rule 55); the seed reads MAX over timestamptz and
 * writes with ON CONFLICT DO NOTHING.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa02';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb02';

real('the first pod read point seed on real PostgreSQL', () => {
  let database;
  let pool;
  let seed;
  let PodReadPoint;

  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    await pool.query("INSERT INTO users (_id, username) VALUES ($1, 'reader')", [USER]);
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'One', 'chat', $2)", [POD, USER]);
    jest.isolateModules(() => {
      PodReadPoint = require('../../models/pg/PodReadPoint');
      seed = require('../../services/podReadPointSeed');
    });
  });
  afterEach(async () => {
    mockDbPg.pool = undefined;
    if (database) await database.close();
  });

  it('seeds from the later of the thread read point and the last message, then leaves the row alone', async () => {
    const { rows } = await pool.query(
      "INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, 'hi', '2026-11-10T09:00:00Z') RETURNING id",
      [POD, USER],
    );
    await pool.query(
      `INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, last_read_at)
       VALUES ($1, $2, $3, '2026-11-11T09:00:00Z')`,
      [rows[0].id, USER, POD],
    );

    expect(await seed.seedPodReadPoint({ podId: POD, userId: USER })).toBe('2026-11-11T09:00:00.000Z');
    // A later signal or a second run never moves it.
    await pool.query(
      "INSERT INTO messages (pod_id, user_id, content, created_at) VALUES ($1, $2, 'again', '2026-11-12T09:00:00Z')",
      [POD, USER],
    );
    expect(await seed.seedPodReadPoint({ podId: POD, userId: USER })).toBe('2026-11-11T09:00:00.000Z');
    expect(await PodReadPoint.seedIfAbsent(POD, USER, new Date('2026-11-01T00:00:00Z'))).toBe('2026-11-11T09:00:00.000Z');
  });

  it('writes nothing for a member with no signal', async () => {
    expect(await seed.seedPodReadPoint({ podId: POD, userId: USER })).toBeNull();
    const { rows } = await pool.query('SELECT 1 FROM pod_read_points WHERE pod_id = $1', [POD]);
    expect(rows).toHaveLength(0);
  });
});
