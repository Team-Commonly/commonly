/**
 * Ambient-only wake scoping, EXECUTED on pg-mem (W-T, TASK-029, 3/4).
 *
 *     effective = (participants ∪ explicitFollowers) − muted
 *
 * Every case here is about set arithmetic the SQL performs, so it runs the SQL.
 */
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const { effectiveFollowerIds, narrowToThread } = require('../../../services/threadWakeScopeService');

const POD = 'pod-1';
let seq = 100;
const nextRoot = () => { seq += 1; return seq; };

const post = (rootId, userId, id) => mockPool.query(
  'INSERT INTO messages (id, pod_id, user_id, content, thread_root_id) VALUES ($1,$2,$3,$4,$5)',
  [id, POD, userId, 'x', rootId],
);
const rootMsg = (id, userId) => mockPool.query(
  'INSERT INTO messages (id, pod_id, user_id, content, thread_root_id) VALUES ($1,$2,$3,$4,NULL)',
  [id, POD, userId, 'root'],
);
const state = (rootId, userId, following) => mockPool.query(
  'INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, following) VALUES ($1,$2,$3,$4)',
  [rootId, userId, POD, following],
);

beforeAll(async () => {
  await mockPool.query(`CREATE TABLE messages (
    id INTEGER PRIMARY KEY, pod_id VARCHAR(255), user_id VARCHAR(255), content TEXT,
    thread_root_id INTEGER)`);
  await mockPool.query(`CREATE TABLE thread_user_state (
    id SERIAL PRIMARY KEY, thread_root_id INTEGER NOT NULL, user_id VARCHAR(255) NOT NULL,
    pod_id VARCHAR(255) NOT NULL, following BOOLEAN, collapsed BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (thread_root_id, user_id))`);
});

describe('the three terms', () => {
  test('participants are included without any stored row', async () => {
    // The `following IS NULL` case: you posted, so you follow, and nothing
    // was written to say so.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'replier', r + 1000);
    expect([...await effectiveFollowerIds(r)].sort()).toEqual(['author', 'replier']);
  });

  test('the root author counts, even though the root carries no thread_root_id', async () => {
    // A root's own thread_root_id is NULL by design, so `WHERE thread_root_id
    // = $1` alone would omit the person who started the thread — the single
    // most obviously wrong omission available.
    const r = nextRoot();
    await rootMsg(r, 'author');
    expect([...await effectiveFollowerIds(r)]).toEqual(['author']);
  });

  test('an explicit follower who never posted is included', async () => {
    const r = nextRoot();
    await rootMsg(r, 'author');
    await state(r, 'lurker', true);
    expect([...await effectiveFollowerIds(r)].sort()).toEqual(['author', 'lurker']);
  });

  test('a muted participant is excluded — mute outranks participation', async () => {
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'quitter', r + 1000);
    await state(r, 'quitter', false);
    expect([...await effectiveFollowerIds(r)]).toEqual(['author']);
  });

  test('mute also outranks an explicit follow row — it IS that row', async () => {
    const r = nextRoot();
    await rootMsg(r, 'author');
    await state(r, 'author', false);
    expect([...await effectiveFollowerIds(r)]).toEqual([]);
  });

  test('a collapse-only row makes nobody a follower', async () => {
    // Row presence must never mean following. Someone who expanded a thread
    // and read it has expressed nothing about wanting to be woken.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await mockPool.query(
      'INSERT INTO thread_user_state (thread_root_id,user_id,pod_id,collapsed) VALUES ($1,$2,$3,FALSE)',
      [r, 'browser', POD],
    );
    expect([...await effectiveFollowerIds(r)]).toEqual(['author']);
  });

  test('participants are deduplicated — posting ten times is one follow', async () => {
    const r = nextRoot();
    await rootMsg(r, 'author');
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await post(r, 'author', r + 2000 + i);
    }
    expect([...await effectiveFollowerIds(r)]).toEqual(['author']);
  });

  test('another thread\'s state does not leak in', async () => {
    const a = nextRoot(); const b = nextRoot();
    await rootMsg(a, 'alice');
    await rootMsg(b, 'bob');
    await state(b, 'carol', true);
    expect([...await effectiveFollowerIds(a)]).toEqual(['alice']);
  });
});

describe('narrowToThread only ever narrows', () => {
  const inst = (name, uid) => ({ agentName: name, installedBy: uid });
  const identify = (t) => t.installedBy || null;

  test('an unthreaded message is untouched', async () => {
    const targets = [inst('a', 'u1'), inst('b', 'u2')];
    expect(await narrowToThread(null, targets, identify)).toEqual(targets);
  });

  test('a threaded message drops non-followers', async () => {
    const r = nextRoot();
    await rootMsg(r, 'u1');
    const kept = await narrowToThread(r, [inst('a', 'u1'), inst('b', 'u2')], identify);
    expect(kept.map((t) => t.agentName)).toEqual(['a']);
  });

  test('it never ADDS a target', async () => {
    // Scoping is subtractive. Threading must not start delivering to seats
    // that never opted in to anything.
    const r = nextRoot();
    await rootMsg(r, 'u1');
    await state(r, 'u-never-passed-in', true);
    const kept = await narrowToThread(r, [inst('a', 'u1')], identify);
    expect(kept).toHaveLength(1);
  });

  test('a target whose id cannot be resolved is KEPT, not dropped', async () => {
    // Degrade to today's behaviour, never to silence. A wake that vanishes
    // because an identity could not be classified is the failure nobody sees.
    const r = nextRoot();
    await rootMsg(r, 'u1');
    const kept = await narrowToThread(r, [inst('a', null)], identify);
    expect(kept).toHaveLength(1);
  });

  test('a DB failure falls back to unscoped delivery, not to silence', async () => {
    // The first version of this test claimed to cover this and did not — it
    // made `identify` throw and asserted the rejection, which exercises a
    // different path entirely. Make the QUERY fail, which is the case that
    // matters: a scoping outage must degrade to today's behaviour, because
    // silently muting every thread is the failure nobody would report.
    const spy = jest.spyOn(mockPool, 'query').mockRejectedValueOnce(new Error('connection lost'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const targets = [inst('a', 'u1'), inst('b', 'u2')];

    const kept = await narrowToThread(12345, targets, identify);

    expect(kept).toEqual(targets);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('[thread-scope]'), expect.stringContaining('connection lost'),
    );
    spy.mockRestore(); warn.mockRestore();
  });

  test('CONTROL: the same call succeeds once the query works again', async () => {
    // Without this, the test above passes from a permanently broken pool.
    const r = nextRoot();
    await rootMsg(r, 'u1');
    const kept = await narrowToThread(r, [inst('a', 'u1'), inst('b', 'u2')], identify);
    expect(kept.map((t) => t.agentName)).toEqual(['a']);
  });

  test('a thread with no followers at all wakes nobody', async () => {
    const kept = await narrowToThread(88888, [inst('a', 'u1')], identify);
    expect(kept).toEqual([]);
  });
});
