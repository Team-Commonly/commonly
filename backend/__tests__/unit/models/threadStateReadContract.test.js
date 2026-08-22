/**
 * What the read says about a thread with NO row (W-T, TASK-029, 2/4).
 *
 * @sprint-review (56808): "collapsed defaults true for everyone" means an
 * absent row must READ as collapsed, so whatever the read does with a missing
 * row needs asserting — not just the column default. The column default only
 * governs rows that get created; it says nothing about threads nobody has
 * touched, which is most of them.
 *
 * Before this, `stateForPod` had no executing test at all — only a check that
 * the function exists. The absence contract lived entirely in a comment and a
 * JSON key.
 *
 * Executed end-to-end through the real controller handler, because the mapping
 * from row to payload is where the contract is actually expressed.
 */
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));
jest.mock('../../../services/podWriteAccessService', () => ({
  getCallerId: (req) => req.userId,
  callerHasPodWriteAccess: async () => true,
}));

const ThreadUserState = require('../../../models/pg/ThreadUserState');
const { listThreadState } = require('../../../controllers/threadStateController');

const POD = 'pod-1';
const OTHER_POD = 'pod-2';

const read = async (userId = 'u1', podId = POD) => {
  let payload;
  const res = { status: () => res, json: (d) => { payload = d; } };
  await listThreadState({ userId, query: { podId }, params: {} }, res);
  return payload;
};

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE thread_user_state (
    id SERIAL PRIMARY KEY, thread_root_id INTEGER NOT NULL, user_id VARCHAR(255) NOT NULL,
    pod_id VARCHAR(255) NOT NULL, following BOOLEAN, collapsed BOOLEAN NOT NULL DEFAULT TRUE,
    followed_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (thread_root_id, user_id))`);
  await mockPool.query(`CREATE TABLE migration_records (
    name VARCHAR(255) PRIMARY KEY, applied_at TIMESTAMP WITH TIME ZONE, details JSONB)`);
});
beforeEach(async () => { await mockPool.query('DELETE FROM thread_user_state'); });

describe('a thread with no row', () => {
  test('is ABSENT from the payload — the read never fabricates a row', async () => {
    // Returning a synthesised row per thread would mean the server enumerating
    // every root in the pod, and would make "has expressed nothing" and "chose
    // the default" indistinguishable downstream.
    const p = await read();
    expect(p.threads).toEqual([]);
  });

  test('and the payload states the default it should be read with', async () => {
    // The contract has to be on the wire. If it lives only in a comment, the
    // client hardcodes it and the two drift silently.
    const p = await read();
    expect(p.defaults.collapsed).toBe(true);
    expect(p.defaults.following).toBeNull();
  });

  test('so absence and an explicit collapsed:true differ in payload, not in meaning', async () => {
    // Both must render collapsed. This is the pair a client is most likely to
    // treat differently by accident.
    await ThreadUserState.setCollapsed(10, 'u1', POD, true);
    const p = await read();
    expect(p.threads).toEqual([{ threadRootId: 10, following: null, collapsed: true }]);
    expect(p.defaults.collapsed).toBe(true);
  });

  test('while absence and an explicit collapsed:false differ in BOTH', async () => {
    // The case that makes the row worth storing at all.
    await ThreadUserState.setCollapsed(11, 'u1', POD, false);
    const p = await read();
    expect(p.threads).toEqual([{ threadRootId: 11, following: null, collapsed: false }]);
  });
});

describe('following round-trips as three states, not two', () => {
  test('NULL stays null and does not become false', async () => {
    // Boolean(null) is false, and false is a MUTE. A careless mapping turns
    // every collapse-only row into a muted thread.
    await ThreadUserState.setCollapsed(20, 'u1', POD, false);
    const p = await read();
    expect(p.threads[0].following).toBeNull();
    expect(p.threads[0].following).not.toBe(false);
  });

  test('TRUE and FALSE both survive', async () => {
    await ThreadUserState.follow(21, 'u1', POD);
    await ThreadUserState.unfollow(22, 'u1', POD);
    const byRoot = Object.fromEntries((await read()).threads.map((t) => [t.threadRootId, t.following]));
    expect(byRoot[21]).toBe(true);
    expect(byRoot[22]).toBe(false);
  });
});

describe('the read is scoped', () => {
  test('another pod\'s rows do not appear', async () => {
    await ThreadUserState.follow(30, 'u1', OTHER_POD);
    expect((await read('u1', POD)).threads).toEqual([]);
  });

  test('another user\'s rows do not appear', async () => {
    await ThreadUserState.follow(31, 'someone-else', POD);
    expect((await read('u1', POD)).threads).toEqual([]);
  });

  test('CONTROL: the same row DOES appear for its own owner and pod', async () => {
    // Without this the two tests above pass from a read that returns nothing.
    await ThreadUserState.follow(32, 'u1', POD);
    expect((await read('u1', POD)).threads.map((t) => t.threadRootId)).toEqual([32]);
  });
});
