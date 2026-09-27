// The cleanup script writes to production PG, so its arms are about what it
// refrains from doing: the class it refuses to delete, the run it refuses to
// perform, and the reconciliation it reports. Every arm sets its own fixtures
// through `fixtures()` — the pool mock dispatches on SQL rather than on call
// order, so inserting a query into the script cannot silently re-point an arm.
jest.mock('../../../config/db-pg', () => ({ pool: { query: jest.fn() } }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));

const { pool } = require('../../../config/db-pg');
const MongoPod = require('../../../models/Pod');
const { cleanupGhostPodMembers } = require('../../../scripts/cleanup-ghost-pod-members');

const ROW_SQL = /SELECT pod_id, user_id FROM pod_members/;
const COUNT_SQL = /count\(\*\)/;
const DELETE_SQL = /^DELETE FROM pod_members/;

/**
 * rows:    `{ pod_id, user_id }` rows the mirror holds.
 * docs:    podId → the Mongo document `findById` resolves to (`null` = no such
 *          pod, `undefined` = treat as not found).
 * errors:  podId → the error `findById` throws.
 * remaining: the row count the post-sweep `count(*)` reports.
 */
const fixtures = ({ rows, docs = {}, errors = {}, remaining = 0 } = {}) => {
  const deleted = [];
  pool.query.mockImplementation(async (sql, params) => {
    if (ROW_SQL.test(sql)) return { rows };
    if (COUNT_SQL.test(sql)) return { rows: [{ n: remaining }] };
    if (DELETE_SQL.test(sql)) {
      deleted.push(`${params[0]}:${params[1]}`);
      return { rows: [] };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  MongoPod.findById.mockImplementation((podId) => {
    if (errors[podId]) throw errors[podId];
    return {
      select: () => ({ lean: async () => (docs[podId] === undefined ? null : docs[podId]) }),
    };
  });
  return { deleted };
};

const row = (podId, userId) => ({ pod_id: podId, user_id: userId });
const member = (...ids) => ({ members: ids });
const castError = () => {
  const err = new Error('Cast to ObjectId failed for value "legacy-1"');
  err.name = 'CastError';
  return err;
};

describe('cleanup-ghost-pod-members', () => {
  afterEach(() => jest.clearAllMocks());

  it('a dry run classifies every row, names one example per class, and deletes nothing', async () => {
    fixtures({
      rows: [row('podKeep', 'userKeep'), row('podGhost', 'userGone'), row('podOrphan', 'userO')],
      docs: { podKeep: member('userKeep'), podGhost: member('someoneElse'), podOrphan: null },
    });

    const r = await cleanupGhostPodMembers({ dryRun: true });

    expect(r).toEqual(expect.objectContaining({
      examined: 3, legitimate: 1, ghost: 1, orphan: 1, deleted: 0, refused: false,
    }));
    expect(r.examples.legitimate).toEqual({ podId: 'podKeep', userId: 'userKeep' });
    expect(r.examples.ghost).toEqual({ podId: 'podGhost', userId: 'userGone' });
    expect(r.examples.orphan).toEqual({ podId: 'podOrphan', userId: 'userO' });
    expect(pool.query.mock.calls.some(([sql]) => DELETE_SQL.test(sql))).toBe(false);
  });

  it('deletes the ghost and the orphan and never the listed member', async () => {
    const { deleted } = fixtures({
      rows: [row('podKeep', 'userKeep'), row('podGhost', 'userGone'), row('podOrphan', 'userO')],
      docs: { podKeep: member('userKeep'), podGhost: member('someoneElse'), podOrphan: null },
      remaining: 1,
    });

    const r = await cleanupGhostPodMembers({ dryRun: false });

    expect(deleted.sort()).toEqual(['podGhost:userGone', 'podOrphan:userO']);
    expect(deleted).not.toContain('podKeep:userKeep');
    expect(r.deleted).toBe(2);
    expect(r.legitimate).toBe(1);
  });

  it('refuses the whole run when a pod cannot be read, and deletes nothing even where it could', async () => {
    const { deleted } = fixtures({
      rows: [row('podUnreadable', 'userU'), row('podGhost', 'userGone')],
      docs: { podGhost: member('someoneElse') },
      errors: { podUnreadable: new Error('connection terminated unexpectedly') },
    });

    const r = await cleanupGhostPodMembers({ dryRun: false });

    expect(r.refused).toBe(true);
    expect(r.unreadable).toBe(1);
    expect(r.unreadablePodIds).toEqual(['podUnreadable']);
    // The classifiable ghost is not swept either: a partial delete over a store
    // we could not fully observe is not a result an operator can check.
    expect(deleted).toEqual([]);
    expect(r.deleted).toBe(0);
  });

  it('a malformed pod id is an orphan, not a read failure', async () => {
    const { deleted } = fixtures({
      rows: [row('legacy-1', 'userL')],
      errors: { 'legacy-1': castError() },
      remaining: 0,
    });

    const r = await cleanupGhostPodMembers({ dryRun: false });

    expect(r).toEqual(expect.objectContaining({ orphan: 1, unreadable: 0, refused: false, deleted: 1 }));
    expect(deleted).toEqual(['legacy-1:userL']);
  });

  it('reconciles the two numbers against the observed post-state, and reports when they disagree', async () => {
    const rows = [row('podGhost', 'userGone')];
    const docs = { podGhost: member('someoneElse') };

    fixtures({ rows, docs, remaining: 0 });
    const reconciled = await cleanupGhostPodMembers({ dryRun: false });
    expect(reconciled).toEqual(expect.objectContaining({ examined: 1, deleted: 1, remaining: 0, reconciled: true }));

    // The same report, but the store did not lose the row: 1 - 1 !== 1.
    fixtures({ rows, docs, remaining: 1 });
    const diverged = await cleanupGhostPodMembers({ dryRun: false });
    expect(diverged).toEqual(expect.objectContaining({ examined: 1, deleted: 1, remaining: 1, reconciled: false }));
  });

  it('is idempotent: the second run finds nothing to delete', async () => {
    fixtures({ rows: [row('podKeep', 'userKeep')], docs: { podKeep: member('userKeep') }, remaining: 1 });

    const r = await cleanupGhostPodMembers({ dryRun: false });

    expect(r).toEqual(expect.objectContaining({ examined: 1, toDelete: [], deleted: 0, reconciled: true }));
  });
});
