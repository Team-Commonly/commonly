/**
 * `collapsed` is resolved in the payload, not by the client — @ux-lead's
 * ruling (56996), EXECUTED against pg-mem rather than asserted about source.
 *
 * The rule being pinned: every root in the pod appears, and each carries a
 * concrete boolean. The client never sees absence and is never told the
 * threading cutoff. Three cutoff states, and the order of the CASE arms is
 * the #1115 ruling — unknown expands, and it outranks everything.
 *
 * MUTATION PROBE, derived expectation vs actual, per @sprint-review (56999):
 * a kill count only means something against a number you committed to first.
 *
 *   mutation                              expected  actual
 *   CASE arms swapped                        3        1
 *   COALESCE dropped (default always wins)   4        4
 *   join loses `AND s.user_id = $1`          1+       1
 *   `>=` inverted to `<`                     1        2
 *
 * Two mismatches, and both are worth more than the eight that matched.
 *
 * FEWER (3 -> 1): my expectation was wrong, not the suite. Swapping the arms
 * only changes an answer when the cutoff IS NULL — with a cutoff present, the
 * `cutoffUnknown` arm is reached either way. So "cutoffUnknown: EXPAND
 * EVERYTHING" cannot discriminate arm order at all, and the single test that
 * does is "outranks a cutoff being present", which compares the null and
 * non-null cases against each other. Deriving the number first is what
 * surfaced that; a bare "1 failed" would have read as a thin suite.
 *
 * MORE (1 -> 2): the second kill is "another user's row does not leak into
 * mine", whose control half asserts MY default for a post-cutoff root. That
 * assertion legitimately spans two behaviours, so a default-flipping mutation
 * reaches it. Not a shared-property flaw in the fixtures — the wider mutation
 * simply touches more than the one test named for it.
 */

