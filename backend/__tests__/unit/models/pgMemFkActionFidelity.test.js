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
 *   cross-table  ON DELETE CASCADE   fires        (matches Postgres)
 *   cross-table  ON DELETE SET NULL  fires        (matches Postgres)
 *   self-ref     ON DELETE CASCADE   INCONSISTENT (diverges)
 *   self-ref     ON DELETE SET NULL  INCONSISTENT (diverges)
 *
 * "Inconsistent" and not "ignored": the action IS performed, against the
 * PRIMARY KEY INDEX and not against the row storage. One table, one
 * transaction, two answers for the same row — a plan served by the PK index
 * reports the action as applied, a plan that scans reports the pre-delete
 * value. The `plan-dependent` describe below pins both readings side by side.
 *
 * The variable is isolated by `WHERE id + 0 = 10` vs `WHERE id = 10`: same
 * predicate, same rows, index made ineligible, opposite answers. That control
 * is @sprint-review's, and it is what rules out the projection or the shape of
 * the WHERE clause as the thing that decides.
 *
 * An earlier draft of this file asserted only the scanning reads and called
 * the action ignored. That is the more comfortable failure and the wrong one:
 * ignoring is at least self-consistent, so a green test is green for one
 * knowable reason. Here the SHAPE OF THE ASSERTION QUERY picks the answer, and
 * both answers look like a real result.
 *
 * That distinction matters because `messages` has both shapes. `pod_id` and
 * `thread_user_state.thread_root_id` are cross-table and genuinely covered at
 * Tier 0. `reply_to_message_id` and `messages.thread_root_id` point back at
 * `messages(id)`, so a Tier 0 test that deletes a message and asserts what
 * happened to its descendants is not asserting nothing — it is asserting
 * whichever answer its own SELECT happened to reach.
 *
 * The DDL is accepted without complaint in every case, which is what makes
 * this dangerous: declared, parsed, applied to half the storage.
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

