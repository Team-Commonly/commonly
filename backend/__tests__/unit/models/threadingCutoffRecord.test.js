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
