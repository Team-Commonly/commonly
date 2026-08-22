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

const { createTableFor } = require('../../utils/schemaTable');
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
  await mockPool.query(createTableFor('pods'));
  await mockPool.query(createTableFor('messages'));
  await mockPool.query(createTableFor('thread_user_state'));
  await mockPool.query(createTableFor('migration_records'));
});
// Roots must be real message rows — thread_user_state has a live FK to
// messages in the shipped schema, which the old hand-written fixture omitted.
const seedRoot = async (id) => mockPool.query(
  'INSERT INTO messages (id, pod_id, user_id, content) VALUES ($1,$2,$3,$4)',
  [id, POD, 'author', 'root'],
);

beforeAll(async () => {
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'p','chat','u')", [POD]);
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'p2','chat','u')", [OTHER_POD]);
  for (const id of [10, 11, 20, 21, 22, 30, 31, 32, 40, 41]) await seedRoot(id);
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
    expect(payload.threads.map((t) => t.threadRootId)).toEqual([40]);
  });

  test('req.user._id wins over req.userId, as the real chain orders them', async () => {
    await ThreadUserState.follow(41, 'preferred-id', POD);
    let payload;
    const res = { status: () => res, json: (d) => { payload = d; } };
    await listThreadState(
      { user: { _id: 'preferred-id' }, userId: 'ignored-id', query: { podId: POD }, params: {} }, res,
    );
    expect(payload.threads.map((t) => t.threadRootId)).toEqual([41]);
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

describe('unknown resolves to expand, never to collapse', () => {
  // The merged ruling (threading-surface-ruling.md) went further than my two
  // earlier attempts, and both were wrong in the same direction — toward
  // collapsing. Collapsed hides history and the user cannot tell; expanded is
  // noisy and one click fixes it.

  const readDefaults = async () => (await read()).defaults;
  beforeEach(async () => { await mockPool.query('DELETE FROM migration_records'); });

  test('no ledger row => cutoffUnknown, whatever the history looks like', async () => {
    // Previously this returned pending:false when no un-rooted edges existed,
    // which told the client to collapse everything. On an already-backfilled
    // instance whose row was lost, that hides all history.
    await mockPool.query('UPDATE messages SET reply_to_message_id = NULL');
    const d = await readDefaults();
    expect(d.cutoffUnknown).toBe(true);
    expect(d.expandedForRootsCreatedBefore).toBeNull();
  });

  test('and still unknown when un-rooted history exists', async () => {
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    expect((await readDefaults()).cutoffUnknown).toBe(true);
  });

  test('a row with a NULL cutoff is KNOWLEDGE, not absence', async () => {
    // The backfill ran and rooted nothing. That is a migrated instance with no
    // pre-threading history — collapse is correct here, and it is the one case
    // where a null cutoff does not mean unknown.
    await mockPool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":null}'::jsonb)`,
    );
    const d = await readDefaults();
    expect(d.cutoffUnknown).toBe(false);
    expect(d.expandedForRootsCreatedBefore).toBeNull();
  });

  test('a row with a cutoff governs, and un-rooted orphans do not override it', async () => {
    // Orphans stay un-rooted forever by design. The retired probe counted them,
    // so one dead row would have pinned the instance to expand permanently.
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    await mockPool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":"2026-08-22T12:21:11Z"}'::jsonb)`,
    );
    const d = await readDefaults();
    expect(d.expandedForRootsCreatedBefore).toBe('2026-08-22T12:21:11Z');
    expect(d.cutoffUnknown).toBe(false);
  });
});

describe.skip('SUPERSEDED by the merged ruling — the pending-probe shape', () => {
  // Left skipped rather than deleted for one release: these encode the
  // behaviour the ruling replaced (un-rooted count as the discriminator), and
  // a reader who finds only the new tests cannot tell that the old shape was
  // considered and rejected.

  // @sprint-review 56862 asked whether the pre-cutoff comparison resolves
  // server-side. It does — via one timestamp. Following that through against
  // the live instance exposed an ambiguity in my own answer: a missing ledger
  // row meant BOTH "fresh instance, no history" and "backfill has not run",
  // and those need opposite renders. Collapsing everything is right for the
  // first and buries existing conversation for the second, which is exactly
  // what #1115's carve-out prevents.

  const readDefaults = async () => (await read()).defaults;

  beforeEach(async () => { await mockPool.query('DELETE FROM migration_records'); });

  test('no ledger row and NO un-rooted history: not pending, collapse all', async () => {
    // Fresh instance. Nothing is pre-cutoff, so collapsing everything is right.
    await mockPool.query('UPDATE messages SET reply_to_message_id = NULL');
    const d = await readDefaults();
    expect(d.expandedForRootsCreatedBefore).toBeNull();
    expect(d.threadingBackfillPending).toBe(false);
  });

  test('no ledger row WITH un-rooted history: pending, do not collapse history', async () => {
    // Today's live state: 245 reply edges, empty ledger. The dangerous case.
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    const d = await readDefaults();
    expect(d.expandedForRootsCreatedBefore).toBeNull();
    expect(d.threadingBackfillPending).toBe(true);
  });

  test('once the ledger row exists, pending is false and the cutoff is served', async () => {
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    await mockPool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":"2026-08-22T12:21:11Z"}'::jsonb)`,
    );
    const d = await readDefaults();
    expect(d.expandedForRootsCreatedBefore).toBe('2026-08-22T12:21:11Z');
    expect(d.threadingBackfillPending).toBe(false);
  });

  test('the cutoff wins even if un-rooted rows remain — a partial run is not pending', async () => {
    // Orphans legitimately stay NULL forever, so their presence must not make
    // the ledger look unwritten. The row is the authority once it exists.
    await mockPool.query('UPDATE messages SET reply_to_message_id = 10 WHERE id = 11');
    await mockPool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ('threading-thread-root-id-backfill', '{"threadingCutoff":"2026-08-22T12:21:11Z"}'::jsonb)`,
    );
    expect((await readDefaults()).threadingBackfillPending).toBe(false);
  });
});
