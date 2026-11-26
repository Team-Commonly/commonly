/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentTaskRowWakeState on real PostgreSQL: migration 0025
 * run twice, then every caller shape in dual and pg-read through the real
 * pgTableAdapter SQL ($in as = ANY included), a record that fails part-way and
 * its compensation, and a pg-read of the rows with their ObjectIds, ending
 * with verify finding both stores equal.
 */
const fs = require('fs');
const path = require('path');
const { Types } = require('mongoose');

const mockDb = { pool: null };
jest.mock('../../config/db-pg', () => ({
  pool: { query: (...args) => mockDb.pool.query(...args) },
}));

const { createRealPgSchema } = require('../utils/realPgSchema');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const AgentTaskRowWakeState = require('../../models/AgentTaskRowWakeState');
const {
  rowWakeStateStore, findRowWakeStates, countRowOutcome, stopRowWake, unstopRowWake, resetRowWake,
  recordRowWakes, clearRowWakeStamps,
} = require('../../repositories/agentTaskRowWakeStateRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0025_agent_task_row_wake_states.sql'), 'utf8',
);
const ENV = 'STORE_MODE_AGENT_TASK_ROW_WAKE_STATE';
const at = (minute) => new Date(Date.UTC(2026, 0, 1, 0, minute));
const SEAT = JSON.stringify(['codex', 'forge']);
const key = (n) => `${SEAT}|row${n}`;
const MARKERS = ['__v', 'pgVersion', 'pgPending', 'pgDeleted'];
const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !MARKERS.includes(k)));

real('AgentTaskRowWakeState on real PostgreSQL (ADR-034 step 2)', () => {
  let database;

  beforeAll(async () => {
    await setupMongoDb();
    await AgentTaskRowWakeState.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await AgentTaskRowWakeState.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  const row = async (k) => (await database.pool.query(
    'SELECT * FROM agent_task_row_wake_states WHERE id = $1', [k],
  )).rows[0];

  it('0025 is a no-op on a second run', async () => {
    await database.pool.query(MIGRATION);
    const { rows } = await database.pool.query(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'agent_task_row_wake_states' ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['counted_event_id', 'created_at', 'failures', 'id',
      'last_verdict', 'last_wake_at', 'last_wake_event_id', 'pg_version', 'stopped_at', 'updated_at']);
    expect(rows.filter((r) => r.is_nullable === 'NO').map((r) => r.column_name)).toEqual(['id', 'pg_version']);
  });

  it.each(['dual', 'pg-read'])('%s: every caller shape lands in both stores, and verify agrees', async (mode) => {
    process.env[ENV] = mode;
    const store = rowWakeStateStore();
    const first = new Types.ObjectId();
    const second = new Types.ObjectId();

    await recordRowWakes([key(1), key(2)], { lastWakeAt: at(0), lastWakeEventId: null });
    await recordRowWakes([key(1), key(2)], { lastWakeEventId: first });
    expect(await countRowOutcome(key(1), undefined, { countedEventId: first, failures: 1, lastVerdict: 'failed' }))
      .toBe(true);
    expect(await countRowOutcome(key(1), null, { countedEventId: first, failures: 2, lastVerdict: 'failed' }))
      .toBe(false);
    expect(await stopRowWake(key(1), at(1))).toBe(true);
    expect(await stopRowWake(key(1), at(2))).toBe(false);
    expect(await unstopRowWake(key(1), at(1))).toBe(true);
    expect(await resetRowWake(key(1))).toBe(true);
    expect(await resetRowWake(key(9))).toBe(false);

    expect(await row(key(1))).toMatchObject({
      last_wake_at: at(0),
      last_wake_event_id: first.toHexString(),
      counted_event_id: first.toHexString(),
      failures: 0,
      stopped_at: null,
      last_verdict: 'failed',
      pg_version: 6,
    });

    // A record that fails on its second row: the first is stamped in both
    // stores, and the clear takes back only rows still at this stamp.
    const realUpsert = store.upsert;
    let calls = 0;
    const upsert = jest.spyOn(store, 'upsert').mockImplementation(async (...args) => {
      calls += 1;
      if (calls === 2) throw new Error('mongo down on the second row');
      return realUpsert(...args);
    });
    await expect(recordRowWakes([key(3), key(4), key(2)], { lastWakeAt: at(30), lastWakeEventId: null }))
      .rejects.toThrow('mongo down on the second row');
    upsert.mockRestore();
    expect(await row(key(3))).toMatchObject({ last_wake_at: at(30), pg_version: 1 });
    expect(await row(key(4))).toBeUndefined();
    expect(await clearRowWakeStamps([key(3), key(4), key(2)], at(30))).toBe(1);
    expect(await row(key(3))).toMatchObject({ last_wake_at: null, pg_version: 2 });
    expect(await row(key(2))).toMatchObject({ last_wake_at: at(0), last_wake_event_id: first.toHexString() });

    // The read, through = ANY in pg-read, in the lean shape with ObjectIds.
    await countRowOutcome(key(2), null, { countedEventId: second, failures: 0, lastVerdict: 'succeeded' });
    const fromMongo = (await AgentTaskRowWakeState.find({ _id: { $in: [key(1), key(2), key(3)] } })
      .sort({ _id: 1 }).lean()).map(unmarked);
    const queries = jest.spyOn(database.pool, 'query');
    const states = await findRowWakeStates([key(3), key(1), key(2), key(8)]);
    const sorted = [...states].sort((a, b) => (a._id < b._id ? -1 : 1));
    expect(sorted).toEqual(fromMongo);
    expect(sorted[1].countedEventId).toBeInstanceOf(Types.ObjectId);
    expect(String(sorted[1].countedEventId)).toBe(String(second));
    const anyRead = queries.mock.calls.some(([sql]) => /id = ANY\(\$1\)/.test(sql));
    expect(anyRead).toBe(mode === 'pg-read');
    queries.mockRestore();

    expect(await store.verify()).toMatchObject({
      mongo: 3, pg: 3, missing: 0, differs: 0, extra: 0,
    });
  });

  it('backfill copies documents written in mongo mode, ObjectIds included, and verify agrees', async () => {
    const eventId = new Types.ObjectId();
    await recordRowWakes([key(1)], { lastWakeAt: at(0), lastWakeEventId: eventId });
    await countRowOutcome(key(1), null, { countedEventId: eventId, failures: 1, lastVerdict: 'failed' });
    await AgentTaskRowWakeState.collection.insertOne({ _id: key(2), lastWakeAt: at(5), failures: 2 });
    process.env[ENV] = 'dual';
    const store = rowWakeStateStore();
    expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
    expect(await row(key(1))).toMatchObject({
      last_wake_event_id: eventId.toHexString(), counted_event_id: eventId.toHexString(), pg_version: 0,
    });
    expect(await store.verify()).toMatchObject({
      mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
    });
  });
});
