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

const { createTableFor } = require('../../utils/schemaTable');
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
// thread_user_state has a live FK to messages in the shipped schema, so a root
// referenced by state must exist as a row.
const stateRow = (rootId, userId, following, collapsed) => mockPool.query(
  `INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, following, collapsed)
   VALUES ($1,$2,$3,$4,$5)`,
  [rootId, userId, POD, following, collapsed],
);
const state = (rootId, userId, following) => mockPool.query(
  'INSERT INTO thread_user_state (thread_root_id, user_id, pod_id, following) VALUES ($1,$2,$3,$4)',
  [rootId, userId, POD, following],
);

beforeAll(async () => {
  // Shipped DDL, not hand-written — same correction as 2/4's suites
  // (@sprint-review 56811). This file still had a hand-rolled `messages` and
  // `thread_user_state`, so every constraint it leaned on was one typed here.
  await mockPool.query(createTableFor('pods'));
  await mockPool.query(createTableFor('messages'));
  await mockPool.query(createTableFor('thread_user_state'));
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'p','chat','u')", [POD]);
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

describe('readers filter on following = true, never on EXISTS(row)', () => {
  // @ux-lead (56820): once rows exist for non-followers,
  // every reader of follow state must filter on the COLUMN. Row presence stopped
  // meaning anything the moment collapse started writing rows.

  test('THE third state: (following=false, collapsed=false) gets no wake', async () => {
    // Muted AND expanded — the row most likely to be mistaken for engagement,
    // because it exists and the user actively opened the thread. Neither fact
    // is consent to be woken.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'muted-reader', r + 4000);
    await stateRow(r, 'muted-reader', false, false);

    expect([...await effectiveFollowerIds(r)]).toEqual(['author']);
  });

  test('and it still gets no wake when they are the ONLY participant', async () => {
    // The version with no one else to mask it: the set must be empty, not
    // fall back to "well, somebody should hear this".
    const r = nextRoot();
    await rootMsg(r, 'solo');
    await stateRow(r, 'solo', false, false);
    expect([...await effectiveFollowerIds(r)]).toEqual([]);
  });

  test('CONTROL: the same row with following=true DOES wake', async () => {
    // Proves the two above measure `following`, not the mere presence of a
    // row or the value of `collapsed`.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await stateRow(r, 'reader', true, false);
    expect([...await effectiveFollowerIds(r)].sort()).toEqual(['author', 'reader']);
  });

  test('CONTROL: and with following=NULL it falls back to participation', async () => {
    // The third value of the tri-state, so all three are covered here and not
    // just the two booleans.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'participant', r + 5000);
    await stateRow(r, 'participant', null, false);
    expect([...await effectiveFollowerIds(r)].sort()).toEqual(['author', 'participant']);
  });

  test('the query says following IS TRUE, not EXISTS', async () => {
    // Structural backstop for the rule itself, so a rewrite that reintroduces
    // EXISTS(row) is flagged even if it happens to pass the cases above.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/threadWakeScopeService.ts'), 'utf8',
    );
    expect(src).toMatch(/following IS TRUE/);
    expect(src).not.toMatch(/EXISTS\s*\(\s*SELECT[^)]*thread_user_state/i);
  });
});

describe('one participant, one row, one field flipped', () => {
  // @ux-lead (56822): "a participant at (NULL,
  // collapsed=false) is woken; the SAME participant at FALSE is not."
  //
  // Both halves already existed, but as separate cases with different users on
  // different roots — so a difference in outcome could in principle have come
  // from something other than `following`. This flips exactly one field on one
  // row and asserts the wake set changes by exactly that user. Nothing else
  // varies, which is the whole point of the pairing.

  test('flipping following NULL -> FALSE removes exactly that participant', async () => {
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'pat', r + 6000);
    await stateRow(r, 'pat', null, false);

    const woken = [...await effectiveFollowerIds(r)].sort();
    expect(woken).toEqual(['author', 'pat']);

    await mockPool.query(
      'UPDATE thread_user_state SET following = FALSE WHERE thread_root_id = $1 AND user_id = $2',
      [r, 'pat'],
    );

    const after = [...await effectiveFollowerIds(r)].sort();
    expect(after).toEqual(['author']);
    // Stated as a set difference so a change in the other direction, or a
    // change affecting somebody else, fails rather than passing on length.
    expect(woken.filter((u) => !after.includes(u))).toEqual(['pat']);
  });

  test('and flipping it back to NULL restores them', async () => {
    // The reverse, because a one-way test passes against code that simply
    // stops waking people.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'pat', r + 7000);
    await stateRow(r, 'pat', false, false);
    expect([...await effectiveFollowerIds(r)]).toEqual(['author']);

    await mockPool.query(
      'UPDATE thread_user_state SET following = NULL WHERE thread_root_id = $1 AND user_id = $2',
      [r, 'pat'],
    );
    expect([...await effectiveFollowerIds(r)].sort()).toEqual(['author', 'pat']);
  });

  test('collapsed is not consulted in either direction', async () => {
    // The field that must NOT matter. Same participant, following NULL
    // throughout, collapsed flipped: the wake set is identical.
    const r = nextRoot();
    await rootMsg(r, 'author');
    await post(r, 'pat', r + 8000);
    await stateRow(r, 'pat', null, true);
    const collapsed = [...await effectiveFollowerIds(r)].sort();

    await mockPool.query(
      'UPDATE thread_user_state SET collapsed = FALSE WHERE thread_root_id = $1 AND user_id = $2',
      [r, 'pat'],
    );
    expect([...await effectiveFollowerIds(r)].sort()).toEqual(collapsed);
  });
});
