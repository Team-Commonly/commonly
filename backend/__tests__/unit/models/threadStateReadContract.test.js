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
 *
 * CONTRACT CHANGED, @ux-lead's ruling (56996). The payload used to be sparse —
 * only rows that exist — plus a `defaults` block carrying the threading cutoff,
 * leaving the client to notice absence and compare timestamps. Now every root
 * in the pod is returned with `collapsed` already resolved, and the cutoff
 * never crosses the wire.
 *
 * These tests are the executable record of a decided behaviour, so they are
 * rewritten rather than deleted, and every one keeps its original intent —
 * reviewer-checklist rule 3: an inverted assertion cites the ruling that
 * authorises it. What changes is WHERE the answer is read: a rendered
 * `collapsed` per thread instead of a `defaults` field the client applies.
 *
 * The fixture changed too, and the reason is load-bearing. It used to seed
 * lone messages as "roots" because root-ness did not matter — the payload
 * keyed off `thread_user_state`, and the message rows existed only to satisfy
 * the FK. Now the payload is driven by the pod's roots, so a root must be
 * something a reply actually points at, and the fixture has to build real
 * threads. A lone message is not a thread and must not render as one.
 */
const { newDb } = require('pg-mem');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));
// Mock ONLY the part that touches Mongo. `getCallerId` comes from
// requireActual, so this suite exercises the real identity resolution.
//
// It previously hand-wrote `getCallerId: (req) => req.userId`, which is the
// defect @sprint-review found in #1113's test mocks and @sprint-impl fixed the
// same way at ad274e3e. Mine was worse than a copied list: the real function is
// `req.user?._id || req.userId || req.agentUser?._id`, so the mock ignored the
// first branch entirely and — the part that matters — the AGENT branch, which
// is the whole reason these routes are dualAuth. Every read test here was
// passing without ever resolving an agent caller.
jest.mock('../../../services/podWriteAccessService', () => ({
  ...jest.requireActual('../../../services/podWriteAccessService'),
  // The membership check is the only thing that needs stubbing: it queries
  // AgentInstallation and pod_members, neither of which exists in pg-mem here.
  callerHasPodWriteAccess: async () => true,
}));

const { applyTable } = require('../../utils/schemaTable');
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
  // Shipped DDL, not a hand-written copy — see __tests__/utils/schemaTable.js.
  // The real dependency chain. thread_user_state -> messages -> pods, and the
  // hand-written fixture had none of it — another thing building from the
  // shipped DDL surfaces rather than hides.
  await applyTable(mockPool, 'pods');
  await applyTable(mockPool, 'messages');
  await applyTable(mockPool, 'thread_user_state');
  await applyTable(mockPool, 'migration_records');
});
// Roots must be real message rows — thread_user_state has a live FK to
// messages in the shipped schema, which the old hand-written fixture omitted.
// A root plus the reply that makes it one. `id + 1000` keeps reply ids clear
// of the root ids the tests name.
const seedRoot = async (id, pod = POD) => {
  await mockPool.query(
    'INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1,$2,$3,$4)',
    [id, pod, 'author', 'root'],
  );
  await mockPool.query(
    `INSERT INTO messages (id, pod_id, user_id, content, thread_root_id)
     VALUES ($1,$2,$3,$4,$5)`,
    [id + 1000, pod, 'author', 'reply', id],
  );
};

beforeAll(async () => {
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'p','chat','u')", [POD]);
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'p2','chat','u')", [OTHER_POD]);
  for (const id of [10, 11, 20, 21, 22, 31, 32, 40, 41]) await seedRoot(id);
  // 30 lives in the OTHER pod — the scoping tests need a root that is not ours.
  await seedRoot(30, OTHER_POD);
  // 99 is a lone message with no reply: present in `messages`, not a thread.
  await mockPool.query(
    "INSERT INTO messages (id, pod_id, user_id, content) VALUES (99,$1,'author','lonely')",
    [POD],
  );
});

beforeEach(async () => { await mockPool.query('DELETE FROM thread_user_state'); });

// A ledger row with a past cutoff: every fixture root is created "now", so
// this makes them all post-cutoff and therefore collapsed-by-default. Without
// it the instance reads as cutoffUnknown, which expands everything — correct,
// and the wrong baseline for testing the collapse default.
const seedPastCutoff = () => mockPool.query(
  `INSERT INTO migration_records (name, details)
   VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":"2020-01-01T00:00:00Z"}'::jsonb)`,
);