describe('pg-mem applies self-referential FK actions plan-dependently', () => {
  // Every assertion below is wrong against Postgres in at least one of its two
  // readings. They are asserted as-is so the divergence is pinned rather than
  // described. The pairs are the point: same db, same transaction, same row.
  const selfRef = (action) =>
    fresh(
      `CREATE TABLE m(id INT PRIMARY KEY,
                      p INT REFERENCES m(id) ON DELETE ${action});`,
      `INSERT INTO m VALUES (1, NULL), (2, 1), (3, 2);`,
    );

  it('reports SET NULL as both applied and not applied, depending on the read', () => {
    const db = selfRef('SET NULL');
    db.public.none('DELETE FROM m WHERE id = 1;');

    // Scanning read: the action did NOT happen. Postgres would give p = null.
    expect(rows(db, 'SELECT * FROM m ORDER BY id')).toEqual([
      { id: 2, p: 1 },
      { id: 3, p: 2 },
    ]);
    // PK-index read of the SAME row: the action DID happen.
    expect(rows(db, 'SELECT * FROM m WHERE id = 2')).toEqual([{ id: 2, p: null }]);
  });

  // @sprint-review's correction: an earlier draft of the doc said predicates on
  // the FK column "always read stale". They don't. The FK column is simply the
  // column nobody indexes — index it and the same predicates go fresh. That is
  // the more alarming version of this bug, because it means adding an index is
  // a behaviour change, not just a performance change.
  it('an index on the FK column flips the SAME predicate to fresh', () => {
    const stale = selfRef('SET NULL');
    stale.public.none('DELETE FROM m WHERE id = 1;');
    expect(rows(stale, 'SELECT * FROM m WHERE p = 1')).toEqual([{ id: 2, p: 1 }]);
    expect(rows(stale, 'SELECT * FROM m WHERE p IS NULL')).toEqual([]);

    const indexed = selfRef('SET NULL');
    indexed.public.none('CREATE INDEX m_p_idx ON m(p);');
    indexed.public.none('DELETE FROM m WHERE id = 1;');
    // Same DDL, same seed, same predicate. Only the index differs.
    expect(rows(indexed, 'SELECT * FROM m WHERE p = 1')).toEqual([]);
    expect(rows(indexed, 'SELECT * FROM m WHERE p IS NULL')).toEqual([{ id: 2, p: null }]);
  });

  // @sprint-review's extreme case. Under CASCADE, indexing the FK column moves
  // the LAST remaining predicate across the line: the row is then invisible to
  // every indexed path and present on every scan. pg-mem never touched the
  // heap in either run — only which plans can see the change differs.
  it('CASCADE plus an FK index leaves a row invisible to every indexed path and present to every scan', () => {
    const db = selfRef('CASCADE');
    db.public.none('CREATE INDEX m_p_idx ON m(p);');
    db.public.none('DELETE FROM m WHERE id = 1;');

    // Every indexed path: gone.
    expect(rows(db, 'SELECT * FROM m WHERE id = 2')).toEqual([]);
    expect(rows(db, 'SELECT * FROM m WHERE p = 1')).toEqual([]);
    expect(rows(db, 'SELECT * FROM m WHERE p IS NULL')).toEqual([]);

    // Every scanning path: still there. The count tracks the fixture's chain
    // length rather than being a constant: this three-row chain leaves 2,
    // because row 3 is stranded too; a two-row (1,NULL),(2,1) fixture leaves
    // 1. Quote the number with its fixture or it reads as a disagreement.
    expect(rows(db, 'SELECT * FROM m ORDER BY id')).toEqual([
      { id: 2, p: 1 },
      { id: 3, p: 2 },
    ]);
    expect(rows(db, 'SELECT count(*)::int AS n FROM m')).toEqual([{ n: 2 }]);

    // Without the index, `WHERE p = 1` is the one predicate that still finds
    // it — which is what makes "add an index" a verdict change.
    const noIdx = selfRef('CASCADE');
    noIdx.public.none('DELETE FROM m WHERE id = 1;');
    expect(rows(noIdx, 'SELECT * FROM m WHERE p = 1')).toEqual([{ id: 2, p: 1 }]);
  });

  it('reports CASCADE as both applied and not applied, depending on the read', () => {
    const db = selfRef('CASCADE');
    db.public.none('DELETE FROM m WHERE id = 1;');

    // Scanning read: row 2 survives. Postgres would have deleted it.
    expect(rows(db, 'SELECT * FROM m ORDER BY id')).toEqual([
      { id: 2, p: 1 },
      { id: 3, p: 2 },
    ]);
    // count(*) agrees with the scan, so an aggregate is no safer.
    expect(rows(db, 'SELECT count(*) AS c FROM m')).toEqual([{ c: 2 }]);
    // PK-index read: row 2 is gone.
    expect(rows(db, 'SELECT * FROM m WHERE id = 2')).toEqual([]);
  });

  it('flips on `+ 0` — the same predicate with the index disabled', () => {
    // The control that isolates the variable, from @sprint-review. The pairs
    // above vary the projection AND the predicate together, so they show the
    // answer is plan-dependent without showing WHICH part of the plan decides.
    // `id + 0 = 10` is the identical predicate over the identical rows with
    // the PK index made ineligible, and nothing else changed.
    const db = fresh(
      `CREATE TABLE m(id INT PRIMARY KEY,
                      parent_id INT REFERENCES m(id) ON DELETE SET NULL);`,
      `INSERT INTO m VALUES (1, NULL), (10, 1);`,
    );
    db.public.none('DELETE FROM m WHERE id = 1;');

    expect(rows(db, 'SELECT * FROM m WHERE id = 10')).toEqual([
      { id: 10, parent_id: null }, // index-served: SET NULL happened
    ]);
    expect(rows(db, 'SELECT * FROM m WHERE id + 0 = 10')).toEqual([
      { id: 10, parent_id: 1 }, // scan: it never did
    ]);

    // The line is index-ELIGIBILITY, not equality: range and IN predicates are
    // served by the index too, and agree with it.
    expect(rows(db, 'SELECT * FROM m WHERE id >= 10')).toEqual([{ id: 10, parent_id: null }]);
    expect(rows(db, 'SELECT * FROM m WHERE id IN (10)')).toEqual([{ id: 10, parent_id: null }]);
  });

  it('answers predicates on an UNINDEXED FK column from the stale value', () => {
    // `p` carries no index, so both of these are scans and both read stale —
    // which is why "just assert the other way round" is not the workaround.
    // The name says UNINDEXED deliberately: the test above shows an index on
    // the same column flips both answers, so a name like "predicates on the FK
    // column" would assert more than this case establishes.
    const db = selfRef('SET NULL');
    db.public.none('DELETE FROM m WHERE id = 1;');
    expect(rows(db, 'SELECT * FROM m WHERE p = 1')).toEqual([{ id: 2, p: 1 }]);
    expect(rows(db, 'SELECT * FROM m WHERE p IS NULL')).toEqual([]);
  });

  it('leaves the whole chain pointing at a deleted row, to a scan', () => {
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
    // And to a PK-index read, does not — on both columns at once.
    expect(rows(db, 'SELECT * FROM m WHERE id = 2')).toEqual([
      { id: 2, reply_to: null, root: null },
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
