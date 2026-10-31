jest.mock('../../../services/pgMessageReconcileService', () => ({ copyOne: jest.fn(), ensureLegacyIdIndex: jest.fn() }));

const { backfillLocalMessages, main, parseArgs } = require('../../../scripts/backfill-local-messages-to-pg');

const doc = (id) => ({ _id: { toString: () => id }, podId: 'p', userId: 'u', content: id, createdAt: new Date('2026-01-01') });

const fakeDeps = ({ pending = ['a1', 'a2', 'a3'], overlap = 0, orphans = 0, copy } = {}) => {
  const copied = [];
  return {
    copied,
    countPending: jest.fn(async () => pending.length),
    newestPendingAt: jest.fn(async () => new Date('2026-01-01')),
    countOverlap: jest.fn(async () => overlap),
    countOrphaned: jest.fn(async () => orphans),
    nextBatch: jest.fn(async (afterId, limit) => {
      const start = afterId ? pending.indexOf(afterId) + 1 : 0;
      return pending.slice(start, start + limit).map(doc);
    }),
    copy: jest.fn(copy || (async (d) => { copied.push(d._id.toString()); return 'moved'; })),
  };
};

describe('backfillLocalMessages', () => {
  it('a dry run reports the pending count and writes nothing', async () => {
    const deps = fakeDeps();
    const report = await backfillLocalMessages(deps);
    expect(report).toMatchObject({ dryRun: true, pending: 3, refused: false, moved: 0 });
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('--apply copies every pending message across batches', async () => {
    const deps = fakeDeps({ pending: ['a1', 'a2', 'a3', 'a4', 'a5'] });
    const report = await backfillLocalMessages(deps, { apply: true, batchSize: 2 });
    expect(deps.copied).toEqual(['a1', 'a2', 'a3', 'a4', 'a5']);
    expect(report).toMatchObject({ moved: 5, alreadyPresent: 0, failed: 0 });
  });

  it('counts rows PostgreSQL already had, so a rerun inserts nothing new', async () => {
    const deps = fakeDeps({ copy: async () => 'present' });
    const report = await backfillLocalMessages(deps, { apply: true });
    expect(report).toMatchObject({ moved: 0, alreadyPresent: 3 });
  });

  it('refuses when PostgreSQL holds older messages that did not come from this MongoDB', async () => {
    const deps = fakeDeps({ overlap: 12 });
    const report = await backfillLocalMessages(deps, { apply: true });
    expect(report).toMatchObject({ refused: true, overlap: 12, moved: 0 });
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('--force copies despite the overlap', async () => {
    const deps = fakeDeps({ overlap: 12 });
    const report = await backfillLocalMessages(deps, { apply: true, force: true });
    expect(report).toMatchObject({ refused: false, moved: 3 });
  });

  it('a dry run reports how many pending rows belong to deleted pods', async () => {
    const deps = fakeDeps({ orphans: 2 });
    const report = await backfillLocalMessages(deps);
    expect(report).toMatchObject({ dryRun: true, pending: 3, orphanedPending: 2, orphaned: 0 });
    expect(deps.copy).not.toHaveBeenCalled();
  });

  it('a row whose pod is gone is counted as orphaned, not failed, and the run continues', async () => {
    const deps = fakeDeps({
      orphans: 1,
      copy: async (d) => (d._id.toString() === 'a2' ? 'orphaned' : 'moved'),
    });
    const report = await backfillLocalMessages(deps, { apply: true, batchSize: 1 });
    expect(report).toMatchObject({ moved: 2, orphaned: 1, alreadyPresent: 0, failed: 0 });
  });

  it('a failed row is counted and the run moves past it', async () => {
    const deps = fakeDeps({ copy: async (d) => { if (d._id.toString() === 'a2') throw new Error('bad'); return 'moved'; } });
    const report = await backfillLocalMessages(deps, { apply: true, batchSize: 1 });
    expect(report).toMatchObject({ moved: 2, failed: 1 });
  });
});

describe('main() exit code', () => {
  const run = async (deps, argv = ['node', 'script', '--apply']) => {
    const close = jest.fn(async () => {});
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.exitCode;
    try {
      const code = await main(argv, async () => ({ deps, close }));
      return { code, exitCode: process.exitCode, close };
    } finally {
      process.exitCode = before;
      log.mockRestore();
    }
  };

  it('a refused run sets process.exitCode to 2 and closes the stores', async () => {
    const deps = fakeDeps({ overlap: 4 });
    const { code, exitCode, close } = await run(deps);
    expect(exitCode).toBe(2);
    expect(code).toBe(2);
    expect(deps.copy).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('failed rows set 1; a clean run and a clean dry run set 0; a refused dry run sets 2', async () => {
    expect((await run(fakeDeps({ copy: async () => { throw new Error('boom'); } }))).exitCode).toBe(1);
    expect((await run(fakeDeps())).exitCode).toBe(0);
    expect((await run(fakeDeps(), ['node', 'script'])).exitCode).toBe(0);
    expect((await run(fakeDeps({ overlap: 4 }), ['node', 'script'])).exitCode).toBe(2);
    expect((await run(fakeDeps({ orphans: 3, copy: async () => 'orphaned' }))).exitCode).toBe(0);
  });
});

describe('--since', () => {
  it('passes the parsed time to the stores, and no flag passes none', async () => {
    const open = jest.fn(async () => ({ deps: fakeDeps(), close: async () => {} }));
    const log = jest.spyOn(console, 'log').mockImplementation(() => {});
    const before = process.exitCode;
    try {
      await main(['node', 'script', '--since', '2026-09-30T00:00:00Z'], open);
      await main(['node', 'script'], open);
    } finally {
      process.exitCode = before;
      log.mockRestore();
    }
    expect(open.mock.calls[0][0].since.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(open.mock.calls[1][0].since).toBeUndefined();
  });

  it('an unparseable or missing date throws before any store opens', async () => {
    const open = jest.fn();
    await expect(main(['node', 'script', '--since', 'last-month'], open)).rejects.toThrow('--since needs an ISO date');
    await expect(main(['node', 'script', '--since'], open)).rejects.toThrow('got nothing');
    expect(open).not.toHaveBeenCalled();
    expect(parseArgs(['node', 'script']).since).toBeUndefined();
  });

  it('reads the = form the same as the space form', () => {
    const spaced = parseArgs(['node', 'script', '--since', '2026-09-30T00:00:00Z', '--apply', '--force']);
    const joined = parseArgs(['node', 'script', '--since=2026-09-30T00:00:00Z', '--apply', '--force']);
    expect(joined).toEqual(spaced);
    expect(joined).toMatchObject({ apply: true, force: true });
    expect(joined.since.toISOString()).toBe('2026-09-30T00:00:00.000Z');
    expect(() => parseArgs(['node', 'script', '--since='])).toThrow('--since needs an ISO date');
  });

  it('a misspelt or unknown flag throws before any store opens, so the run cannot go unbounded', async () => {
    const open = jest.fn();
    await Promise.all([
      ['node', 'script', '--snce', '2026-09-30T00:00:00Z', '--apply', '--force'],
      ['node', 'script', '--since-date=2026-09-30T00:00:00Z', '--apply', '--force'],
      ['node', 'script', '--apply', '--force', '2026-09-30T00:00:00Z'],
    ].map((argv) => expect(main(argv, open)).rejects.toThrow('unknown argument')));
    await expect(main(['node', 'script', '--since', '2026-09-30', '--since=2026-10-01'], open))
      .rejects.toThrow('more than once');
    expect(open).not.toHaveBeenCalled();
  });
});
