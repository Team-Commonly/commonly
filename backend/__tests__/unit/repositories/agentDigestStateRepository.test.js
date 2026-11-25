/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
// ADR-034 step 2 for the folded digest state. The repository's Postgres table
// is the in-memory adapter here; Mongo is real, so the fold's conditional
// writes run with their production atomicity.
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
const mongoose = require('mongoose');
const AgentDigestState = require('../../../models/AgentDigestState');
const {
  advanceFold, digestStateStore, getFoldState, listDueForWake, readUnreadDigest, settleDigest, startFoldState,
} = require('../../../repositories/agentDigestStateRepository');
const { pgTableAdapter: realPgTableAdapter } = jest.requireActual('../../../repositories/dualStore');
const { setupMongoDb, closeMongoDb } = require('../../utils/testUtils');
const { fakePg } = require('../../utils/fakePgAdapter');

const ENV = 'STORE_MODE_AGENT_DIGEST_STATE';
const at = (minute) => new Date(Date.UTC(2026, 10, 25, 10, minute));
const KEEP = 8;

describe('digest state repository (ADR-034 step 2)', () => {
  let scope;
  const eventIds = Array.from({ length: 12 }, () => new mongoose.Types.ObjectId());
  const newScope = () => ({ agentName: 'flint', instanceId: 'default', podId: new mongoose.Types.ObjectId() });

  beforeAll(async () => {
    await setupMongoDb();
    await AgentDigestState.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    await AgentDigestState.deleteMany({});
    scope = newScope();
    mockPg.current = fakePg();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    // The store's 5-second flag cache outlives a test; a repair pass on an
    // empty collection resets it, so each test starts unflagged.
    process.env[ENV] = 'dual';
    await digestStateStore().repair();
    delete process.env[ENV];
    mockPg.current.calls.length = 0;
  });
  afterEach(() => {
    delete process.env[ENV];
    jest.restoreAllMocks();
  });

  const raw = (s = scope) => AgentDigestState.findOne(s).lean();
  const rowOf = async (s = scope) => mockPg.current.rows.get(String((await raw(s))._id));
  const upserts = () => mockPg.current.calls.filter((call) => call === 'upsert').length;
  const firstFold = (s = scope, i = 0) => startFoldState(s, {
    unreadCount: 1, revision: 1, lastEventIds: [String(eventIds[i])],
    conversations: [{ label: 'pod conversation', count: 1 }], otherCount: 0,
    unreadSince: at(i), foldedThroughId: eventIds[i],
  });
  /** The fold service's step for event i, as it computes it from the state it read. */
  const foldStep = async (s, i) => {
    const state = await getFoldState(s);
    return advanceFold(s, { foldedThroughId: state.foldedThroughId, unreadCount: state.unreadCount }, {
      foldedThroughId: eventIds[i],
      eventId: String(eventIds[i]),
      conversations: [
        { label: 'pod conversation', count: state.unreadCount + 1 - (i % 3) },
        { label: `thread ${i}`, count: i % 3 },
      ],
      otherCount: i % 2,
      ...(state.unreadCount === 0 ? { unreadSince: at(i) } : {}),
      keepLastIds: KEEP,
    });
  };
  /** Twelve folds with a settle after the second: re-sets unreadSince, then crosses the lastEventIds cap. */
  const foldSequence = async (s) => {
    expect(await firstFold(s)).toBe(true);
    for (let i = 1; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      expect(await foldStep(s, i)).toBe(true);
      if (i === 1) {
        // eslint-disable-next-line no-await-in-loop
        const { revision } = await readUnreadDigest(s);
        // eslint-disable-next-line no-await-in-loop
        await settleDigest(s, revision);
      }
    }
  };
  const STORE_FIELDS = ['_id', 'podId', 'pgVersion', 'pgPending', 'pgDeleted', '__v', 'createdAt', 'updatedAt'];
  const payload = (doc) => Object.fromEntries(Object.entries(doc).filter(([key]) => !STORE_FIELDS.includes(key)));

  it('declares the table, its JSON columns and the id', () => {
    digestStateStore();
    expect(mockPg.options).toMatchObject({
      table: 'agent_digest_states',
      idColumn: 'id',
      jsonColumns: ['last_event_ids', 'conversations'],
    });
  });

  it('names the columns 0018 creates, and nothing else', () => {
    digestStateStore();
    const sql = fs.readFileSync(
      path.join(__dirname, '../../../config/migrations/0018_agent_digest_states.sql'), 'utf8',
    );
    const created = [...sql.matchAll(/^\s+([a-z_]+) (?:TEXT|TIMESTAMPTZ|INTEGER|JSONB)/gm)].map((m) => m[1]);
    expect([mockPg.options.idColumn, ...mockPg.options.columns, 'pg_version'].sort()).toEqual(created.sort());
  });

  describe('mongo (the default)', () => {
    it('makes the pre-step-2 Mongoose calls, with no markers and no Postgres call', async () => {
      const findOne = jest.spyOn(AgentDigestState, 'findOne');
      const updateOne = jest.spyOn(AgentDigestState, 'updateOne');
      const find = jest.spyOn(AgentDigestState, 'find');
      const create = jest.spyOn(AgentDigestState, 'create');

      expect(await firstFold()).toBe(true);
      expect(create).toHaveBeenCalledWith({
        ...scope, unreadCount: 1, revision: 1, lastEventIds: [String(eventIds[0])],
        conversations: [{ label: 'pod conversation', count: 1 }], otherCount: 0,
        unreadSince: at(0), foldedThroughId: eventIds[0],
      });
      expect(await firstFold()).toBe(false);

      expect(await foldStep(scope, 1)).toBe(true);
      expect(findOne).toHaveBeenCalledWith(scope);
      expect(updateOne).toHaveBeenLastCalledWith(
        { ...scope, foldedThroughId: eventIds[0], unreadCount: 1 },
        {
          $inc: { unreadCount: 1, revision: 1 },
          $set: {
            foldedThroughId: eventIds[1],
            conversations: [{ label: 'pod conversation', count: 1 }, { label: 'thread 1', count: 1 }],
            otherCount: 1,
          },
          $push: { lastEventIds: { $each: [String(eventIds[1])], $slice: -KEEP } },
        },
      );
      // Another writer moved the state: the stale expectation loses.
      expect(await advanceFold(scope, { foldedThroughId: eventIds[0], unreadCount: 1 }, {
        foldedThroughId: eventIds[2], eventId: String(eventIds[2]), conversations: [], otherCount: 0, keepLastIds: KEEP,
      })).toBe(false);

      const digest = await readUnreadDigest(scope);
      expect(findOne).toHaveBeenLastCalledWith({ ...scope, unreadCount: { $gt: 0 } });
      expect(digest).toEqual({
        unreadCount: 2, revision: 2, lastEventIds: [String(eventIds[0]), String(eventIds[1])],
        conversations: [{ label: 'pod conversation', count: 1 }, { label: 'thread 1', count: 1 }], otherCount: 1,
      });
      expect(await listDueForWake(at(30))).toEqual([{ ...scope, unreadSince: at(0) }]);
      expect(find).toHaveBeenCalledWith({ unreadCount: { $gt: 0 }, unreadSince: { $lte: at(30) } });

      await settleDigest(scope, 2);
      expect(updateOne).toHaveBeenLastCalledWith(
        { ...scope, revision: 2 },
        { $set: { unreadCount: 0, lastEventIds: [], conversations: [], otherCount: 0, unreadSince: null },
          $inc: { revision: 1 } },
      );
      expect(await readUnreadDigest(scope)).toBeNull();
      expect(await listDueForWake(at(30))).toEqual([]);

      const doc = await raw();
      expect(doc.pgVersion).toBeUndefined();
      expect(doc.pgPending).toBeUndefined();
      expect(mockPg.current.calls).toEqual([]);
    });
  });

  describe.each(['dual', 'pg-read'])('%s', (mode) => {
    beforeEach(() => { process.env[ENV] = mode; });

    it('the pipeline gives the same document as the mongo operator update, cap and unreadSince included', async () => {
      const mongoScope = newScope();
      delete process.env[ENV];
      await foldSequence(mongoScope);
      process.env[ENV] = mode;
      await foldSequence(scope);

      const expected = await raw(mongoScope);
      const doc = await raw();
      expect(payload(doc)).toEqual(payload(expected));
      // Ten folds since the settle; the cap kept the newest eight, oldest dropped first.
      expect(doc.lastEventIds).toEqual(eventIds.slice(4, 12).map(String));
      // Settled after the second fold, so unreadSince is the third fold's, not the first's.
      expect(doc.unreadSince).toEqual(at(2));
      expect(doc.unreadCount).toBe(10);
      // 1 create + 11 folds + 1 settle, each one version and one copy.
      expect(doc.pgVersion).toBe(13);
      expect(doc.pgPending).toBeUndefined();
      expect((await rowOf()).version).toBe(13);
      // The row is the document's (the mongo-mode one was never copied: it is the one missing).
      expect(await digestStateStore().verify()).toMatchObject({ missing: 1, differs: 0, extra: 0 });
    });

    it('copies each write as the row toRow gives, at its version', async () => {
      // The marker clear runs after the copy. Delayed, a clear that bumped the
      // model's updatedAt would leave the row's updated_at behind every time.
      const realUpdateOne = AgentDigestState.updateOne.bind(AgentDigestState);
      jest.spyOn(AgentDigestState, 'updateOne').mockImplementation(async (...args) => {
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        return realUpdateOne(...args);
      });
      await firstFold();
      let doc = await raw();
      expect(await rowOf()).toEqual({
        row: {
          id: String(doc._id),
          agent_name: 'flint',
          instance_id: 'default',
          pod_id: String(scope.podId),
          unread_count: 1,
          revision: 1,
          last_event_ids: [String(eventIds[0])],
          conversations: [{ label: 'pod conversation', count: 1 }],
          other_count: 0,
          unread_since: at(0),
          folded_through_id: String(eventIds[0]),
          created_at: doc.createdAt,
          updated_at: doc.updatedAt,
        },
        version: 1,
      });
      expect(await foldStep(scope, 1)).toBe(true);
      await settleDigest(scope, 2);
      doc = await raw();
      expect(doc).toMatchObject({ unreadCount: 0, revision: 3, pgVersion: 3 });
      expect(await rowOf()).toMatchObject({
        row: {
          unread_count: 0, revision: 3, last_event_ids: [], conversations: [], other_count: 0, unread_since: null,
        },
        version: 3,
      });
      expect(await digestStateStore().verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
      // A settle at a stale revision changes nothing and copies nothing.
      const copies = upserts();
      await settleDigest(scope, 2);
      expect((await raw()).pgVersion).toBe(3);
      expect(upserts()).toBe(copies);
    });

    it('two concurrent fold steps from the same state: exactly one wins, and it is copied once', async () => {
      await firstFold();
      const expected = { foldedThroughId: eventIds[0], unreadCount: 1 };
      const change = (i) => ({
        foldedThroughId: eventIds[i], eventId: String(eventIds[i]),
        conversations: [{ label: 'pod conversation', count: 2 }], otherCount: 0, keepLastIds: KEEP,
      });
      const copies = upserts();
      const outcomes = await Promise.all([
        advanceFold(scope, expected, change(1)), advanceFold(scope, expected, change(2)),
      ]);
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      const doc = await raw();
      expect(doc).toMatchObject({ unreadCount: 2, revision: 2, pgVersion: 2 });
      expect(doc.lastEventIds).toHaveLength(2);
      expect(upserts()).toBe(copies + 1);
      expect((await rowOf())).toMatchObject({ row: { unread_count: 2 }, version: 2 });
    });

    it('racing first folds create one state; the losers read false and copy nothing', async () => {
      const outcomes = await Promise.all(Array.from({ length: 5 }, () => firstFold()));
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(await AgentDigestState.countDocuments({})).toBe(1);
      expect((await raw()).pgVersion).toBe(1);
      expect(upserts()).toBe(1);
    });

    it('a failed copy leaves the write standing and the marker for repair', async () => {
      await firstFold();
      mockPg.current.failNext('upsert');
      expect(await foldStep(scope, 1)).toBe(true);
      expect(await raw()).toMatchObject({ unreadCount: 2, pgVersion: 2, pgPending: 2 });
      expect((await rowOf()).version).toBe(1);
      expect(await digestStateStore().repair()).toMatchObject({ copied: 1, failed: 0 });
      expect((await raw()).pgPending).toBeUndefined();
      expect(await rowOf()).toMatchObject({ row: { unread_count: 2 }, version: 2 });
    });

    it('backfill copies states written before dual, and verify agrees', async () => {
      const mongoScope = newScope();
      delete process.env[ENV];
      await firstFold(mongoScope);
      process.env[ENV] = mode;
      // A pre-dual document without timestamps or optional fields.
      await AgentDigestState.collection.insertOne({ ...scope, unreadCount: 2, revision: 2 });
      const store = digestStateStore();
      expect(await store.backfill({ dryRun: false })).toMatchObject({ scanned: 2, inserted: 2 });
      expect(await store.verify()).toMatchObject({
        mongo: 2, pg: 2, missing: 0, differs: 0, extra: 0,
      });
      // A dual write on a backfilled state lands at the next version.
      expect(await foldStep(mongoScope, 1)).toBe(true);
      expect((await rowOf(mongoScope)).version).toBe(1);
      expect(await store.verify()).toMatchObject({ missing: 0, differs: 0, extra: 0 });
    });

    it('refuses a filter Postgres could not run, before any read', async () => {
      await expect(digestStateStore().findWhere({ lastEventIds: 'x' })).rejects.toThrow(/cannot filter on/);
      await expect(digestStateStore().findWhere({ unreadCount: { $ne: 0 } })).rejects.toThrow(/\$ne/);
      await expect(digestStateStore().findOneWhere({ agentName: { $regex: 'fl' } })).rejects.toThrow(/\$regex/);
      await expect(digestStateStore().findWhere({ unreadSince: { $lte: null } })).rejects.toThrow(/against null/);
      await expect(digestStateStore().findWhere({ unreadSince: { $lte: '' } })).rejects.toThrow(/against null/);
      expect(mockPg.current.calls).toEqual([]);
    });
  });

  describe('pg-read reads', () => {
    beforeEach(() => { process.env[ENV] = 'pg-read'; });

    it('come from Postgres, in the Mongo shape', async () => {
      await firstFold();
      expect(await foldStep(scope, 1)).toBe(true);
      // Mark the row so a read from it is visible.
      mockPg.current.rows.get(String((await raw())._id)).row.other_count = 7;
      mockPg.current.calls.length = 0;

      expect(await getFoldState(scope)).toEqual({
        foldedThroughId: eventIds[1], unreadCount: 2,
        conversations: [{ label: 'pod conversation', count: 1 }, { label: 'thread 1', count: 1 }], otherCount: 7,
      });
      // The schema's lowercase applies to the Postgres filter as to the Mongo query.
      expect(await readUnreadDigest({ ...scope, agentName: 'FLINT' })).toMatchObject({ unreadCount: 2, otherCount: 7 });
      expect(await listDueForWake(at(30))).toEqual([{ ...scope, unreadSince: at(0) }]);
      expect(await listDueForWake(new Date(at(0).getTime() - 1))).toEqual([]);
      expect(mockPg.current.calls).toEqual(['findWhere', 'findWhere', 'findWhere', 'findWhere']);
    });

    it('fall back to Mongo while a document is flagged', async () => {
      await firstFold();
      mockPg.current.failNext('upsert');
      expect(await foldStep(scope, 1)).toBe(true);
      // Postgres still holds the first fold; Mongo has the second.
      expect((await rowOf()).row.unread_count).toBe(1);
      mockPg.current.calls.length = 0;
      expect(await readUnreadDigest(scope)).toMatchObject({ unreadCount: 2, revision: 2 });
      expect(await listDueForWake(at(30))).toEqual([{ ...scope, unreadSince: at(0) }]);
      expect(mockPg.current.calls).not.toContain('findWhere');

      await digestStateStore().repair();
      mockPg.current.calls.length = 0;
      expect(await readUnreadDigest(scope)).toMatchObject({ unreadCount: 2, revision: 2 });
      expect(mockPg.current.calls).toEqual(['findWhere']);
    });
  });

  it('pg: every write refuses until step 4, before any write', async () => {
    process.env[ENV] = 'pg';
    await expect(firstFold()).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(advanceFold(scope, { foldedThroughId: null, unreadCount: 0 }, {
      foldedThroughId: eventIds[0], eventId: String(eventIds[0]), conversations: [], otherCount: 0, keepLastIds: KEEP,
    })).rejects.toThrow(/not supported in pg mode until step 4/);
    await expect(settleDigest(scope, 1)).rejects.toThrow(/not supported in pg mode until step 4/);
    expect(await AgentDigestState.countDocuments({})).toBe(0);
    expect(mockPg.current.calls).toEqual([]);
  });

  describe("the Postgres adapter's filtered read", () => {
    const COLUMNS = ['agent_name', 'pod_id', 'unread_count', 'unread_since', 'last_event_ids'];
    const adapter = (pool) => realPgTableAdapter({
      pool, table: 'agent_digest_states', idColumn: 'id', columns: COLUMNS, jsonColumns: ['last_event_ids'],
    });
    const recordingPool = () => {
      const queries = [];
      const query = async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [], rowCount: 0 };
      };
      return { queries, query };
    };

    it('binds every value as a parameter, ANDs the conditions and orders by id', async () => {
      const pool = recordingPool();
      const since = at(1);
      await adapter(pool).findWhere({
        agent_name: "flint'; DROP TABLE x; --", unread_count: { $gt: 0, $lte: 9 }, unread_since: since, pod_id: null,
      }, 1);
      expect(pool.queries).toHaveLength(1);
      const { sql, params } = pool.queries[0];
      expect(sql).toContain('WHERE agent_name = $1 AND unread_count > $2 AND unread_count <= $3'
        + ' AND unread_since = $4 AND pod_id IS NULL');
      expect(sql).toMatch(/ORDER BY id COLLATE "C" LIMIT \$5$/);
      expect(sql).not.toContain('DROP');
      expect(params).toEqual(["flint'; DROP TABLE x; --", 0, 9, since, 1]);
    });

    it.each([
      ['an undeclared column', { revision: 1 }, /no column "revision"/],
      ['an identifier that is not a column', { 'id; DROP TABLE x': 1 }, /no column/],
      ['a JSON column', { last_event_ids: 'x' }, /is JSON/],
      ['$ne', { unread_count: { $ne: 0 } }, /operator "\$ne"/],
      ['$in', { unread_count: { $in: [1] } }, /operator "\$in"/],
      ['an empty condition', { unread_count: {} }, /empty condition/],
      ['a null range', { unread_since: { $lte: null } }, /needs a string/],
      ['an array value', { agent_name: ['flint'] }, /scalar or a range/],
      ['an object range value', { unread_count: { $gt: { $literal: 1 } } }, /needs a string/],
    ])('refuses %s before any query', async (_, where, message) => {
      const pool = recordingPool();
      await expect(adapter(pool).findWhere(where)).rejects.toThrow(message);
      expect(pool.queries).toEqual([]);
    });
  });
});
