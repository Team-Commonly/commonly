/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F503: the digest's teammate read on real PostgreSQL, on the migrated
 * schema. pg-mem has passed SQL that broke on Postgres before, and this read
 * groups and uses DISTINCT ON, so the real planner checks the grouping, the
 * count and the latest words per pod and author.
 */
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');

const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const POD = 'aaaaaaaaaaaaaaaaaaaaaa51';
const OTHER_POD = 'aaaaaaaaaaaaaaaaaaaaaa52';
const ME = 'bbbbbbbbbbbbbbbbbbbbbb51';
const MATE = 'bbbbbbbbbbbbbbbbbbbbbb52';
const AGENT = 'cccccccccccccccccccccc51';

real('PGMessage.findByOthersSince on real PostgreSQL (F503)', () => {
  let database;
  let pool;
  let PGMessage;
  const insert = (podId, userId, content, { type = 'text', hoursAgo }) => pool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type, created_at)
     VALUES ($1, $2, $3, $4, now() - make_interval(hours => $5))`,
    [podId, userId, content, type, hoursAgo],
  );

  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    await pool.query("INSERT INTO users (_id, username, is_bot) VALUES ($1, 'me', false), ($2, 'mk', false), ($3, 'codex', true)", [ME, MATE, AGENT]);
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'Launch', 'team', $3), ($2, 'Elsewhere', 'team', $3)",
      [POD, OTHER_POD, ME],
    );
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require -- loaded after the pool holder is filled
      PGMessage = require('../../models/pg/Message');
    });
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  it('gives one row per pod and author, with its true count and latest words', async () => {
    await insert(POD, MATE, 'first', { hoursAgo: 5 });
    await insert(POD, MATE, 'latest', { hoursAgo: 1 });
    for (let i = 0; i < 250; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await insert(POD, AGENT, `tick ${i}`, { hoursAgo: 0.5 });
    }
    await insert(POD, ME, 'my own words', { hoursAgo: 1 });
    await insert(POD, AGENT, 'is not connected yet', { type: 'system', hoursAgo: 1 });
    await insert(POD, MATE, '', { hoursAgo: 1 });
    await insert(POD, MATE, 'before the window', { hoursAgo: 30 });
    await insert(OTHER_POD, MATE, 'another pod', { hoursAgo: 1 });

    const rows = await PGMessage.findByOthersSince([POD], ME, new Date(Date.now() - 24 * 3600000));
    const byAuthor = Object.fromEntries(rows.map((r) => [r.userId, r]));
    expect(rows).toHaveLength(2);
    expect(byAuthor[MATE]).toMatchObject({ podId: POD, content: 'latest', count: 2 });
    expect(byAuthor[AGENT]).toMatchObject({ podId: POD, count: 250 });
  });
});
