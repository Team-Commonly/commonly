jest.mock('../../../services/pgMessageReconcileService', () => ({ copyOne: jest.fn(), ensureLegacyIdIndex: jest.fn() }));

const { backfillLocalMessages, exitCodeFor } = require('../../../scripts/backfill-local-messages-to-pg');

const doc = (id) => ({ _id: { toString: () => id }, podId: 'p', userId: 'u', content: id, createdAt: new Date('2026-01-01') });

const fakeDeps = ({ pending = ['a1', 'a2', 'a3'], overlap = 0, copy } = {}) => {
  const copied = [];
  return {
    copied,
    countPending: jest.fn(async () => pending.length),
    newestPendingAt: jest.fn(async () => new Date('2026-01-01')),
    countOverlap: jest.fn(async () => overlap),
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

  it('a failed row is counted and the run moves past it', async () => {
    const deps = fakeDeps({ copy: async (d) => { if (d._id.toString() === 'a2') throw new Error('bad'); return 'moved'; } });
    const report = await backfillLocalMessages(deps, { apply: true, batchSize: 1 });
    expect(report).toMatchObject({ moved: 2, failed: 1 });
  });
});

describe('exitCodeFor', () => {
  it('a refused run exits 2, so an upgrade script stops', async () => {
    const report = await backfillLocalMessages(fakeDeps({ overlap: 4 }), { apply: true });
    expect(report.refused).toBe(true);
    expect(exitCodeFor(report)).toBe(2);
  });

  it('a run with failed rows exits 1, and a clean run or dry run exits 0', async () => {
    const failing = await backfillLocalMessages(fakeDeps({ copy: async () => { throw new Error('boom'); } }), { apply: true });
    expect(exitCodeFor(failing)).toBe(1);
    expect(exitCodeFor(await backfillLocalMessages(fakeDeps(), { apply: true }))).toBe(0);
    expect(exitCodeFor(await backfillLocalMessages(fakeDeps()))).toBe(0);
  });
});
