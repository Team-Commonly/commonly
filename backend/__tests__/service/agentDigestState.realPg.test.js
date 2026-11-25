/* eslint-disable import/no-unresolved, import/extensions -- TypeScript modules expose CJS exports. */
/**
 * ADR-034 step 2 for AgentDigestState on real PostgreSQL: migration 0018, the
 * fold's writes through the real pgTableAdapter SQL with verify agreeing, and
 * the where-builder's filtered reads (a Date range against TIMESTAMPTZ, a bound
 * LIMIT, IS NULL, id order under COLLATE "C") as pg-read runs them.
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
const AgentDigestState = require('../../models/AgentDigestState');
const {
  startFoldState, advanceFold, readUnreadDigest, settleDigest, listDueForWake, digestStateStore,
} = require('../../repositories/agentDigestStateRepository');

const real = process.env.INTEGRATION_TEST === 'true' ? describe : describe.skip;
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../../config/migrations/0018_agent_digest_states.sql'), 'utf8',
);
const ENV = 'STORE_MODE_AGENT_DIGEST_STATE';
const at = (day) => new Date(Date.UTC(2026, 10, day));

real('AgentDigestState on real PostgreSQL (ADR-034 step 2)', () => {
  let database;
  const scopeOf = (podId, agentName = 'scout') => ({ agentName, instanceId: 'default', podId });
  const firstFold = (unreadSince, foldedThroughId = new mongoose.Types.ObjectId()) => ({
    unreadCount: 1,
    revision: 1,
    lastEventIds: ['e1'],
    conversations: [{ label: 'general', count: 1 }],
    otherCount: 0,
    unreadSince,
    foldedThroughId,
  });

  beforeAll(async () => {
    await setupMongoDb();
    await AgentDigestState.init();
  });
  afterAll(closeMongoDb);
  beforeEach(async () => {
    database = await createRealPgSchema();
    mockDb.pool = database.pool;
    await database.pool.query(MIGRATION);
    await AgentDigestState.deleteMany({});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(async () => {
    delete process.env[ENV];
    jest.restoreAllMocks();
    if (database) await database.close();
  });

  it('0018 is a no-op on a second run and keeps the scope unique', async () => {
    await database.pool.query(MIGRATION);
    const insert = `INSERT INTO agent_digest_states (id, agent_name, instance_id, pod_id, pg_version)
      VALUES ($1, 'scout', 'default', 'p', 1)`;
    await database.pool.query(insert, ['a']);
    await expect(database.pool.query(insert, ['b'])).rejects.toMatchObject({ code: '23505' });
  });

  it('dual: a first fold, two fold steps and a settle land in both stores, and verify finds them equal', async () => {
    process.env[ENV] = 'dual';
    const scope = scopeOf(new mongoose.Types.ObjectId());
    const first = new mongoose.Types.ObjectId();
    expect(await startFoldState(scope, firstFold(at(1), first))).toBe(true);
    expect(await startFoldState(scope, firstFold(at(1)))).toBe(false);
    const second = new mongoose.Types.ObjectId();
    expect(await advanceFold(scope, { foldedThroughId: first, unreadCount: 1 }, {
      foldedThroughId: second, eventId: 'e2', conversations: [{ label: 'general', count: 2 }], otherCount: 0, keepLastIds: 8,
    })).toBe(true);
    // A step from a stale state loses, and nothing is copied for it.
    expect(await advanceFold(scope, { foldedThroughId: first, unreadCount: 1 }, {
      foldedThroughId: second, eventId: 'e2', conversations: [], otherCount: 0, keepLastIds: 8,
    })).toBe(false);
    const digest = await readUnreadDigest(scope);
    expect(digest).toMatchObject({ unreadCount: 2, lastEventIds: ['e1', 'e2'], revision: 2 });
    await settleDigest(scope, digest.revision);

    const doc = await AgentDigestState.findOne(scope).lean();
    const { rows } = await database.pool.query('SELECT * FROM agent_digest_states');
    expect(rows).toEqual([expect.objectContaining({
      id: String(doc._id),
      agent_name: 'scout',
      pod_id: String(scope.podId),
      unread_count: 0,
      revision: 3,
      last_event_ids: [],
      conversations: [],
      unread_since: null,
      folded_through_id: String(second),
      updated_at: doc.updatedAt,
      pg_version: 3,
    })]);
    const verified = await digestStateStore().verify();
    expect(verified).toMatchObject({
      mongo: 1, pg: 1, missing: 0, differs: 0, extra: 0,
    });
    expect(verified.checksumPg).toBe(verified.checksumMongo);
  });

  describe('pg-read: filtered reads run on Postgres', () => {
    let pods;
    beforeEach(async () => {
      // Seeded in dual so both stores agree; ObjectIds created in order, so
      // their hex strings sort in creation order too.
      process.env[ENV] = 'dual';
      pods = Array.from({ length: 5 }, () => new mongoose.Types.ObjectId());
      await startFoldState(scopeOf(pods[0]), firstFold(at(1)));
      await startFoldState(scopeOf(pods[1]), firstFold(at(5))); // exactly at the threshold below
      await startFoldState(scopeOf(pods[2]), firstFold(at(9))); // after it
      await startFoldState(scopeOf(pods[3]), firstFold(at(1)));
      await settleDigest(scopeOf(pods[3]), 1); // nothing unread
      await startFoldState(scopeOf(pods[4]), firstFold(at(1), null)); // no cursor yet
      process.env[ENV] = 'pg-read';
    });

    it('the wake scan bounds a Date against TIMESTAMPTZ inclusively, skips nothing-unread rows, and orders by id', async () => {
      // Moved in Mongo only: a Postgres read still sees day 9.
      await AgentDigestState.collection.updateOne({ podId: pods[2] }, { $set: { unreadSince: at(1) } });
      const due = await listDueForWake(at(5));
      expect(due.map((row) => String(row.podId))).toEqual([pods[0], pods[1], pods[4]].map(String));
      expect(due[1]).toMatchObject({ agentName: 'scout', instanceId: 'default', unreadSince: at(5) });

      process.env[ENV] = 'dual'; // the same scan on Mongo sees the moved row
      expect((await listDueForWake(at(5))).map((row) => String(row.podId)).sort())
        .toEqual([pods[0], pods[1], pods[2], pods[4]].map(String).sort());
    });

    it('a single read binds its LIMIT, casts the name and the pod id as Mongo does, and finds nothing unread as null', async () => {
      expect(await readUnreadDigest(scopeOf(pods[1], 'SCOUT'))).toMatchObject({
        unreadCount: 1, lastEventIds: ['e1'], revision: 1, conversations: [{ label: 'general', count: 1 }],
      });
      expect(await readUnreadDigest(scopeOf(pods[3]))).toBeNull();
    });

    it('a null equality is IS NULL', async () => {
      const rows = await digestStateStore().findWhere({ foldedThroughId: null }, { fields: ['podId'] });
      expect(rows.map((row) => String(row.podId))).toEqual([String(pods[4])]);
    });
  });
});
