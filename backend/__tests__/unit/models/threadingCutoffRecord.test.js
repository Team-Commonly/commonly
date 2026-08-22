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
  it('is defined as the newest row with a reply edge and no root', () => {
    // That predicate IS "written before derivation-on-write shipped" — exact,
    // not a deploy timestamp guessed after the fact.
    expect(SCRIPT).toMatch(/SELECT MAX\(created_at\) AS cutoff[\s\S]{0,120}reply_to_message_id IS NOT NULL AND thread_root_id IS NULL/);
  });

  it('is read BEFORE the UPDATE, because the UPDATE destroys the predicate', () => {
    const cutoffRead = SCRIPT.indexOf('const { rows: [boundary] } = await pool.query(CUTOFF_SQL);\n\n    const result');
    const update = SCRIPT.indexOf('UPDATE messages m');
    expect(cutoffRead).toBeGreaterThan(-1);
    expect(cutoffRead).toBeLessThan(update);
  });

  it('is written to the ledger with the row counts that produced it', () => {
    expect(SCRIPT).toMatch(/INSERT INTO migration_records \(name, details\)/);
    expect(SCRIPT).toMatch(/threadingCutoff: boundary\.cutoff/);
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

  it('NULL is documented as "no pre-cutoff roots", not "unknown"', () => {
    // The dangerous misreading: a fresh instance has no pre-threading history,
    // and treating NULL as unknown would expand every thread on it.
    expect(SCRIPT).toMatch(/never as "unknown, assume everything is pre-cutoff"/);
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
