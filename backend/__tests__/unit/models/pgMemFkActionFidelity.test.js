/**
 * What pg-mem does and does not do with foreign-key actions.
 *
 * This suite asserts the behaviour of a DEPENDENCY, not of our code. It exists
 * because that behaviour is load-bearing for every constraint test at Tier 0,
 * and because a doc claim about a third-party library decays silently on the
 * next upgrade. If pg-mem is bumped and starts honouring self-referential FK
 * actions, these tests fail — which is the signal to delete them and the
 * `backend/TESTING.md` rule they back, not to relax the assertion.
 *
 * The axis is SELF-REFERENCE, not the action. Measured on pg-mem 2.9.1:
 *
 *   cross-table  ON DELETE CASCADE   fires      (matches Postgres)
 *   cross-table  ON DELETE SET NULL  fires      (matches Postgres)
 *   self-ref     ON DELETE CASCADE   IGNORED    (diverges)
 *   self-ref     ON DELETE SET NULL  IGNORED    (diverges)
 *
 * That distinction matters because `messages` has both shapes. `pod_id` and
 * `thread_user_state.thread_root_id` are cross-table and genuinely covered at
 * Tier 0. `reply_to_message_id` and `messages.thread_root_id` point back at
 * `messages(id)`, so a Tier 0 test that deletes a message and asserts what
 * happened to its descendants is asserting nothing.
 *
 * The DDL is accepted without complaint in every case, which is what makes
 * this dangerous: declared, parsed, silently not applied.
 */

const { newDb } = require('pg-mem');

// pg-mem attaches a Symbol(_id) to every row it returns, and `toEqual`
// compares symbol properties. Round-tripping through JSON drops it so the
// assertions read as plain column values — which is also how the first draft
// of this file passed as a standalone script and failed under jest.
const rows = (db, sql) => JSON.parse(JSON.stringify(db.public.many(sql)));

const fresh = (ddl, seed) => {
  const db = newDb();
  db.public.none(ddl);
  db.public.none(seed);
  return db;
};

describe('pg-mem honours cross-table FK actions', () => {
  it('fires ON DELETE CASCADE', () => {
    const db = fresh(
      `CREATE TABLE p(id INT PRIMARY KEY);
       CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id) ON DELETE CASCADE);`,
      `INSERT INTO p VALUES (1); INSERT INTO c VALUES (10, 1);`,
    );
    db.public.none('DELETE FROM p WHERE id = 1;');
    expect(rows(db, 'SELECT * FROM c')).toHaveLength(0);
  });

  it('fires ON DELETE SET NULL', () => {
    const db = fresh(
      `CREATE TABLE p(id INT PRIMARY KEY);
       CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id) ON DELETE SET NULL);`,
      `INSERT INTO p VALUES (1); INSERT INTO c VALUES (10, 1);`,
    );
    db.public.none('DELETE FROM p WHERE id = 1;');
    expect(rows(db, 'SELECT * FROM c')).toEqual([{ id: 10, pid: null }]);
  });
});

describe('pg-mem IGNORES self-referential FK actions', () => {
  // Both cases below are wrong against Postgres. They are asserted as-is so
  // the divergence is pinned rather than described.
  it('does not fire a self-referential ON DELETE SET NULL', () => {
    const db = fresh(
      `CREATE TABLE m(id INT PRIMARY KEY,
                      p INT REFERENCES m(id) ON DELETE SET NULL);`,
      `INSERT INTO m VALUES (1, NULL), (2, 1);`,
    );
    db.public.none('DELETE FROM m WHERE id = 1;');
    // Postgres would give p = null here.
    expect(rows(db, 'SELECT * FROM m')).toEqual([{ id: 2, p: 1 }]);
  });

  it('does not fire a self-referential ON DELETE CASCADE', () => {
    const db = fresh(
      `CREATE TABLE m(id INT PRIMARY KEY,
                      p INT REFERENCES m(id) ON DELETE CASCADE);`,
      `INSERT INTO m VALUES (1, NULL), (2, 1);`,
    );
    db.public.none('DELETE FROM m WHERE id = 1;');
    // Postgres would delete row 2 with its parent.
    expect(rows(db, 'SELECT * FROM m')).toEqual([{ id: 2, p: 1 }]);
  });

  it('leaves the whole chain pointing at a deleted row', () => {
    // The `messages` shape exactly: two self-referential SET NULL columns.
    const db = fresh(
      `CREATE TABLE m(id INT PRIMARY KEY,
                      reply_to INT REFERENCES m(id) ON DELETE SET NULL,
                      root     INT REFERENCES m(id) ON DELETE SET NULL);`,
      `INSERT INTO m VALUES (1, NULL, NULL), (2, 1, 1), (3, 2, 1);`,
    );
    db.public.none('DELETE FROM m WHERE id = 1;');
    expect(rows(db, 'SELECT * FROM m ORDER BY id')).toEqual([
      { id: 2, reply_to: 1, root: 1 },
      { id: 3, reply_to: 2, root: 1 },
    ]);
  });
});

describe('what pg-mem DOES enforce, so the rule is not read too broadly', () => {
  it('rejects an insert that violates the constraint', () => {
    const db = fresh(
      `CREATE TABLE p(id INT PRIMARY KEY);
       CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id));`,
      'SELECT 1;',
    );
    expect(() => db.public.none('INSERT INTO c VALUES (1, 99);')).toThrow();
  });

  it('rejects a delete that would orphan under the default NO ACTION', () => {
    const db = fresh(
      `CREATE TABLE p(id INT PRIMARY KEY);
       CREATE TABLE c(id INT PRIMARY KEY, pid INT REFERENCES p(id));`,
      `INSERT INTO p VALUES (1); INSERT INTO c VALUES (10, 1);`,
    );
    expect(() => db.public.none('DELETE FROM p WHERE id = 1;')).toThrow();
  });

  it('gets ON DELETE SET DEFAULT wrong in a quieter way — null, not the default', () => {
    const db = fresh(
      `CREATE TABLE p(id INT PRIMARY KEY);
       CREATE TABLE c(id INT PRIMARY KEY, pid INT DEFAULT 0 REFERENCES p(id) ON DELETE SET DEFAULT);`,
      `INSERT INTO p VALUES (1); INSERT INTO c VALUES (10, 1);`,
    );
    db.public.none('DELETE FROM p WHERE id = 1;');
    // Postgres would give pid = 0.
    expect(rows(db, 'SELECT * FROM c')).toEqual([{ id: 10, pid: null }]);
  });
});
