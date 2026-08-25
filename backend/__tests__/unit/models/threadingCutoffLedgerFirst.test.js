/**
 * A second run reports the recorded cutoff and STOPS — executed, not read.
 *
 * @sprint-review 57397 established the ordering; #1149 pinned it; and
 * @sprint-review then re-checked the guards themselves and found both were
 * pure `indexOf`/`lastIndexOf` over the script SOURCE, so the mutants they
 * were written against ship green. A position comparison cannot see a
 * `return`: delete the early return and `ledgerRead < populationRead` still
 * holds, while the script re-measures a boundary that is no longer
 * measurable — the exact #1148 failure.
 *
 * Text guards remain in threadingCutoffRecord.test.js and are useful for the
 * structural half (rule 18). This file covers the behavioural half the only
 * way it can be covered: by running the thing.
 *
 * The instrument is a counting pool. "Stopped" is not observable from the
 * database — ON CONFLICT DO NOTHING means a re-measuring run leaves the ledger
 * row byte-identical, so asserting on stored state cannot distinguish the two.
 * What distinguishes them is WHICH QUERIES ISSUE, so that is what we record.
 */
const { newDb } = require('pg-mem');
const { applyTable } = require('../../utils/schemaTable');

const mockDb = newDb();
const basePool = new (mockDb.adapters.createPg().Pool)();

const issued = [];
const countingPool = {
  query: (...args) => {
    issued.push(String(args[0]?.text || args[0]));
    return basePool.query(...args);
  },
};

const { main, MIGRATION_NAME } = require('../../../scripts/backfill-thread-root-id');

const CUTOFF = '2026-08-01T00:00:00.000Z';

beforeAll(async () => {
  await applyTable(basePool, 'migration_records');
});

beforeEach(() => {
  issued.length = 0;
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => jest.restoreAllMocks());

describe('the ledger row short-circuits the run', () => {
  beforeAll(async () => {
    await basePool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME, JSON.stringify({ threadingCutoff: CUTOFF, rowsUpdated: 7 })],
    );
  });

  it('issues the ledger read and NOTHING else', async () => {
    await main(countingPool);
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatch(/FROM migration_records WHERE name = \$1/);
  });

  it('never counts the population, which is the query that would lie', async () => {
    // After a backfill every pre-threading reply carries a root, so the
    // population read and the MIN below it return a plausible wrong answer
    // rather than an obviously broken one. Not reaching them is the property.
    await main(countingPool);
    expect(issued.join('\n')).not.toMatch(/needs_root/);
    expect(issued.join('\n')).not.toMatch(/UPDATE messages/);
  });

  it('reports the recorded value rather than a recomputed one', async () => {
    await main(countingPool);
    const said = console.log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(said).toContain(MIGRATION_NAME);
    expect(said).toContain(CUTOFF);
    expect(said).toContain('the boundary is not re-measured');
  });

  it('CONTROL: with no ledger row the run does NOT stop there', async () => {
    // Without this the assertions above are equally consistent with a main()
    // that issues one query and returns under every condition — including a
    // stubbed-out one. Proves the short-circuit is the ledger row's doing.
    await basePool.query('DELETE FROM migration_records WHERE name = $1', [MIGRATION_NAME]);
    issued.length = 0;
    await main(countingPool).catch(() => {});
    expect(issued.length).toBeGreaterThan(1);
    expect(issued.join('\n')).toMatch(/needs_root/);
    // Restore for any later describe.
    await basePool.query(
      `INSERT INTO migration_records (name, details)
       VALUES ($1, $2::jsonb) ON CONFLICT (name) DO NOTHING`,
      [MIGRATION_NAME, JSON.stringify({ threadingCutoff: CUTOFF, rowsUpdated: 7 })],
    );
  });
});
