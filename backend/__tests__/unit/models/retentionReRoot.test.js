/**
 * Deleting a thread root must not orphan the chain below it (TASK-043).
 *
 * @sprint-review (57204). `thread_root_id` is ON DELETE SET NULL, which is
 * correct for the row pointed at and wrong for everything under it:
 *
 *     R <- C <- G,  delete R
 *       C : reply_to -> NULL, thread_root_id -> NULL   correct, C is now a root
 *       G : reply_to = C (ALIVE), thread_root_id -> NULL   WRONG
 *
 * G is NOT a dangling edge — its parent is alive — so the `reply_to_message_id`
 * FK cannot help, and no write path revisits it. It matches the un-rooted
 * predicate permanently. That distinction is why the "zero dangling edges"
 * measurement on the live instance did not close this.
 *
 * WHAT THIS SUITE CAN AND CANNOT PROVE — read before adding to it.
 *
 * pg-mem does NOT fire ON DELETE SET NULL. Measured, minimally:
 *
 *     CREATE TABLE m (id INTEGER PRIMARY KEY,
 *                     reply_to INTEGER REFERENCES m(id) ON DELETE SET NULL,
 *                     root     INTEGER REFERENCES m(id) ON DELETE SET NULL);
 *     INSERT (1,NULL,NULL),(2,1,1),(3,2,1);  DELETE FROM m WHERE id = 1;
 *     -> rows 2 and 3 still hold reply_to/root = 1, pointing at a deleted row.
 *
 * So this tier cannot show that deleting a root orphans its chain. @sprint-review
 * wrote (57286) that "threadFollowByParticipation.test.js:252 already does
 * DELETE FROM messages under pg-mem, so FK actions are exercised at the unit
 * tier" — a DELETE running is not the same as its FK action firing, and the
 * action does not fire. My own first draft of this file had a test asserting
 * the orphaning and it passed; it was not evidence, and it is gone.
 *
 * The split that is honest:
 *   HERE      — the REPAIR, given the orphaned state, constructed explicitly
 *               and labelled as constructed. That is a claim about my code.
 *   TIER 1    — that Postgres actually PRODUCES that state on delete, and that
 *               deleteOlderThan repairs it end to end. That is a claim about
 *               the database, and only a database can settle it.
 *               (__tests__/service/threading.retention.test.js)
 */
const { newDb } = require('pg-mem');
const { applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const mockPool = new (mockDb.adapters.createPg().Pool)();
jest.mock('../../../config/db-pg', () => ({ pool: mockPool }));

const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-1';
let id = 0;
const mk = async (root, replyTo, ageDays = 0) => {
  id += 1;
  await mockPool.query(
    `INSERT INTO messages (id, pod_id, user_id, content, reply_to_message_id, thread_root_id, created_at)
     VALUES ($1,$2,'u','x',$3::int,$4::int, NOW() - ($5 || ' days')::interval)`,
    [id, POD, replyTo, root, ageDays],
  );
  return id;
};
const rootOf = async (mid) => {
  const { rows } = await mockPool.query('SELECT thread_root_id FROM messages WHERE id = $1', [mid]);
  return rows[0] ? rows[0].thread_root_id : undefined;
};

beforeAll(async () => {
  await applyTable(mockPool, 'pods');
  await applyTable(mockPool, 'users');
  await applyTable(mockPool, 'messages');
  await mockPool.query("INSERT INTO pods (id, name, type, created_by) VALUES ($1,'P','chat','u')", [POD]);
});
beforeEach(async () => { await mockPool.query('DELETE FROM messages'); });

// The post-delete state, CONSTRUCTED. This is what Postgres leaves behind
// after `DELETE FROM messages WHERE id = R` on R <- C <- G: C promoted to a
// root (both pointers null), G keeping a live parent and losing its root.
// Written out by hand because pg-mem will not produce it — and said out loud
// because a hand-built fixture is a statement about what I believe Postgres
// does, which tier 1 has to confirm.
const orphanedChain = async (depth) => {
  const C = await mk(null, null);          // promoted root
  const ids = [];
  let parent = C;
  for (let i = 0; i < depth; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    parent = await mk(null, parent);       // live parent, NULL root
    ids.push(parent);
  }
  return { C, ids };
};

describe('reRootOrphanedChains repairs it', () => {
  test('the grandchild re-points at the promoted root', async () => {
    const { C, ids: [G] } = await orphanedChain(1);

    const out = await PGMessage.reRootOrphanedChains();

    expect(await rootOf(G)).toBe(C);
    expect(out.reRooted).toBe(1);
  });

  test('a deeper chain converges, one level per pass', async () => {
    const { C, ids } = await orphanedChain(3);

    const out = await PGMessage.reRootOrphanedChains();

    for (const m of ids) expect(await rootOf(m)).toBe(C);
    expect(out.reRooted).toBe(3);
    // One level per pass, plus the final no-op pass that proves convergence.
    expect(out.passes).toBe(4);
  });

  test('the promoted root keeps a NULL root — that is what a root looks like', async () => {
    const { C } = await orphanedChain(1);

    await PGMessage.reRootOrphanedChains();

    expect(await rootOf(C)).toBeNull();
  });

  test('it is idempotent — a second run changes nothing', async () => {
    await orphanedChain(1);
    await PGMessage.reRootOrphanedChains();

    const second = await PGMessage.reRootOrphanedChains();

    expect(second.reRooted).toBe(0);
    expect(second.passes).toBe(1);
  });

  test('an intact thread is untouched', async () => {
    // CONTROL. Without this, a repair that nulled or rewrote healthy rows
    // would still pass every test above.
    const R = await mk(null, null);
    const C = await mk(R, R);
    const G = await mk(R, C);

    const out = await PGMessage.reRootOrphanedChains();

    expect(out.reRooted).toBe(0);
    expect(await rootOf(C)).toBe(R);
    expect(await rootOf(G)).toBe(R);
  });

  test('a genuinely parentless orphan stays NULL rather than being invented a root', async () => {
    // reply_to IS NULL means it IS a root now. Nothing to re-root, and
    // inventing one would be worse than leaving it.
    const lone = await mk(null, null);

    await PGMessage.reRootOrphanedChains();

    expect(await rootOf(lone)).toBeNull();
  });
});

// deleteOlderThan's end-to-end repair is NOT tested here. It needs the delete
// to actually orphan something, which needs the FK action, which pg-mem does
// not fire. It lives in the tier-1 suite where a real Postgres can produce the
// state — putting it here would be a test of my fixture wearing the name of a
// test of retention.
