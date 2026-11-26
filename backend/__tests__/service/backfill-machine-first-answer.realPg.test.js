/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * F639: the backfill's earliest-post query on real PostgreSQL (review
 * checklist rule 55). pg-mem runs it in backfill-machine-first-answer.db.test.js,
 * but pg-mem has passed SQL that broke on Postgres before, so the casts
 * (`ANY($1::text[])`), the kernel predicate and the agent-dm exclusion are read
 * here by the real planner, on the migrated schema. The agent-dm pod's type is
 * read from the Mongo Pod, so Mongo is real too.
 */
const mongoose = require('mongoose');
const { runPgMigrations } = require('../../config/run-pg-migrations');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');

// The script reads `pool` from config/db-pg only in main(); productionDeps
// takes it as an argument, so this holder only keeps module load off a
// real connection.
const mockDbPg = {};
jest.mock('../../config/db-pg', () => mockDbPg);

const Pod = require('../../models/Pod');
const { productionDeps } = require('../../scripts/backfill-machine-first-answer');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const OWNER = 'bbbbbbbbbbbbbbbbbbbbbb61';
const AGENT = 'cccccccccccccccccccccc61';
const PEER = 'dddddddddddddddddddddd61';
const REGISTERED = new Date('2026-11-01T00:00:00Z');
const at = (iso) => new Date(iso);

real('backfill-machine-first-answer earliestPost on real PostgreSQL (F639)', () => {
  let database;
  let pool;
  let room;
  let dm;
  const insert = (podId, userId, createdAt, { type = 'text', kind = null } = {}) => pool.query(
    `INSERT INTO messages (pod_id, user_id, content, message_type, author_kind, created_at)
     VALUES ($1, $2, 'a post', $3, $4, $5)`,
    [podId, userId, type, kind, createdAt],
  );
  const earliest = () => productionDeps(pool).earliestPost([AGENT], REGISTERED);

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    pool = database.pool;
    mockDbPg.pool = pool;
    await runPgMigrations(pool);
    await Pod.deleteMany({});
    room = await Pod.create({
      name: 'Team', type: 'chat', createdBy: new mongoose.Types.ObjectId(OWNER), members: [OWNER, AGENT],
    });
    dm = await Pod.create({
      name: 'Agent DM', type: 'agent-dm', createdBy: new mongoose.Types.ObjectId(AGENT), members: [AGENT, PEER],
    });
    await pool.query(
      "INSERT INTO users (_id, username, is_bot) VALUES ($1, 'owner', false), ($2, 'otto', true), ($3, 'peer', true)",
      [OWNER, AGENT, PEER],
    );
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1, 'Team', 'chat', $3), ($2, 'Agent DM', 'agent-dm', $4)",
      [String(room._id), String(dm._id), OWNER, AGENT],
    );
  });
  afterEach(async () => {
    if (database) await database.close();
  });

  it('returns the eligible chat message', async () => {
    await insert(String(room._id), AGENT, at('2026-11-02T10:00:00Z'));
    await expect(earliest()).resolves.toEqual(at('2026-11-02T10:00:00Z'));
  });

  it('skips a system line, a kernel notice, an agent-dm post and a post before registration', async () => {
    await insert(String(room._id), AGENT, at('2026-10-20T10:00:00Z'));
    await insert(String(room._id), AGENT, at('2026-11-01T01:00:00Z'), { type: 'system' });
    await insert(String(room._id), AGENT, at('2026-11-01T02:00:00Z'), { kind: 'kernel' });
    await insert(String(dm._id), AGENT, at('2026-11-01T03:00:00Z'));
    await expect(earliest()).resolves.toBeNull();

    await insert(String(room._id), AGENT, at('2026-11-03T10:00:00Z'));
    await insert(String(room._id), AGENT, at('2026-11-02T10:00:00Z'));
    await expect(earliest()).resolves.toEqual(at('2026-11-02T10:00:00Z'));
  });

  it('reads with no agent-dm pods to exclude (an empty array parameter)', async () => {
    await Pod.deleteMany({ type: 'agent-dm' });
    await insert(String(dm._id), AGENT, at('2026-11-01T03:00:00Z'));
    await expect(earliest()).resolves.toEqual(at('2026-11-01T03:00:00Z'));
  });
});
