/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the per-row assigned-task wake state. The repository's
// Postgres table is the in-memory adapter here; Mongo is real, so the
// conditional writes keep their production atomicity.
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
const { Types } = require('mongoose');
const AgentTaskRowWakeState = require('../../../models/AgentTaskRowWakeState');
const {
  rowWakeStateStore, findRowWakeStates, countRowOutcome, stopRowWake, unstopRowWake, resetRowWake,
  recordRowWakes, clearRowWakeStamps,
} = require('../../../repositories/agentTaskRowWakeStateRepository');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_TASK_ROW_WAKE_STATE';
const NOW = new Date('2026-11-25T10:00:00Z');
const minutes = (m) => new Date(NOW.getTime() + m * 60000);
const SEAT = JSON.stringify(['codex', 'forge']);
const key = (n) => `${SEAT}|row${n}`;
const KEY = key(1);

describe('task row wake state repository (ADR-034 step 2)', () => {
  beforeAll(async () => {
    await setupMongoDb();
    await AgentTaskRowWakeState.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await AgentTaskRowWakeState.deleteMany({});
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await rowWakeStateStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (k = KEY) => AgentTaskRowWakeState.findById(k).lean();
  const rowOf = (k = KEY) => mockPg.current.rows.get(k);
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const MARKERS = ['pgVersion', 'pgPending', 'pgDeleted'];
  const STORE_FIELDS = [...MARKERS, '__v', 'createdAt', 'updatedAt'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => !STORE_FIELDS.includes(k)));
  // The helper drops __v from every document it hands back, as it does the markers.
  const unmarked = (doc) => Object.fromEntries(Object.entries(doc).filter(([k]) => ![...MARKERS, '__v'].includes(k)));

  /**
   * Every caller shape once, in the service's order: stamp two rows, link the
   * wake, count its outcome twice (the second loses), stop, stop again
   * (loses), a stale un-stop (loses), the un-stop, a reset, a reset of an
   * absent row, and a compensation that finds one row still at its stamp.
   */
  const sequence = async (k1, k2, eventId) => {
    const out = [];
    await recordRowWakes([k1, k2], { lastWakeAt: NOW, lastWakeEventId: null });
    await recordRowWakes([k1, k2], { lastWakeEventId: eventId });
    out.push(await countRowOutcome(k1, undefined, { countedEventId: eventId, failures: 1, lastVerdict: 'failed' }));
    out.push(await countRowOutcome(k1, null, { countedEventId: eventId, failures: 2, lastVerdict: 'failed' }));
    out.push(await stopRowWake(k1, minutes(1)));
    out.push(await stopRowWake(k1, minutes(2)));
    out.push(await unstopRowWake(k1, minutes(2)));
    out.push(await unstopRowWake(k1, minutes(1)));
    out.push(await stopRowWake(k1, minutes(3)));
    out.push(await resetRowWake(k1));
    out.push(await resetRowWake(`${k1}-absent`));
    await recordRowWakes([k2], { lastWakeAt: minutes(5) });
    out.push(await clearRowWakeStamps([k1, k2], NOW));
    return out;
  };
  const SEQUENCE_OUTCOMES = [true, false, true, false, false, true, true, true, false, 1];

  it('declares the table, the id and the _id filter', () => {
    rowWakeStateStore();
    expect(mockPg.options).toMatchObject({ table: 'agent_task_row_wake_states', idColumn: 'id' });
  });

  it('names the columns 0025 creates, and nothing else', () => {
    rowWakeStateStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0025_agent_task_row_wake_states.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      // Mongoose casts the operations in place, so each is copied as it arrives.
      const written = [];
      const originalBulkWrite = AgentTaskRowWakeState.bulkWrite.bind(AgentTaskRowWakeState);
      jest.spyOn(AgentTaskRowWakeState, 'bulkWrite').mockImplementation((ops, ...rest) => {
        written.push(ops.map(({ updateOne }) => ({
          updateOne: { ...updateOne, update: { $set: { ...updateOne.update.$set } } },
        })));
        return originalBulkWrite(ops, ...rest);
      });
      const updateOne = jest.spyOn(AgentTaskRowWakeState, 'updateOne');
      const updateMany = jest.spyOn(AgentTaskRowWakeState, 'updateMany');
      const find = jest.spyOn(AgentTaskRowWakeState, 'find');
      const eventId = new Types.ObjectId();

      expect(await sequence(KEY, key(2), eventId)).toEqual(SEQUENCE_OUTCOMES);
      expect(written[0]).toEqual([KEY, key(2)].map((k) => ({
        updateOne: { filter: { _id: k }, update: { $set: { lastWakeAt: NOW, lastWakeEventId: null } }, upsert: true },
      })));
      expect(updateOne).toHaveBeenNthCalledWith(1, { _id: KEY, countedEventId: null }, {
        $set: { countedEventId: eventId, failures: 1, lastVerdict: 'failed' },
      });
      expect(updateOne).toHaveBeenNthCalledWith(3, { _id: KEY, stoppedAt: null }, { $set: { stoppedAt: minutes(1) } });
      expect(updateOne).toHaveBeenNthCalledWith(6, { _id: KEY, stoppedAt: minutes(1) }, { $set: { stoppedAt: null } });
      expect(updateOne).toHaveBeenNthCalledWith(8, { _id: KEY }, { $set: { failures: 0, stoppedAt: null } });
      expect(updateMany).toHaveBeenCalledWith(
        { _id: { $in: [KEY, key(2)] }, lastWakeAt: NOW }, { $set: { lastWakeAt: null } },
      );

      const states = await findRowWakeStates([KEY, key(2), key(3)]);
      expect(find).toHaveBeenCalledWith({ _id: { $in: [KEY, key(2), key(3)] } });
      expect(states.map((s) => s._id).sort()).toEqual([KEY, key(2)]);
      expect((await raw()).pgVersion).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('an ordered bulkWrite failing part-way leaves earlier rows stamped; the clear takes them back', async () => {
      await recordRowWakes([key(3)], { lastWakeAt: minutes(-30) });
      const original = AgentTaskRowWakeState.bulkWrite.bind(AgentTaskRowWakeState);
      jest.spyOn(AgentTaskRowWakeState, 'bulkWrite').mockImplementationOnce(async (ops) => {
        await original(ops.slice(0, 1));
        throw new Error('write failed after the first row');
      });
      await expect(recordRowWakes([KEY, key(2), key(3)], { lastWakeAt: NOW, lastWakeEventId: null }))
        .rejects.toThrow('write failed after the first row');
      expect((await raw()).lastWakeAt).toEqual(NOW);
      expect(await clearRowWakeStamps([KEY, key(2), key(3)], NOW)).toBe(1);
      expect((await raw()).lastWakeAt).toBeNull();
      expect((await raw(key(3))).lastWakeAt).toEqual(minutes(-30));
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('gives the same answers and documents as mongo, and copies each change', async () => {
      const eventId = new Types.ObjectId();
      const mongoKey = (n) => `${SEAT}|mongo${n}`;
      delete process.env[ENV];
      expect(await sequence(mongoKey(1), mongoKey(2), eventId)).toEqual(SEQUENCE_OUTCOMES);
      process.env[ENV] = mode;
      expect(await sequence(KEY, key(2), eventId)).toEqual(SEQUENCE_OUTCOMES);

      for (const [ours, theirs] of [[KEY, mongoKey(1)], [key(2), mongoKey(2)]]) {
        // eslint-disable-next-line no-await-in-loop
        const [doc, mongoDoc] = [await raw(ours), await raw(theirs)];
        expect(payload(doc)).toEqual({ ...payload(mongoDoc), _id: ours });
        expect(Object.keys(doc).filter((k) => !MARKERS.includes(k)).sort())
          .toEqual(Object.keys(mongoDoc).sort());
        expect(doc.pgPending).toBeUndefined();
        expect(rowOf(ours).version).toBe(doc.pgVersion);
      }
      // KEY: stamp, link, count, stop, un-stop, stop, reset, clear: eight versions.
      expect((await raw()).pgVersion).toBe(8);
      expect(rowOf()).toEqual({
        row: {
          id: KEY,
          last_wake_at: null,
          last_wake_event_id: eventId.toHexString(),
          counted_event_id: eventId.toHexString(),
          failures: 0,
          stopped_at: null,
          last_verdict: 'failed',
          created_at: (await raw()).createdAt,
          updated_at: (await raw()).updatedAt,
        },
        version: 8,
      });
      // The two mongo-mode documents have no row; ours do, and match.
      expect(await rowWakeStateStore().verify()).toMatchObject({ missing: 2, differs: 0, extra: 0 });
    });

    it('reads in the lean shape, ObjectIds included, from whichever store the mode reads', async () => {
      const eventId = new Types.ObjectId();
      await recordRowWakes([KEY, key(2)], { lastWakeAt: NOW, lastWakeEventId: eventId });
      await countRowOutcome(KEY, null, { countedEventId: eventId, failures: 0, lastVerdict: 'succeeded' });
      const fromMongo = (await AgentTaskRowWakeState.find({ _id: { $in: [KEY, key(2)] } }).sort({ _id: 1 }).lean())
        .map(unmarked);
      mockPg.current.calls.length = 0;

      const states = await findRowWakeStates([key(2), KEY, key(9)]);
      const sorted = [...states].sort((a, b) => (a._id < b._id ? -1 : 1));
      expect(sorted).toEqual(fromMongo);
      expect(sorted[0].countedEventId).toBeInstanceOf(Types.ObjectId);
      expect(String(sorted[0].lastWakeEventId)).toBe(String(eventId));
      expect(mockPg.current.calls.includes('findWhere')).toBe(mode === 'pg-read');
    });

    it('an empty key list reads nothing and makes no call', async () => {
      const find = jest.spyOn(AgentTaskRowWakeState, 'find');
      expect(await findRowWakeStates([])).toEqual([]);
      expect(await clearRowWakeStamps([], NOW)).toBe(0);
      expect(find).not.toHaveBeenCalled();
      expect(mockPg.current.calls).toEqual([]);
    });

    it('the null-equality filters answer 0 or 1 as modifiedCount did, and only a change is copied', async () => {
      const first = new Types.ObjectId();
      const second = new Types.ObjectId();
      expect(await countRowOutcome(KEY, null, { countedEventId: first, failures: 1, lastVerdict: 'failed' }))
        .toBe(false);
      expect(await AgentTaskRowWakeState.countDocuments({})).toBe(0);

      await recordRowWakes([KEY], { lastWakeAt: NOW, lastWakeEventId: first });
      const copies = upserts();
      // countedEventId is null: a missing prior matches it, as `?? null` does.
      expect(await countRowOutcome(KEY, undefined, { countedEventId: first, failures: 1, lastVerdict: 'failed' }))
        .toBe(true);
      // Another scheduler's count of the same run: its prior is stale.
      expect(await countRowOutcome(KEY, null, { countedEventId: first, failures: 2, lastVerdict: 'failed' }))
        .toBe(false);
      // The next run counts only against the event counted last.
      expect(await countRowOutcome(KEY, second, { countedEventId: second, failures: 2, lastVerdict: 'failed' }))
        .toBe(false);
      expect(await countRowOutcome(KEY, first, { countedEventId: second, failures: 2, lastVerdict: 'failed' }))
        .toBe(true);
      expect(await raw()).toMatchObject({ countedEventId: second, failures: 2, lastVerdict: 'failed' });
      expect(upserts()).toBe(copies + 2);

      expect(await stopRowWake(KEY, NOW)).toBe(true);
      expect(await stopRowWake(KEY, minutes(1))).toBe(false);
      expect(await unstopRowWake(KEY, minutes(1))).toBe(false);
      expect(await unstopRowWake(KEY, NOW)).toBe(true);
      expect(await raw()).toMatchObject({ stoppedAt: null });
      expect(upserts()).toBe(copies + 4);
      expect(rowOf()).toMatchObject({ row: { stopped_at: null, counted_event_id: second.toHexString() } });
    });

    it('a reset never inserts, and clears failures and the stop', async () => {
      expect(await resetRowWake(KEY)).toBe(false);
      expect(await AgentTaskRowWakeState.countDocuments({})).toBe(0);
      expect(mockPg.current.calls).toEqual([]);
      await recordRowWakes([KEY], { lastWakeAt: NOW, lastWakeEventId: null });
      await countRowOutcome(KEY, null, { countedEventId: new Types.ObjectId(), failures: 3, lastVerdict: 'failed' });
      await stopRowWake(KEY, NOW);
      expect(await resetRowWake(KEY)).toBe(true);
      expect(await raw()).toMatchObject({ failures: 0, stoppedAt: null });
      expect(rowOf()).toMatchObject({ row: { failures: 0, stopped_at: null } });
    });

    it('a record that fails part-way leaves the earlier rows stamped in both stores, and the clear takes them back',
      async () => {
        // key(3) was woken earlier and must keep its own stamp.
        await recordRowWakes([key(3)], { lastWakeAt: minutes(-30), lastWakeEventId: null });
        const store = rowWakeStateStore();
        const realUpsert = store.upsert;
        let calls = 0;
        jest.spyOn(store, 'upsert').mockImplementation(async (...args) => {
          calls += 1;
          if (calls === 2) throw new Error('mongo down on the second row');
          return realUpsert(...args);
        });
        await expect(recordRowWakes([KEY, key(2), key(3)], { lastWakeAt: NOW, lastWakeEventId: null }))
          .rejects.toThrow('mongo down on the second row');
        // Ordered: the first row is stamped, the loop stopped at the second.
        expect(calls).toBe(2);
        expect((await raw()).lastWakeAt).toEqual(NOW);
        expect(await raw(key(2))).toBeNull();
        expect(rowOf()).toMatchObject({ row: { last_wake_at: NOW }, version: 1 });

        expect(await clearRowWakeStamps([KEY, key(2), key(3)], NOW)).toBe(1);
        expect(await raw()).toMatchObject({ lastWakeAt: null, pgVersion: 2 });
        // The clear reaches Postgres above the stamp's version.
        expect(rowOf()).toMatchObject({ row: { last_wake_at: null }, version: 2 });
        expect((await raw(key(3))).lastWakeAt).toEqual(minutes(-30));
        expect(rowOf(key(3))).toMatchObject({ row: { last_wake_at: minutes(-30) }, version: 1 });
        expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
      });

    it('a failed copy is not a failed record: it resolves, and repair finishes the row', async () => {
      mockPg.current.failNext('upsert');
      await expect(recordRowWakes([KEY, key(2)], { lastWakeAt: NOW, lastWakeEventId: null })).resolves.toBeUndefined();
      expect(await raw()).toMatchObject({ lastWakeAt: NOW, pgVersion: 1, pgPending: 1 });
      expect(rowOf()).toBeUndefined();
      expect(rowOf(key(2))).toMatchObject({ version: 1 });
      expect(await rowWakeStateStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
      expect(rowOf()).toMatchObject({ row: { last_wake_at: NOW }, version: 1 });
    });

    it('backfill copies documents written before dual, ObjectIds and legacy gaps too, and verify agrees', async () => {
      const eventId = new Types.ObjectId();
      delete process.env[ENV];
      await recordRowWakes([KEY], { lastWakeAt: NOW, lastWakeEventId: eventId });
      await countRowOutcome(KEY, null, { countedEventId: eventId, failures: 1, lastVerdict: 'failed' });
      process.env[ENV] = mode;
      // A document from before countedEventId, lastVerdict and the timestamps.
      await AgentTaskRowWakeState.collection.insertOne({ _id: key(2), lastWakeAt: minutes(-5), failures: 2 });
      const store = rowWakeStateStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(rowOf()).toMatchObject({
        row: { last_wake_event_id: eventId.toHexString(), counted_event_id: eventId.toHexString(), failures: 1 },
        version: 0,
      });
      expect(rowOf(key(2))).toMatchObject({
        row: { counted_event_id: null, last_verdict: null, created_at: null, failures: 2 }, version: 0,
      });
      expect(await store.verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      // A dual write on a backfilled document lands at the next version.
      expect(await stopRowWake(KEY, NOW)).toBe(true);
      expect(rowOf().version).toBe(1);
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it("the record's pipeline and its pg merge agree, on a first write and on a later one", async () => {
      const store = rowWakeStateStore();
      const changes = [];
      const realUpsert = store.upsert;
      jest.spyOn(store, 'upsert').mockImplementation(async (id, change) => {
        changes.push(change);
        return realUpsert(id, change);
      });
      const eventId = new Types.ObjectId();
      await recordRowWakes([KEY], { lastWakeAt: NOW, lastWakeEventId: null });
      const created = unmarked(await raw());
      expect(payload({ ...changes[0].merge(null), _id: KEY })).toEqual(payload(created));
      await stopRowWake(KEY, NOW);
      const before = unmarked(await raw());
      await recordRowWakes([KEY], { lastWakeEventId: eventId });
      const after = unmarked(await raw());
      expect(payload(changes[1].merge(before))).toEqual(payload(after));
      expect(after.createdAt).toEqual(created.createdAt);
    });
  });

  it('pg: reads Postgres, and the writes refuse until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    mockPg.current.rows.set(KEY, {
      row: {
        id: KEY, last_wake_at: NOW, last_wake_event_id: null, counted_event_id: null, failures: 0,
        stopped_at: null, last_verdict: null, created_at: NOW, updated_at: NOW,
      },
      version: 1,
    });
    expect(await findRowWakeStates([KEY])).toEqual([{
      _id: KEY, lastWakeAt: NOW, lastWakeEventId: null, countedEventId: null, failures: 0,
      stoppedAt: null, lastVerdict: null, createdAt: NOW, updatedAt: NOW,
    }]);
    mockPg.current.calls.length = 0;
    const refused = /not supported in pg mode until step 4/;
    await expect(recordRowWakes([KEY], { lastWakeAt: NOW, lastWakeEventId: null })).rejects.toThrow(refused);
    await expect(clearRowWakeStamps([KEY], NOW)).rejects.toThrow(refused);
    await expect(countRowOutcome(KEY, null, { countedEventId: null, failures: 0, lastVerdict: 'neutral' }))
      .rejects.toThrow(refused);
    await expect(stopRowWake(KEY, NOW)).rejects.toThrow(refused);
    await expect(unstopRowWake(KEY, NOW)).rejects.toThrow(refused);
    await expect(resetRowWake(KEY)).rejects.toThrow(refused);
    expect(mockPg.current.calls).toEqual([]);
    expect(await AgentTaskRowWakeState.countDocuments({})).toBe(0);
  });
});
