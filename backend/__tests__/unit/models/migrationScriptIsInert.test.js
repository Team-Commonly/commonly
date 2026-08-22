/**
 * Requiring a script must not RUN it (W-T, TASK-029).
 *
 * threadStateController imported MIGRATION_NAME from the backfill script. That
 * script called main() at module scope, so pulling one string out of it
 * executed the migration. The chain was server.ts -> routes/messages.ts ->
 * threadStateController -> the script, i.e. it ran on every server boot.
 *
 * Caught by CI, and by nothing I ran locally: my targeted jest invocations
 * never loaded server.ts, and the stacked PR carrying the defect had no CI at
 * all (every workflow is gated `branches: [main]`, so a PR based on a feature
 * branch matches none of them). Two blind spots composing.
 */
const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '../../../', p), 'utf8');

describe('the backfill script is inert when required', () => {
  it('main() runs only under require.main === module', () => {
    const src = read('scripts/backfill-thread-root-id.ts');
    expect(src).toMatch(/if \(require\.main === module\) \{\s*\n\s*main\(\);/);
    // and is not ALSO called unguarded somewhere
    expect(src).not.toMatch(/^main\(\);/m);
  });

  it('requiring it really is side-effect free', async () => {
    // The discriminating check, and the one a regex cannot make: PG_HOST is
    // unset here, so an unguarded main() calls process.exit(2) and takes the
    // worker down. If this test returns at all, the guard held.
    const before = process.env.PG_HOST;
    delete process.env.PG_HOST;
    const exit = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    try {
      // eslint-disable-next-line global-require
      const mod = require('../../../scripts/backfill-thread-root-id');
      expect(typeof mod.MIGRATION_NAME).toBe('string');
      expect(exit).not.toHaveBeenCalled();
    } finally {
      exit.mockRestore();
      if (before !== undefined) process.env.PG_HOST = before;
    }
  });
});

describe('the shared constant lives in a module with no side effects', () => {
  it('the controller reads the name from constants, not from the script', () => {
    const src = read('controllers/threadStateController.ts');
    expect(src).toMatch(/require\('\.\.\/constants\/migrations'\)/);
    expect(src).not.toMatch(/require\('\.\.\/scripts\//);
  });

  it('constants/migrations imports nothing', () => {
    // The property that makes it safe. An import here re-opens the door.
    const src = read('constants/migrations.ts');
    expect(src).not.toMatch(/^\s*(import|const .*= require\()/m);
  });

  it('script and controller agree on the name', () => {
    // eslint-disable-next-line global-require
    const { THREADING_BACKFILL_MIGRATION } = require('../../../constants/migrations');
    // eslint-disable-next-line global-require
    const { MIGRATION_NAME } = require('../../../scripts/backfill-thread-root-id');
    expect(MIGRATION_NAME).toBe(THREADING_BACKFILL_MIGRATION);
  });
});
