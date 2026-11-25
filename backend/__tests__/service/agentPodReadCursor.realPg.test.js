/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentPodReadCursor on real PostgreSQL: migration 0016,
 * the repository's real pgTableAdapter SQL (version guard, keyset scan), and
 * the dual/pg parity with Mongo through the same calls the freshness gate makes.
 */
const fs = require('fs');
const path = require('path');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const mongoose = require('mongoose');
const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const Cursor = require('../../models/AgentPodReadCursor');
const {
  getReadWatermark, advanceReadWatermark, readCursorStore,
} = require('../../repositories/agentPodReadCursorRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(path.join(__dirname, '../../config/migrations/0016_agent_pod_read_cursors.sql'), 'utf8');
const ENV = 'STORE_MODE_AGENT_POD_READ_CURSOR';
const at = (seconds) => new Date(Date.UTC(2026, 10, 25, 0, 0, seconds));

real('AgentPodReadCursor on real PostgreSQL (ADR-034 step 2)', () => {
  let database;
  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await Cursor.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0016 is a no-op on a second run and creates exactly the planned columns', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(`SELECT column_name, data_type, is_nullable
      FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'agent_pod_read_cursors'
      ORDER BY ordinal_position`);
    expect(rows).toEqual([
      { column_name: 'id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'agent_user_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'pod_id', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'read_at', data_type: 'timestamp with time zone', is_nullable: 'NO' },
      { column_name: 'read_revision', data_type: 'bigint', is_nullable: 'YES' },
      { column_name: 'pg_version', data_type: 'integer', is_nullable: 'NO' },
    ]);
  });

  it('dual: every advance lands in both stores, and verify finds them equal', async () => {
    process.env[ENV] = 'dual';
    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    await advanceReadWatermark(agent, pod, { readAt: at(5), readRevision: 2 });
    await advanceReadWatermark(agent, pod, { readAt: at(3), readRevision: 7 });
    await advanceReadWatermark(agent, pod, { readAt: at(9) });
    const { rows } = await database.pool.query('SELECT * FROM agent_pod_read_cursors');
    expect(rows).toEqual([{
      id: `${agent}:${pod}`, agent_user_id: String(agent), pod_id: String(pod), read_at: at(9), read_revision: '7', pg_version: 3,
    }]);
    expect(await readCursorStore.verify()).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
  });

  it('a revision past 2^31 round-trips as a number in dual and pg, and verify finds no difference', async () => {
    const big = 2 ** 31 + 7;
    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    process.env[ENV] = 'dual';
    await advanceReadWatermark(agent, pod, { readAt: at(1), readRevision: big });
    // node-postgres returns BIGINT as a string; the adapter reads it back as a number.
    expect((await database.pool.query('SELECT read_revision FROM agent_pod_read_cursors')).rows)
      .toEqual([{ read_revision: String(big) }]);
    expect(await readCursorStore.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    const verified = await readCursorStore.verify();
    expect(verified.checksumPg).toBe(verified.checksumMongo);
    process.env[ENV] = 'pg';
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(1), readRevision: big });
    await advanceReadWatermark(agent, pod, { readAt: at(2), readRevision: big + 1 });
    expect(await getReadWatermark(agent, pod)).toEqual({ readAt: at(2), readRevision: big + 1 });
    expect(typeof (await readCursorStore.findById(`${agent}:${pod}`)).readRevision).toBe('number');
  });

  it('a revision past the safe integer range throws on read instead of rounding', async () => {
    await database.pool.query(`INSERT INTO agent_pod_read_cursors
      (id, agent_user_id, pod_id, read_at, read_revision, pg_version) VALUES ('a:b', 'a', 'b', now(), 9007199254740993, 1)`);
    process.env[ENV] = 'pg';
    await expect(readCursorStore.findById('a:b')).rejects.toThrow(/safe integer range/);
  });

  it('backfill copies history at its version, and a dual write after it wins', async () => {
    const agent = new mongoose.Types.ObjectId();
    const pods = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
    for (const pod of pods) await advanceReadWatermark(agent, pod, { readAt: at(1) });
    process.env[ENV] = 'dual';
    expect(await readCursorStore.backfill({ dryRun: false, batchSize: 2 })).toEqual({
      scanned: 5, inserted: 5, alreadyCurrent: 0, skippedPending: 0,
    });
    await advanceReadWatermark(agent, pods[0], { readAt: at(8) });
    expect(await readCursorStore.backfill({ dryRun: false })).toMatchObject({ inserted: 0, alreadyCurrent: 5 });
    const verified = await readCursorStore.verify({ batchSize: 2 });
    expect(verified).toMatchObject({
      mongo: 5, pg: 5, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });

  it('pg: the same watermarks as mongo, from Postgres alone', async () => {
    const steps = [
      { readAt: at(5) }, { readAt: at(3), readRevision: 2 }, { readAt: at(9) }, { readAt: at(1), readRevision: 0 },
      { readAt: at(4), readRevision: 6 },
    ];
    const agent = new mongoose.Types.ObjectId();
    const pod = new mongoose.Types.ObjectId();
    const trace = {};
    for (const mode of ['mongo', 'pg']) {
      await Cursor.deleteMany({});
      if (mode === 'pg') process.env[ENV] = 'pg';
      trace[mode] = [];
      for (const step of steps) {
        await advanceReadWatermark(agent, pod, step);
        trace[mode].push(await getReadWatermark(agent, pod));
      }
    }
    expect(trace.pg).toEqual(trace.mongo);
    expect(await Cursor.countDocuments({})).toBe(0);
  });
});
