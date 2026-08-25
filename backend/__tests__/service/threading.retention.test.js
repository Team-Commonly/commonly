/**
 * Retention deleting a thread root — EXECUTED against a real Postgres
 * (TASK-043, @sprint-review 57204).
 *
 * TIER 1 IS NOT A PREFERENCE HERE, IT IS THE ONLY OPTION. The claim is about
 * what the DATABASE does on delete: `thread_root_id` is ON DELETE SET NULL,
 * so removing a root nulls the pointer on every descendant while their
 * `reply_to_message_id` chain stays intact and alive.
 *
 * pg-mem does not fire ON DELETE SET NULL at all — measured minimally, three
 * rows and one delete, and the children keep pointing at the deleted id. So
 * the unit suite (retentionReRoot.test.js) can only prove the REPAIR against
 * a state it constructs by hand. Whether Postgres produces that state, and
 * whether deleteOlderThan repairs it end to end, is this file's job.
 *
 * That split is worth stating because it was got wrong first: a peer wrote
 * that FK actions are exercised at the unit tier because a suite there runs a
 * DELETE. A DELETE running is not its FK action firing.
 */
const { Pool } = require('pg');
const PGMessage = require('../../models/pg/Message');

const RUN = process.env.INTEGRATION_TEST === 'true';
const d = RUN ? describe : describe.skip;

const POD = 'aaaaaaaaaaaaaaaaaaaaaa43';
const USER = 'bbbbbbbbbbbbbbbbbbbbbb43';
let pool;

const connect = () => new Pool({
  host: process.env.PG_HOST,
  port: Number(process.env.PG_PORT || 5432),
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
  ssl: false,
});

const rootOf = async (id) => {
  const { rows } = await pool.query('SELECT thread_root_id FROM messages WHERE id = $1', [id]);
  return rows[0] ? rows[0].thread_root_id : undefined;
};
const replyOf = async (id) => {
  const { rows } = await pool.query('SELECT reply_to_message_id FROM messages WHERE id = $1', [id]);
  return rows[0] ? rows[0].reply_to_message_id : undefined;
};

d('deleting a thread root, against a real database', () => {
  beforeAll(async () => {
    pool = connect();
    await pool.query("INSERT INTO users (_id, username) VALUES ($1,'t43') ON CONFLICT (_id) DO NOTHING", [USER]);
    await pool.query(
      "INSERT INTO pods (id, name, type, created_by) VALUES ($1,'retention','chat',$2) ON CONFLICT (id) DO NOTHING",
      [POD, USER],
    );
  });
  afterAll(async () => { await pool.query('DELETE FROM messages WHERE pod_id = $1', [POD]); await pool.end(); });
  beforeEach(async () => { await pool.query('DELETE FROM messages WHERE pod_id = $1', [POD]); });

  const chain = async () => {
    const R = await PGMessage.create(POD, USER, 'root', 'text', null);
    const C = await PGMessage.create(POD, USER, 'child', 'text', R.id);
    const G = await PGMessage.create(POD, USER, 'grand', 'text', C.id);
    return { R: Number(R.id), C: Number(C.id), G: Number(G.id) };
  };

  test('THE BUG: the grandchild loses its root while keeping a live parent', async () => {
    const { R, C, G } = await chain();
    expect(await rootOf(G)).toBe(R);

    await pool.query('DELETE FROM messages WHERE id = $1', [R]);

    // Not a dangling edge — that is the distinction the whole task turns on,
    // and why "zero dangling edges on the live instance" did not close it.
    expect(await replyOf(G)).toBe(C);
    expect(await rootOf(G)).toBeNull();
    // C is promoted: both pointers null, which is exactly what a root is.
    expect(await replyOf(C)).toBeNull();
    expect(await rootOf(C)).toBeNull();
  });

  test('reRootOrphanedChains re-points the chain at the promoted root', async () => {
    const { R, C, G } = await chain();
    await pool.query('DELETE FROM messages WHERE id = $1', [R]);

    await PGMessage.reRootOrphanedChains();

    expect(await rootOf(G)).toBe(C);
    expect(await rootOf(C)).toBeNull();
  });

  test('deleteOlderThan repairs what it orphans, in one call', async () => {
    // The end-to-end shape: retention removes an aged root and the descendants
    // that survive are re-rooted before the caller sees a return value. The
    // caller cannot detect the corruption itself — the delete reports rows
    // removed, not rows broken — so the repair has to be inside the operation.
    const { R, C, G } = await chain();
    await pool.query("UPDATE messages SET created_at = NOW() - INTERVAL '400 days' WHERE id = $1", [R]);

    const { deleted, reRooted } = await PGMessage.deleteOlderThan(30);

    expect(deleted).toBeGreaterThanOrEqual(1);
    expect(reRooted).toBe(1);
    expect(await rootOf(G)).toBe(C);
  });

  test('CONTROL: an intact thread survives a delete that removes nothing', async () => {
    // Without this, a repair that rewrote healthy rows would pass the rest.
    const { R, C, G } = await chain();

    await PGMessage.deleteOlderThan(3650);

    expect(await rootOf(C)).toBe(R);
    expect(await rootOf(G)).toBe(R);
  });
});