describe('a thread with no row', () => {
  const collapsedOf = (p, id) => p.threads.find((t) => t.threadRootId === id)?.collapsed;
  beforeEach(async () => {
    await mockPool.query('DELETE FROM migration_records');
    await seedPastCutoff();
  });

  test('APPEARS in the payload, resolved — the client never sees absence', async () => {
    // Inverted from "is ABSENT", per @ux-lead 56996. The old shape made
    // "expressed nothing" and "chose the default" distinguishable downstream,
    // and charged every client the threading cutoff for the privilege.
    const p = await read();
    expect(p.threads.map((t) => t.threadRootId).sort((a, b) => a - b))
      .toEqual([10, 11, 20, 21, 22, 31, 32, 40, 41]);
    for (const t of p.threads) expect(typeof t.collapsed).toBe('boolean');
  });

  test('a lone message is not a thread and does not appear', async () => {
    // Otherwise every message in the pod arrives as a collapsed thread.
    expect((await read()).threads.map((t) => t.threadRootId)).not.toContain(99);
  });

  test('and the payload no longer states a collapsed default, because none is needed', async () => {
    // The contract used to have to be on the wire so the client could apply
    // it. There is no case left in which the client supplies `collapsed`, so
    // shipping a default would be shipping a rule nobody runs.
    const p = await read();
    expect(p.defaults.collapsed).toBeUndefined();
    expect(p.defaults.expandedForRootsCreatedBefore).toBeUndefined();
    expect(p.defaults.cutoffUnknown).toBeUndefined();
    // `following` still has one, because null is a value the client interprets.
    expect(p.defaults.following).toBeNull();
  });

  test('so absence and an explicit collapsed:true are now identical in payload too', async () => {
    // Same meaning as before — both render collapsed. The difference is that
    // the payload no longer exposes which one you are looking at, which is the
    // point: it was never information a renderer should act on.
    await ThreadUserState.setCollapsed(10, 'u1', POD, true);
    const p = await read();
    expect(collapsedOf(p, 10)).toBe(true);
    expect(collapsedOf(p, 11)).toBe(true);
  });

  test('while absence and an explicit collapsed:false still differ', async () => {
    // The case that makes the row worth storing at all.
    await ThreadUserState.setCollapsed(11, 'u1', POD, false);
    const p = await read();
    expect(collapsedOf(p, 11)).toBe(false);
    expect(collapsedOf(p, 10)).toBe(true);
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

describe('an agent caller resolves through the real identity chain', () => {
  test('a cm_agent_* caller (req.agentUser) sees its own rows', async () => {
    // The dualAuth path. agentRuntimeAuth sets req.agentUser and NOT
    // req.userId, so a mock that only reads req.userId can never reach this —
    // which is exactly why it went unnoticed.
    await ThreadUserState.follow(40, 'bot-user-1', POD);
    let payload;
    const res = { status: () => res, json: (d) => { payload = d; } };
    await listThreadState(
      { agentUser: { _id: 'bot-user-1' }, query: { podId: POD }, params: {} }, res,
    );
    // Every root is in the payload now, so identity shows in the VALUES, not
    // in the row list: only this caller's follow is visible as following=true.
    const followed = payload.threads.filter((t) => t.following === true).map((t) => t.threadRootId);
    expect(followed).toEqual([40]);
  });

  test('req.user._id wins over req.userId, as the real chain orders them', async () => {
    await ThreadUserState.follow(41, 'preferred-id', POD);
    let payload;
    const res = { status: () => res, json: (d) => { payload = d; } };
    await listThreadState(
      { user: { _id: 'preferred-id' }, userId: 'ignored-id', query: { podId: POD }, params: {} }, res,
    );
    const followed = payload.threads.filter((t) => t.following === true).map((t) => t.threadRootId);
    expect(followed).toEqual([41]);
  });
});

describe('the read is scoped', () => {
  const idsIn = async (u, pod) => (await read(u, pod)).threads.map((t) => t.threadRootId);

  test("another pod's roots do not appear", async () => {
    // 30 is the OTHER pod's root. Scoping is now by the ROOT's pod, not by the
    // state row's — the payload is a view of this pod's threads.
    expect(await idsIn('u1', POD)).not.toContain(30);
    expect(await idsIn('u1', OTHER_POD)).toEqual([30]);
  });

  test("another user's state does not leak into mine", async () => {
    // Their row no longer changes WHICH threads I see — every root is mine to
    // render — so the leak would now be in the VALUE. That is the sharper
    // test: with their follow present, mine must still read null.
    await ThreadUserState.follow(31, 'someone-else', POD);
    const mine = (await read('u1', POD)).threads.find((t) => t.threadRootId === 31);
    expect(mine.following).toBeNull();
    const theirs = (await read('someone-else', POD)).threads.find((t) => t.threadRootId === 31);
    expect(theirs.following).toBe(true);
  });

  test('CONTROL: my own row DOES reach me', async () => {
    // Without this the test above passes from a read that resolves nothing.
    await ThreadUserState.follow(32, 'u1', POD);
    const mine = (await read('u1', POD)).threads.find((t) => t.threadRootId === 32);
    expect(mine.following).toBe(true);
  });
});

describe('unknown resolves to expand, never to collapse', () => {
  // The merged ruling (threading-surface-ruling.md) went further than my two
  // earlier attempts, and both were wrong in the same direction — toward
  // collapsing. Collapsed hides history and the user cannot tell; expanded is
  // noisy and one click fixes it.
  //
  // Read through the RENDER now rather than through a `defaults` field, per
  // @ux-lead 56996. That is a strictly better test of the same rule: it
  // exercises migration_records -> readThreadingCutoff -> resolved boolean,
  // where the old one stopped at the intermediate value and trusted the client
  // to finish the job correctly.

  const collapsedValues = async () => (await read()).threads.map((t) => t.collapsed);

  beforeEach(async () => { await mockPool.query('DELETE FROM migration_records'); });

  test('no ledger row => expand everything, whatever the history looks like', async () => {
    // Previously this collapsed everything when no un-rooted edges existed.
    // On an already-backfilled instance whose row was lost, that hides all
    // history — which is the case #1115 exists to prevent.
    await mockPool.query('UPDATE messages SET reply_to_message_id = NULL');
    const vals = await collapsedValues();
    expect(vals.length).toBeGreaterThan(0);
    expect(vals.every((c) => c === false)).toBe(true);
  });

  test('and still expanded when un-rooted history exists', async () => {
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    expect((await collapsedValues()).every((c) => c === false)).toBe(true);
  });

  test('a row with a NULL cutoff is KNOWLEDGE, not absence — so collapse', async () => {
    // The backfill ran and rooted nothing. A migrated instance with no
    // pre-threading history: collapse is correct, and it is the one case where
    // a null cutoff does not mean unknown.
    await mockPool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":null}'::jsonb)`,
    );
    expect((await collapsedValues()).every((c) => c === true)).toBe(true);
  });

  test('a row with a cutoff governs, and un-rooted orphans do not override it', async () => {
    // Orphans stay un-rooted forever by design. The retired probe counted
    // them, so one dead row would have pinned the instance to expand
    // permanently. Fixture roots are created now, so a past cutoff collapses
    // them all — and the point is that it decides at all.
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    await mockPool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":"2020-01-01T00:00:00Z"}'::jsonb)`,
    );
    expect((await collapsedValues()).every((c) => c === true)).toBe(true);
  });
});

// REMOVED: the skipped `threadingBackfillPending` block.
//
// It was kept "for one release" so a reader could see that the un-rooted-count
// discriminator had been considered and rejected. Two contract changes later
// it asserts on `defaults.expandedForRootsCreatedBefore` and a
// `threadingBackfillPending` field, neither of which exists — so it no longer
// documents a rejected alternative to the CURRENT design, it documents a
// rejected alternative to a design that is itself gone. A skipped test that
// cannot run against the code is not a record, it is a fossil, and the next
// reader has to reconstruct two migrations to find that out.
//
// The reasoning it carried survives where it is still true: in
// docs/design/threading-surface-ruling.md, and in the three-state cutoff
// comments on readThreadingCutoff and effectiveStateForPod.

describe('a read failure degrades toward EXPAND, never toward collapse', () => {
  // CONVERTED from a source regex. @sprint-review (57150) on that block: every
  // test in it was `expect(CONTROLLER_SRC).toMatch(...)`, reading the
  // controller's text rather than running it — and their clearest proof was
  // that one went red on the catch block's FORMATTING while the behaviour was
  // intact. The old assertion here matched the literal shape of the catch, so
  // a reformat broke it and a behavioural regression could slip past.
  //
  // Nothing executed a read failure anywhere, so this was the one property in
  // that block with no behavioural coverage at all — and it is the safety
  // direction: collapsed hides history invisibly, expanded is noisy and one
  // click from fixed.
  const readWith = async (queryImpl) => {
    const original = mockPool.query.bind(mockPool);
    mockPool.query = queryImpl(original);
    try {
      return await read();
    } finally {
      mockPool.query = original;
    }
  };
  const failLedger = (orig) => (sql, params) => (
    String(sql).includes('migration_records')
      ? Promise.reject(new Error('connection reset'))
      : orig(sql, params)
  );

  beforeEach(async () => {
    await mockPool.query('DELETE FROM migration_records');
    await seedPastCutoff();
  });

  test('the ledger query throwing renders every root EXPANDED', async () => {
    const p = await readWith(failLedger);

    expect(p.threads.length).toBeGreaterThan(0);
    expect(p.threads.every((t) => t.collapsed === false)).toBe(true);
  });

  test('CONTROL: the same ledger row without a failure collapses them', async () => {
    // Without this, the test above passes from any state that happens to
    // expand — including a read so broken it returns nothing meaningful.
    const p = await read();

    expect(p.threads.length).toBeGreaterThan(0);
    expect(p.threads.every((t) => t.collapsed === true)).toBe(true);
  });

  test('the failure does not surface as an error to the caller', async () => {
    const p = await readWith(failLedger);
    expect(p.podId).toBe(POD);
  });
});
