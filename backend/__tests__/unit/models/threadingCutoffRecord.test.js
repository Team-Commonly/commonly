/**
 * The threading cutoff has somewhere to live, and the backfill records it
 * (W-T, TASK-029, 1/4).
 *
 * #1115 rules that pre-cutoff thread roots render expanded, with the cutoff
 * "read from the migration record". @sprint-review (56859) found there is no
 * such record: no migrations table anywhere under backend/, schema.sql is
 * idempotent boot DDL, and the backfill wrote nothing. The ruling referenced a
 * thing that did not exist.
 *
 * These pin the two decisions that make it exist correctly, both of which are
 * ordering/semantics rather than SQL mechanics.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../../../', p), 'utf8');
const SCHEMA = read('config/schema.sql');
const SCRIPT = read('scripts/backfill-thread-root-id.ts');

describe('the ledger is general, not threading-shaped', () => {
  it('exists at all', () => {
    expect(SCHEMA).toMatch(/CREATE TABLE IF NOT EXISTS migration_records/);
  });

  it('is keyed by migration name with a JSONB details column', () => {
    // details is what lets a migration record something only IT knew. Without
    // it, the threading cutoff needs its own table and the next one needs
    // another.
    expect(SCHEMA).toMatch(/name VARCHAR\(255\) PRIMARY KEY/);
    expect(SCHEMA).toMatch(/details JSONB/);
  });

  it('is not a threading-specific table', () => {
    // The one-off version is the thing that has to be generalised later, and
    // later is when it gets done wrong.
    expect(SCHEMA).not.toMatch(/CREATE TABLE IF NOT EXISTS threading_migration/);
    expect(SCHEMA).not.toMatch(/threading_cutoff\s+TIMESTAMP/);
  });

  it('says in the schema that it is a ledger, not a runner', () => {
    // A reader must never infer "migration X has not run" from a missing row.
    expect(SCHEMA).toMatch(/NOT a migration RUNNER/);
  });
});

describe('the cutoff is measured before it becomes unmeasurable', () => {
  it('is defined as the FIRST reply that carries a root, not the newest un-rooted one', () => {
    // TASK-046: MAX over un-rooted rows is poisoned by retention orphans (a
    // descendant of a deleted root keeps a live parent and loses its root), and
    // a hardcoded deploy instant is wrong on every self-hosted instance. The
    // first rooted reply is exact per instance and orphan-immune.
    expect(SCRIPT).toMatch(/MIN\(created_at\) AS first_rooted[\s\S]{0,120}reply_to_message_id IS NOT NULL AND thread_root_id IS NOT NULL/);
    expect(SCRIPT).not.toMatch(/SELECT MAX\(created_at\) AS cutoff/);
  });

  it('falls back to the newest un-rooted reply ONLY behind --derivation-live', () => {
    // Without a rooted reply there is no evidence derivation is deployed, and
    // DO NOTHING would freeze a growing population's boundary.
    expect(SCRIPT).toMatch(/MAX\(created_at\) AS newest_unrooted/);
    // The dry run shows WHY the fallback fired (sprint-review 57398): the
    // primary's row count, not only the chosen value.
    expect(SCRIPT).toMatch(/count\(\*\)::int AS rooted_replies/);
    expect(SCRIPT).toMatch(/rooted replies \(derivation-written\): \$\{boundary\.rooted_replies\}/);
    expect(SCRIPT).toMatch(/if \(!boundary\.from_rooted && !ASSUME_DERIVATION_LIVE\)/);
    expect(SCRIPT).toMatch(/REFUSING to record a fallback cutoff/);
    expect(SCRIPT).toMatch(/cutoffSource: boundary\.from_rooted \? 'first-rooted-reply' : 'newest-unrooted-fallback'/);
  });

  it('is read BEFORE the UPDATE, because the UPDATE destroys the predicate', () => {
    // The apply-path read is the LAST occurrence (the dry run reads it too);
    // the fallback guard now sits between the read and the UPDATE, which is
    // why this no longer pins the two as adjacent lines.
    const cutoffRead = SCRIPT.lastIndexOf('const { rows: [boundary] } = await pool.query(CUTOFF_SQL);');
    const update = SCRIPT.indexOf('UPDATE messages m');
    expect(cutoffRead).toBeGreaterThan(-1);
    expect(cutoffRead).toBeLessThan(update);
  });

  it('is written to the ledger with the row counts that produced it', () => {
    expect(SCRIPT).toMatch(/INSERT INTO migration_records \(name, details\)/);
    expect(SCRIPT).toMatch(/threadingCutoff: boundary\.cutoff/);
  });

  it('a run that finds the ledger row reports it and never re-measures', () => {
    // sprint-review 57397: after the backfill, MIN over rooted replies is the
    // oldest reply ever written — plausible and wrong. The ledger read comes
    // before the population count and returns before CUTOFF_SQL runs.
    const ledgerRead = SCRIPT.indexOf("FROM migration_records WHERE name = $1");
    const populationRead = SCRIPT.indexOf('count(*)::int AS needs_root');
    expect(ledgerRead).toBeGreaterThan(-1);
    expect(ledgerRead).toBeLessThan(populationRead);
    // #1149: reading the ledger first is not the property — STOPPING is, and a
    // position comparison cannot see a `return`. Deleting the return at :209
    // leaves both indices unchanged and the script re-measures anyway, which is
    // the exact failure #1148 removed. Pin the thing that stops it.
    const reportedAndStopped = SCRIPT.slice(
      SCRIPT.indexOf('already recorded at'),
      populationRead,
    );
    expect(reportedAndStopped).toMatch(/\breturn\b/);
    expect(SCRIPT).toMatch(/already recorded at \$\{ledger\.applied_at\}/);
    expect(SCRIPT).toMatch(/the boundary is not re-measured/);
  });

  it('the UPDATE and the ledger INSERT are one transaction', () => {
    // sprint-review (TASK-046 note): losing the INSERT after the UPDATE leaves
    // every chain rooted and no cutoff recorded. BEGIN precedes the UPDATE,
    // COMMIT follows the INSERT, and the catch rolls back.
    const begin = SCRIPT.indexOf("await client.query('BEGIN')");
    const update = SCRIPT.indexOf('UPDATE messages m');
    const insert = SCRIPT.lastIndexOf('INSERT INTO migration_records (name, details)');
    const commit = SCRIPT.indexOf("await client.query('COMMIT')");
    expect(begin).toBeGreaterThan(-1);
    expect(begin).toBeLessThan(update);
    expect(update).toBeLessThan(insert);
    expect(insert).toBeLessThan(commit);
    // #1149: order is not reachability. A bare `return` between the UPDATE and
    // the INSERT keeps all four anchors in place and makes the ledger write
    // unreachable — the mutant that stayed green here. Assert no control-flow
    // break separates them.
    expect(SCRIPT.slice(update, insert)).not.toMatch(/\breturn\b|\bthrow\b|process\.exit/);
    // Residue, stated so this is not read as reachability: a token scan over a
    // source slice catches the mutants that INSERT a control-flow keyword and
    // is blind to every mutant that removes reachability without one — an
    // `if (false)` around the block, a condition edited to never hold. It is
    // also false-red-prone: extract a helper between these two anchors and its
    // `return` fails this. The ledger-first half is now executed instead
    // (threadingCutoffLedgerFirst.test.js); this transaction half is not,
    // because reaching the APPLY path needs the argv flags and a seeded
    // messages population. Keep the text guard until that exists.
    expect(SCRIPT).toMatch(/await client\.query\('ROLLBACK'\)/);
    expect(SCRIPT).toMatch(/client\.release\(\)/);
  });

  it('a second run does NOT move the boundary', () => {
    // DO NOTHING, not DO UPDATE. By the second run the population the first
    // one measured no longer exists, so re-deriving would overwrite a true
    // boundary the surface is already rendering against with a false one.
    expect(SCRIPT).toMatch(/ON CONFLICT \(name\) DO NOTHING/);
    expect(SCRIPT).not.toMatch(/ON CONFLICT \(name\) DO UPDATE/);
  });

  it('the dry run reports the cutoff it would record', () => {
    // A boundary that only appears after --apply cannot be checked first.
    const dry = SCRIPT.slice(SCRIPT.indexOf('if (!APPLY)'), SCRIPT.indexOf('DRY RUN — nothing written'));
    expect(dry).toMatch(/CUTOFF_SQL/);
  });

  it('a MISSING row is unknown (expand); a NULL cutoff in a written row is knowledge', () => {
    // The sentence this test used to pin said the opposite — "never as
    // unknown" — and the ruling (docs/design/threading-surface-ruling.md)
    // rejected it: collapsed hides history, so unknown must never resolve there.
    expect(SCRIPT).not.toMatch(/never as "unknown, assume everything is pre-cutoff"/);
    expect(SCRIPT).toMatch(/A MISSING ledger row means "cutoff unknown"/);
  });
});

describe('the population is re-measured, never quoted', () => {
  // @ux-lead's #1115 ruling: the number goes in a PR body as "re-measured at
  // merge time", not as 227 or 245. Those two figures are one day apart and
  // both were taken from the same instance, which is the argument.
  const SCRIPT_SRC = fs.readFileSync(
    path.join(__dirname, '../../../scripts/backfill-thread-root-id.ts'), 'utf8',
  );

  it('the dry run prints the live count and the cutoff BEFORE writing', () => {
    // The mechanism that makes quoting unnecessary: whoever runs it gets the
    // real number for free, at the moment it matters.
    const dry = SCRIPT_SRC.slice(
      SCRIPT_SRC.indexOf('if (!APPLY)'),
      SCRIPT_SRC.indexOf('DRY RUN — nothing written'),
    );
    expect(dry).toMatch(/would set a root on/);
    expect(dry).toMatch(/would record cutoff/);
  });

  it('the header marks its figures as dated observations, not current facts', () => {
    expect(SCRIPT_SRC).toMatch(/RE-MEASURED AT RUN TIME, NEVER QUOTED/);
    expect(SCRIPT_SRC).toMatch(/DATED OBSERVATION/);
  });

  it('and shows the two figures disagreeing, which is the argument', () => {
    // A rule stated without its counter-example gets read as pedantry and
    // dropped. Both numbers are named, a day apart, from the same instance.
    expect(SCRIPT_SRC).toMatch(/227[\s\S]{0,80}2026-08-21/);
    expect(SCRIPT_SRC).toMatch(/245[\s\S]{0,40}2026-08-22/);
  });

  it('no figure is presented as the current population', () => {
    // The specific phrasing the ruling rejects: a bare count asserted as fact.
    expect(SCRIPT_SRC).not.toMatch(/POPULATION, measured/);
    expect(SCRIPT_SRC).not.toMatch(/~227-row UPDATE/);
  });
});

describe('the ordering precondition is written where it is actioned', () => {
  // @sprint-review 56911 verified the DO NOTHING and the read-before-UPDATE.
  // Following that through surfaced a constraint neither the script nor the
  // deploy shows on its own: the zero-edges branch writes a NULL cutoff
  // meaning "no pre-threading history", and that is only TRUE once
  // derivation-on-write is live. Run earlier and it means "not yet" — wrong,
  // and DO NOTHING makes it permanent.
  const SRC = fs.readFileSync(
    path.join(__dirname, '../../../scripts/backfill-thread-root-id.ts'), 'utf8',
  );

  it('the header states the after-deploy ordering as a precondition', () => {
    expect(SRC).toMatch(/RUN THIS \*AFTER\* DERIVATION-ON-WRITE IS DEPLOYED/);
  });

  it('and says what goes wrong if it is run early', () => {
    // A bare "run after X" gets treated as advice. The consequence is what
    // makes it a precondition.
    expect(SRC).toMatch(/zero edges means "not yet" rather than "none"/);
    // Spans a comment line break, so normalise before matching rather than
    // guessing at the wrap position — the reason the first two attempts failed.
    const flat = SRC.replace(/\n\s*\*\s?/g, ' ');
    expect(flat).toMatch(/ON CONFLICT DO NOTHING` would make it permanent/);
  });

  it('both ledger writes are DO NOTHING, which is what makes it permanent', () => {
    // Two INSERTs since the zero-edges branch was added. If either became
    // DO UPDATE the precondition would relax — and the comment would be wrong.
    const inserts = SRC.match(/INSERT INTO migration_records/g) || [];
    const doNothing = SRC.match(/ON CONFLICT \(name\) DO NOTHING/g) || [];
    expect(inserts.length).toBe(2);
    expect(doNothing.length).toBe(2);
  });
});

describe('the ordering precondition is CHECKED, not only warned about', () => {
  // @sprint-review 56912: the header warned about the ordering and nothing
  // enforced it — "there's no check that derivation is live". A warning is the
  // part people skip, and the DO NOTHING that protects a correct boundary
  // equally freezes an incorrect one.
  const SRC = fs.readFileSync(
    path.join(__dirname, '../../../scripts/backfill-thread-root-id.ts'), 'utf8',
  );

  it('uses POSITIVE evidence: a row with both a reply edge and a root', () => {
    // Only derivation-on-write can have produced such a row before the
    // backfill runs. Presence is proof.
    expect(SRC).toMatch(/DERIVATION_LIVE_SQL[\s\S]{0,200}reply_to_message_id IS NOT NULL AND thread_root_id IS NOT NULL/);
  });

  it('and says why absence is NOT proof of the opposite', () => {
    // A live instance with no replies looks identical to one whose backend
    // predates the feature. That asymmetry is the reason for the flag.
    expect(SRC).toMatch(/Absence is NOT proof/);
  });

  it('refuses the ambiguous write rather than guessing', () => {
    expect(SRC).toMatch(/REFUSING to record a null cutoff/);
    expect(SRC).toMatch(/if \(!derivationProven && !ASSUME_DERIVATION_LIVE\)/);
  });

  it('offers an explicit operator override, and records which path was taken', () => {
    // A later reader must be able to tell observed evidence from an assertion.
    expect(SRC).toMatch(/--derivation-live/);
    expect(SRC).toMatch(/derivationEvidence: derivationProven \? 'observed' : 'asserted-by-flag'/);
  });

  it('the refusal exits non-zero, so a script runner notices', () => {
    expect(SRC).toMatch(/process\.exitCode = 3;/);
  });
});

describe('a leftover is a violation where the FK binds, not a design note', () => {
  // @sprint-review 56936 carried my FK finding further. I had the write half
  // (the FK refuses a reply to a missing parent); they added the delete half
  // (ON DELETE SET NULL clears the child's edge rather than orphaning it). So
  // both routes to a dangling edge are shut and the leftover set should be
  // empty — which makes the old unconditional "(orphaned chains stay NULL by
  // design)" a diagnosis printed on every trigger, explaining away a failed
  // walk at exit 0.
  const SRC = fs.readFileSync(
    path.join(__dirname, '../../../scripts/backfill-thread-root-id.ts'), 'utf8',
  );

  it('no longer calls a leftover by-design unconditionally', () => {
    expect(SRC).not.toMatch(/still_null\} \(orphaned chains stay NULL by design\)/);
  });

  it('reports a leftover as an INVARIANT VIOLATION and exits non-zero', () => {
    expect(SRC).toMatch(/INVARIANT VIOLATION/);
    expect(SRC).toMatch(/process\.exitCode = 4;/);
  });

  it('but asks the database whether the FK actually binds first', () => {
    // Their caveat: CREATE TABLE IF NOT EXISTS never retrofits a constraint,
    // so a pre-FK instance genuinely can hold orphans and "by design" is then
    // the honest wording. Conditional, not a hard error.
    expect(SRC).toMatch(/FROM pg_constraint[\s\S]{0,200}reply_to_message_id%REFERENCES messages/);
    expect(SRC).toMatch(/predates `?\n?\s*\+?\s*'?the reply_to_message_id FK/);
  });

  it('and says why the cutoff depends on it', () => {
    // The consequence, not just the fact: a non-empty leftover set means the
    // recorded boundary was computed over rows the walk did not reach.
    expect(SRC).toMatch(/the recorded boundary[\s\S]{0,40}assumes this set is empty/);
  });
});

/**
 * CUTOFF_SQL EXECUTES — @sprint-review (57266) on the layer above: the script
 * refuses to record a boundary it cannot prove, and the harness that checked
 * that refusal could not tell "setup failed" from "no evidence exists". Every
 * assertion in this file was `expect(SCRIPT).toMatch(...)` over the source.
 *
 * `CUTOFF_SQL` is exported and, until now, never run. It is the query the whole
 * TASK-046 argument turns on — orphan immunity, per-instance measurement, and
 * the `from_rooted` flag that doubles as the derivation-liveness evidence — and
 * a regex can only show the text is present, never that it answers correctly.
 */
