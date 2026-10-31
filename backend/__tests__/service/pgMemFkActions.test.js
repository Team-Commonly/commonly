/**
 * Pins how pg-mem enforces foreign-key actions, so a Tier 0 test that leans on
 * ON DELETE / ON UPDATE behaviour is leaning on something we have measured.
 *
 * Two halves:
 *   1. The shipped DDL (schema.sql via schemaTable) — the FKs production uses.
 *      These must keep matching PostgreSQL, or Tier 0 tests lie about cascades.
 *   2. Isolated tables for the actions schema.sql does not use. Where pg-mem
 *      diverges from PostgreSQL, the test pins the divergence and says so, so a
 *      pg-mem upgrade that changes it fails here instead of silently.
 *
 * Expected values follow the PostgreSQL docs (ddl-constraints, "Referential
 * Actions"). No real PostgreSQL was available when this was written, so those
 * expectations are not yet confirmed against a live server. Tier 1 (real PG)
 * is the place to confirm them.
 */
const crypto = require('crypto');
const { newDb } = require('pg-mem');
const { applyTable } = require('../utils/schemaTable');

const freshPool = () => {
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    implementation: () => crypto.randomUUID(),
  });
  const { Pool } = db.adapters.createPg();
  return new Pool();
};

// Runs `action` against a parent/child pair built with `childFk`, returns what
// the child's pid became, or 'reject' when pg-mem refuses the statement.
const probe = async ({ childFk, action }) => {
  const pool = freshPool();
  await pool.query('CREATE TABLE p (id int PRIMARY KEY)');
  await pool.query(`CREATE TABLE c (id int PRIMARY KEY, pid int ${childFk})`);
  await pool.query('INSERT INTO p VALUES (1), (2)');
  await pool.query('INSERT INTO c VALUES (10, 1)');
  try {
    await pool.query(action);
    const r = await pool.query('SELECT pid FROM c WHERE id = 10');
    return r.rows[0].pid === null ? 'null' : r.rows[0].pid;
  } catch (e) {
    return 'reject';
  }
};

describe('pg-mem FK actions on the shipped schema.sql DDL', () => {
  let pool;

  beforeEach(async () => {
    pool = freshPool();
    await applyTable(pool, 'pods');
    await applyTable(pool, 'pod_members');
    await applyTable(pool, 'messages');
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ('p1', 'n', 't', 'u')");
  });

  test('ON DELETE CASCADE removes pod_members when the pod is deleted', async () => {
    await pool.query("INSERT INTO pod_members (pod_id, user_id) VALUES ('p1', 'u1')");
    await pool.query("DELETE FROM pods WHERE id = 'p1'");
    const r = await pool.query('SELECT count(*)::int AS n FROM pod_members');
    expect(r.rows[0].n).toBe(0);
  });

  test('ON DELETE SET NULL nulls reply_to_message_id and keeps the reply row', async () => {
    await pool.query("INSERT INTO messages (id, pod_id, user_id, content) VALUES (1, 'p1', 'u', 'a')");
    await pool.query(
      `INSERT INTO messages (id, pod_id, user_id, content, reply_to_message_id)
       VALUES (2, 'p1', 'u', 'b', 1)`,
    );
    await pool.query('DELETE FROM messages WHERE id = 1');
    const r = await pool.query('SELECT reply_to_message_id AS r FROM messages WHERE id = 2');
    expect(r.rows[0].r).toBeNull();
  });

  test('ON DELETE SET NULL on thread_root_id keeps the child row', async () => {
    await pool.query("INSERT INTO messages (id, pod_id, user_id, content) VALUES (1, 'p1', 'u', 'root')");
    await pool.query(
      `INSERT INTO messages (id, pod_id, user_id, content, thread_root_id)
       VALUES (2, 'p1', 'u', 'reply', 1)`,
    );
    await pool.query('DELETE FROM messages WHERE id = 1');
    const r = await pool.query('SELECT thread_root_id AS t FROM messages WHERE id = 2');
    expect(r.rows[0].t).toBeNull();
  });

  test('a child row pointing at a missing parent is rejected on insert', async () => {
    await expect(
      pool.query("INSERT INTO pod_members (pod_id, user_id) VALUES ('nope', 'u')"),
    ).rejects.toThrow(/foreign key/i);
  });
});

describe('pg-mem FK actions outside the shipped DDL', () => {
  test('NO ACTION (the default) rejects a parent delete', async () => {
    const got = await probe({
      childFk: 'REFERENCES p(id)',
      action: 'DELETE FROM p WHERE id = 1',
    });
    expect(got).toBe('reject');
  });

  test('RESTRICT rejects a parent delete', async () => {
    const got = await probe({
      childFk: 'REFERENCES p(id) ON DELETE RESTRICT',
      action: 'DELETE FROM p WHERE id = 1',
    });
    expect(got).toBe('reject');
  });

  test('ON UPDATE SET NULL nulls the child on a parent key change', async () => {
    const got = await probe({
      childFk: 'REFERENCES p(id) ON UPDATE SET NULL',
      action: 'UPDATE p SET id = 3 WHERE id = 1',
    });
    expect(got).toBe('null');
  });

  test('ON UPDATE NO ACTION (the default) rejects a parent key change', async () => {
    const got = await probe({
      childFk: 'REFERENCES p(id)',
      action: 'UPDATE p SET id = 3 WHERE id = 1',
    });
    expect(got).toBe('reject');
  });

  // DIVERGENCE — PostgreSQL cascades the key change to the child (child = 3).
  // pg-mem rejects the update. Pinned so Tier 0 code cannot rely on ON UPDATE CASCADE.
  test('DIVERGENCE: pg-mem rejects ON UPDATE CASCADE (PostgreSQL cascades to 3)', async () => {
    const got = await probe({
      childFk: 'REFERENCES p(id) ON UPDATE CASCADE',
      action: 'UPDATE p SET id = 3 WHERE id = 1',
    });
    expect(got).toBe('reject');
  });

  // DIVERGENCE — PostgreSQL sets the child to its DEFAULT (2, a valid parent).
  // pg-mem sets it to NULL. Pinned so Tier 0 code cannot rely on ON DELETE SET DEFAULT.
  test('DIVERGENCE: pg-mem sets NULL on ON DELETE SET DEFAULT (PostgreSQL sets 2)', async () => {
    const got = await probe({
      childFk: 'DEFAULT 2 REFERENCES p(id) ON DELETE SET DEFAULT',
      action: 'DELETE FROM p WHERE id = 1',
    });
    expect(got).toBe('null');
  });
});