const { newDb } = require('pg-mem');
const { applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const ThreadUserState = require('../../../models/pg/ThreadUserState');

const POD = 'pod-1';
const OTHER = 'pod-2';
const USER = 'user-1';
const PEER = 'user-2';

// Two roots either side of a cutoff, each with a reply so they are real roots.
const OLD_ROOT = '2026-08-01T00:00:00Z';
const NEW_ROOT = '2026-08-20T00:00:00Z';
const CUTOFF = '2026-08-10T00:00:00Z';

let oldRootId; let newRootId; let lonelyId;

beforeAll(async () => {
  await applyTable(mockPool, 'pods');
  await applyTable(mockPool, 'users');
  await applyTable(mockPool, 'messages');
  await applyTable(mockPool, 'thread_user_state');
  for (const p of [POD, OTHER]) {
    // eslint-disable-next-line no-await-in-loop
    await mockPool.query(
      `INSERT INTO pods (id, name, type, created_by) VALUES ('${p}', 'P', 'chat', '${USER}')`,
    );
  }
  await mockPool.query(`INSERT INTO users (_id, username) VALUES ('${USER}', 'a'), ('${PEER}', 'b')`);

  const mk = async (pod, created, root = null) => {
    const { rows } = await mockPool.query(
      `INSERT INTO messages (pod_id, user_id, content, message_type, thread_root_id, created_at)
       VALUES ($1, $2, 'x', 'text', $3::int, $4::timestamptz) RETURNING id`,
      [pod, USER, root, created],
    );
    return Number(rows[0].id);
  };

  oldRootId = await mk(POD, OLD_ROOT);
  await mk(POD, OLD_ROOT, oldRootId);          // reply -> oldRoot is a root
  newRootId = await mk(POD, NEW_ROOT);
  await mk(POD, NEW_ROOT, newRootId);          // reply -> newRoot is a root
  lonelyId = await mk(POD, NEW_ROOT);          // no replies -> NOT a root
  const otherRoot = await mk(OTHER, NEW_ROOT);
  await mk(OTHER, NEW_ROOT, otherRoot);        // a root in a DIFFERENT pod
});

afterEach(async () => {
  await mockPool.query('DELETE FROM thread_user_state');
});

const call = (cutoff, unknown, user = USER) => ThreadUserState
  .effectiveStateForPod(user, POD, cutoff, unknown);

describe('every root in the pod comes back with a concrete boolean', () => {
  test('both roots appear even though the user has touched neither', async () => {
    const rows = await call(CUTOFF, false);
    expect(rows.map((r) => r.thread_root_id).sort((a, b) => a - b)).toEqual([oldRootId, newRootId]);
    for (const r of rows) expect(typeof r.collapsed).toBe('boolean');
  });

  test('a message nobody replied to is not a root and is not returned', async () => {
    // Otherwise every message in the pod would arrive as a collapsed thread.
    const rows = await call(CUTOFF, false);
    expect(rows.map((r) => r.thread_root_id)).not.toContain(lonelyId);
  });

  test('roots in other pods are not returned', async () => {
    const rows = await call(CUTOFF, false);
    expect(rows).toHaveLength(2);
  });
});

describe('the three cutoff states, resolved server-side', () => {
  test('cutoff set: pre-cutoff root expands, post-cutoff root collapses', async () => {
    const rows = await call(CUTOFF, false);
    const by = Object.fromEntries(rows.map((r) => [r.thread_root_id, r.collapsed]));
    expect(by[oldRootId]).toBe(false);
    expect(by[newRootId]).toBe(true);
  });

  test('cutoff null and KNOWN: nothing pre-dates threading, so all collapse', async () => {
    const rows = await call(null, false);
    expect(rows.map((r) => r.collapsed)).toEqual([true, true]);
  });

  test('cutoffUnknown: EXPAND EVERYTHING, including the post-cutoff root', async () => {
    // #1115's load-bearing case. Never collapse on an unknown — a wrong
    // collapse hides history that was visible yesterday.
    const rows = await call(CUTOFF, true);
    expect(rows.map((r) => r.collapsed)).toEqual([false, false]);
  });

  test('cutoffUnknown outranks a cutoff being present at all', async () => {
    const withCutoff = await call(CUTOFF, true);
    const without = await call(null, true);
    expect(withCutoff.map((r) => r.collapsed)).toEqual(without.map((r) => r.collapsed));
  });
});

describe('an explicit row outranks the default, in both directions', () => {
  test('explicitly collapsing a PRE-cutoff root sticks', async () => {
    await ThreadUserState.setCollapsed(oldRootId, USER, POD, true);
    const rows = await call(CUTOFF, false);
    expect(rows.find((r) => r.thread_root_id === oldRootId).collapsed).toBe(true);
  });

  test('explicitly expanding a POST-cutoff root sticks', async () => {
    await ThreadUserState.setCollapsed(newRootId, USER, POD, false);
    const rows = await call(CUTOFF, false);
    expect(rows.find((r) => r.thread_root_id === newRootId).collapsed).toBe(false);
  });

  test('an explicit row survives cutoffUnknown, which otherwise expands all', async () => {
    await ThreadUserState.setCollapsed(oldRootId, USER, POD, true);
    const rows = await call(CUTOFF, true);
    expect(rows.find((r) => r.thread_root_id === oldRootId).collapsed).toBe(true);
    expect(rows.find((r) => r.thread_root_id === newRootId).collapsed).toBe(false);
  });

  test("another user's row does not leak into mine", async () => {
    await ThreadUserState.setCollapsed(newRootId, PEER, POD, false);
    const mine = await call(CUTOFF, false);
    expect(mine.find((r) => r.thread_root_id === newRootId).collapsed).toBe(true);
    const theirs = await call(CUTOFF, false, PEER);
    expect(theirs.find((r) => r.thread_root_id === newRootId).collapsed).toBe(false);
  });
});

describe('following is NOT collapsed to a boolean', () => {
  test('absence stays null, because null means defer-to-participation', async () => {
    const rows = await call(CUTOFF, false);
    for (const r of rows) expect(r.following).toBeNull();
  });

  test('an explicit mute comes back as false, not as absence', async () => {
    await ThreadUserState.unfollow(newRootId, USER, POD);
    const rows = await call(CUTOFF, false);
    expect(rows.find((r) => r.thread_root_id === newRootId).following).toBe(false);
  });
});