describe('CUTOFF_SQL, executed', () => {
  const { newDb } = require('pg-mem');
  const { applyTable } = require('../../utils/schemaTable');
  const { CUTOFF_SQL } = require('../../../scripts/backfill-thread-root-id');

  const seeded = async (rows) => {
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)();
    await applyTable(pool, 'pods');
    await applyTable(pool, 'users');
    await applyTable(pool, 'messages');
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ('1', 'p', 'general', 'u')");
    for (const r of rows) {
      await pool.query(
        `INSERT INTO messages (id, pod_id, user_id, content, reply_to_message_id, thread_root_id, created_at)
         VALUES ($1, '1', 'u', 'c', $2::int, $3::int, $4::timestamptz)`,
        [r.id, r.replyTo ?? null, r.root ?? null, r.at],
      );
    }
    const { rows: [b] } = await pool.query(CUTOFF_SQL);
    return b;
  };

  const T = (s) => `2026-08-22T${s}Z`;

  it('measures the FIRST rooted reply, not the newest', async () => {
    const b = await seeded([
      { id: 1, at: T('10:00:00') },
      { id: 2, replyTo: 1, root: 1, at: T('16:05:00') },
      { id: 3, replyTo: 1, root: 1, at: T('18:00:00') },
    ]);

    expect(b.from_rooted).toBe(true);
    expect(new Date(b.cutoff).toISOString()).toBe('2026-08-22T16:05:00.000Z');
  });

  it('a recent retention orphan does NOT move it — the TASK-046 regression', async () => {
    // The rejected form was MAX(created_at) over UN-ROOTED edges. Delete a root
    // and its grandchild keeps a live parent with a null root, so one orphan
    // dragged the boundary hours late. Here the orphan is the newest row in the
    // table and must be invisible to the measurement.
    const b = await seeded([
      { id: 1, at: T('10:00:00') },
      { id: 2, replyTo: 1, root: 1, at: T('16:05:00') },
      { id: 9, replyTo: 1, at: T('23:59:00') },
    ]);

    expect(new Date(b.cutoff).toISOString()).toBe('2026-08-22T16:05:00.000Z');
  });

  it('CONTROL: that orphan IS what the rejected query would have returned', async () => {
    // Without this the test above passes for any query ignoring row 9 —
    // including one that ignores everything. Run the rejected form on the same
    // three rows and watch it pick the orphan.
    const db = newDb();
    const pool = new (db.adapters.createPg().Pool)();
    await applyTable(pool, 'pods');
    await applyTable(pool, 'users');
    await applyTable(pool, 'messages');
    await pool.query("INSERT INTO pods (id, name, type, created_by) VALUES ('1', 'p', 'general', 'u')");
    for (const r of [
      { id: 1, replyTo: null, root: null, at: T('10:00:00') },
      { id: 2, replyTo: 1, root: 1, at: T('16:05:00') },
      { id: 9, replyTo: 1, root: null, at: T('23:59:00') },
    ]) {
      await pool.query(
        `INSERT INTO messages (id, pod_id, user_id, content, reply_to_message_id, thread_root_id, created_at)
         VALUES ($1, '1', 'u', 'c', $2::int, $3::int, $4::timestamptz)`,
        [r.id, r.replyTo, r.root, r.at],
      );
    }
    const { rows: [old] } = await pool.query(
      `SELECT MAX(created_at) AS cutoff FROM messages
        WHERE reply_to_message_id IS NOT NULL AND thread_root_id IS NULL`,
    );

    expect(new Date(old.cutoff).toISOString()).toBe('2026-08-22T23:59:00.000Z');
  });

  it('no rooted reply => from_rooted false, and the fallback value is the un-rooted max', async () => {
    // This is the refusal's input. `from_rooted` false is what makes
    // `!boundary.from_rooted && !ASSUME_DERIVATION_LIVE` fire and exit 3, so
    // the flag is derivation-liveness evidence and the boundary in one read.
    const b = await seeded([
      { id: 1, at: T('10:00:00') },
      { id: 2, replyTo: 1, at: T('12:00:00') },
    ]);

    expect(b.from_rooted).toBe(false);
    expect(new Date(b.cutoff).toISOString()).toBe('2026-08-22T12:00:00.000Z');
  });

  it('an empty instance yields no boundary at all', async () => {
    const b = await seeded([{ id: 1, at: T('10:00:00') }]);

    expect(b.from_rooted).toBe(false);
    expect(b.cutoff).toBeNull();
  });
});
