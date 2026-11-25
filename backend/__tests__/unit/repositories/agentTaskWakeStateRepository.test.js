/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the assigned-task wake throttle. The repository's Postgres
// table is the in-memory adapter here; Mongo is real, so the reservation's
// conditional writes race with their production atomicity.
const mockPg = { current: null, options: null };
jest.mock('../../../repositories/dualStore', () => {
  const actual = jest.requireActual('../../../repositories/dualStore');
  const forward = (method) => (...args) => mockPg.current[method](...args);
  return {
    ...actual,
    pgTableAdapter: (options) => {
      mockPg.options = options;
      return Object.fromEntries(['upsert', 'remove', 'replace', 'removeAt', 'get', 'scan', 'findWhere']
        .map((m) => [m, forward(m)]));
    },
  };
});
const fs = require('fs');
const path = require('path');
const AgentTaskWakeState = require('../../../models/AgentTaskWakeState');
const {
  reserveWake, releaseWake, taskWakeStateStore,
} = require('../../../repositories/agentTaskWakeStateRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_TASK_WAKE_STATE';
const INTERVAL = 30 * 60000;
const NOW = new Date('2026-11-25T10:00:00Z');
const minutes = (m) => new Date(NOW.getTime() + m * 60000);
const KEY = JSON.stringify(['codex', 'forge']);

describe('task wake state repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentTaskWakeState.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await AgentTaskWakeState.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await taskWakeStateStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (key = KEY) => AgentTaskWakeState.findById(key).lean();
  const rowOf = (key = KEY) => mockPg.current.rows.get(key);
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const STORE_FIELDS = ['pgVersion', 'pgPending', 'pgDeleted', '__v', 'createdAt', 'updatedAt'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));
  /** Reserve at 0, release, re-reserve at 1, wait out the interval, reserve at 40: every transition once. */
  const sequence = async (key) => {
    const outcomes = [];
    outcomes.push(await reserveWake(key, minutes(0), INTERVAL));
    outcomes.push(await reserveWake(key, minutes(10), INTERVAL));
    outcomes.push(await releaseWake(key, minutes(5)));
    outcomes.push(await releaseWake(key, minutes(0)));
    outcomes.push(await reserveWake(key, minutes(1), INTERVAL));
    outcomes.push(await reserveWake(key, minutes(40), INTERVAL));
    return outcomes;
  };
  const SEQUENCE_OUTCOMES = [true, false, false, true, true, true];

  it('declares the table and the id', () => {
    taskWakeStateStore();
    expect(mockPg.options).toMatchObject({ table: 'agent_task_wake_states', idColumn: 'id' });
  });

  it('names the columns 0019 creates, and nothing else', () => {
    taskWakeStateStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0019_agent_task_wake_states.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
    // A released slot has no lastWakeAt, so its column takes NULL.
    expect(sql).toMatch(/^\s+last_wake_at TIMESTAMPTZ,$/m);
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      const findOneAndUpdate = jest.spyOn(AgentTaskWakeState, 'findOneAndUpdate');
      const updateOne = jest.spyOn(AgentTaskWakeState, 'updateOne');

      expect(await reserveWake(KEY, NOW, INTERVAL)).toBe(true);
      expect(findOneAndUpdate).toHaveBeenCalledWith({
        _id: KEY,
        $or: [{ lastWakeAt: { $lte: new Date(NOW.getTime() - INTERVAL) } }, { lastWakeAt: null }],
      }, { $set: { lastWakeAt: NOW } }, { upsert: true, new: true });
      expect(findOneAndUpdate).toHaveBeenCalledTimes(1);

      // A held slot: the upsert's duplicate _id is the loser, answered as false.
      expect(await reserveWake(KEY, minutes(10), INTERVAL)).toBe(false);

      expect(await releaseWake(KEY, NOW)).toBe(true);
      expect(updateOne).toHaveBeenCalledWith({ _id: KEY, lastWakeAt: NOW }, { $unset: { lastWakeAt: 1 } });
      expect(updateOne).toHaveBeenCalledTimes(1);

      const doc = await raw();
      expect(doc.lastWakeAt).toBeUndefined();
      expect(doc.pgVersion).toBeUndefined();
      expect(doc.pgPending).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('passes through an error that is not a duplicate key', async () => {
      jest.spyOn(AgentTaskWakeState, 'findOneAndUpdate').mockRejectedValueOnce(new Error('mongo down'));
      await expect(reserveWake(KEY, NOW, INTERVAL)).rejects.toThrow('mongo down');
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same outcomes and document as mongo, and copies each change once', async () => {
      const mongoKey = JSON.stringify(['codex', 'mongo']);
      delete process.env[ENV];
      expect(await sequence(mongoKey)).toEqual(SEQUENCE_OUTCOMES);
      process.env[ENV] = mode;
      expect(await sequence(KEY)).toEqual(SEQUENCE_OUTCOMES);

      const doc = await raw();
      expect(payload(doc)).toEqual({ ...payload(await raw(mongoKey)), _id: KEY });
      expect(doc.lastWakeAt).toEqual(minutes(40));
      // insert, release, re-reserve, reserve: four writes, four versions, four copies.
      expect(doc.pgVersion).toBe(4);
      expect(doc.pgPending).toBeUndefined();
      expect(upserts()).toBe(4);
      expect(rowOf()).toEqual({
        row: {
          id: KEY, last_wake_at: minutes(40), created_at: doc.createdAt, updated_at: doc.updatedAt,
        },
        version: 4,
      });
      expect(await taskWakeStateStore().verify()).toMatchObject({ missing: 1, differs: 0, extra: 0 });
    });

    it('absent key: racing workers that both miss the update, exactly one inserts', async () => {
      // Both conditional updates find nothing before either insert runs.
      const store = taskWakeStateStore();
      const realUpdateWhere = store.updateWhere;
      let arrived = 0;
      let releaseBoth;
      const bothMissed = new Promise((resolve) => { releaseBoth = resolve; });
      jest.spyOn(store, 'updateWhere').mockImplementation(async (...args) => {
        const matched = await realUpdateWhere(...args);
        arrived += 1;
        if (arrived === 2) releaseBoth();
        await bothMissed;
        return matched;
      });
      const outcomes = await Promise.all([reserveWake(KEY, NOW, INTERVAL), reserveWake(KEY, minutes(0.01), INTERVAL)]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await AgentTaskWakeState.countDocuments({})).toBe(1);
      expect((await raw()).pgVersion).toBe(1);
      expect(upserts()).toBe(1);
    });

    it('absent key: five racing workers, one reserves', async () => {
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => reserveWake(KEY, NOW, INTERVAL)));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await raw()).toMatchObject({ lastWakeAt: NOW, pgVersion: 1 });
      expect(upserts()).toBe(1);
    });

    it('stale key: racing workers, one reserves', async () => {
      expect(await reserveWake(KEY, minutes(-31), INTERVAL)).toBe(true);
      const copies = upserts();
      const outcomes = await Promise.all(Array.from(
        { length: 5 }, (_, i) => reserveWake(KEY, minutes(i / 100), INTERVAL),
      ));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await raw()).toMatchObject({ pgVersion: 2 });
      expect(upserts()).toBe(copies + 1);
      expect(rowOf().version).toBe(2);
    });

    it('fresh key: nobody reserves, and nothing is written or copied', async () => {
      expect(await reserveWake(KEY, minutes(-29), INTERVAL)).toBe(true);
      const before = await raw();
      const copies = upserts();
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => reserveWake(KEY, NOW, INTERVAL)));
      expect(outcomes).toEqual([false, false, false, false, false]);
      expect(await raw()).toEqual(before);
      expect(upserts()).toBe(copies);
    });

    it('a release returns the slot for an immediate re-reserve, and the row follows', async () => {
      expect(await reserveWake(KEY, NOW, INTERVAL)).toBe(true);
      expect(await releaseWake(KEY, NOW)).toBe(true);
      const released = await raw();
      expect(released.lastWakeAt).toBeUndefined();
      expect(rowOf()).toMatchObject({ row: { last_wake_at: null }, version: 2 });
      const outcomes = await Promise.all([1, 2].map(() => reserveWake(KEY, minutes(1), INTERVAL)));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(rowOf()).toMatchObject({ row: { last_wake_at: minutes(1) }, version: 3 });
      expect(await taskWakeStateStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('a release by a worker whose now no longer matches releases nothing', async () => {
      expect(await reserveWake(KEY, minutes(-40), INTERVAL)).toBe(true);
      // Another worker took the stale slot since.
      expect(await reserveWake(KEY, NOW, INTERVAL)).toBe(true);
      const copies = upserts();
      expect(await releaseWake(KEY, minutes(-40))).toBe(false);
      expect(await raw()).toMatchObject({ lastWakeAt: NOW, pgVersion: 2 });
      expect(upserts()).toBe(copies);
      expect(await releaseWake(JSON.stringify(['nobody', 'x']), NOW)).toBe(false);
      expect(await AgentTaskWakeState.countDocuments({})).toBe(1);
    });

    it('a failed copy leaves the reservation standing and the marker for repair', async () => {
      expect(await reserveWake(KEY, minutes(-40), INTERVAL)).toBe(true);
      mockPg.current.failNext('upsert');
      expect(await reserveWake(KEY, NOW, INTERVAL)).toBe(true);
      expect(await raw()).toMatchObject({ lastWakeAt: NOW, pgVersion: 2, pgPending: 2 });
      expect(rowOf().version).toBe(1);
      // The held slot still holds while the copy is behind.
      expect(await reserveWake(KEY, minutes(1), INTERVAL)).toBe(false);
      expect(await taskWakeStateStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
      expect(rowOf()).toMatchObject({ row: { last_wake_at: NOW }, version: 2 });
    });

    it('backfill copies slots written before dual, released ones included, and verify agrees', async () => {
      const mongoKey = JSON.stringify(['codex', 'mongo']);
      delete process.env[ENV];
      expect(await reserveWake(mongoKey, NOW, INTERVAL)).toBe(true);
      expect(await releaseWake(mongoKey, NOW)).toBe(true);
      process.env[ENV] = mode;
      // A pre-dual document without timestamps.
      await AgentTaskWakeState.collection.insertOne({ _id: KEY, lastWakeAt: minutes(-5) });
      const store = taskWakeStateStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(rowOf(mongoKey)).toMatchObject({ row: { last_wake_at: null }, version: 0 });
      expect(await store.verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      // A dual write on a backfilled slot lands at the next version.
      expect(await reserveWake(mongoKey, minutes(1), INTERVAL)).toBe(true);
      expect(rowOf(mongoKey).version).toBe(1);
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });
  });

  it('pg: reserve and release refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    await expect(reserveWake(KEY, NOW, INTERVAL)).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(releaseWake(KEY, NOW)).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await AgentTaskWakeState.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });
});
