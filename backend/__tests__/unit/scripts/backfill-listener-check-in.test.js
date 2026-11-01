const { backfillListenerCheckIn } = require('../../../scripts/backfill-listener-check-in');

const candidate = (store, tokenId) => ({
  store, ownerId: `${store}-owner`, tokenId, lastUsedAt: '2026-10-01T00:00:00.000Z',
});

const makeDeps = (candidates, stamp = async () => 1, unaddressable = 0) => ({
  listCandidates: jest.fn(async () => ({ candidates, unaddressable })),
  stamp: jest.fn(stamp),
});

describe('backfill-listener-check-in', () => {
  it('reports the candidates by store and writes nothing in the default dry run', async () => {
    const deps = makeDeps([candidate('user', 'a'), candidate('user', 'b'), candidate('installation', 'c')]);
    const report = await backfillListenerCheckIn(deps);
    expect(report).toMatchObject({
      dryRun: true, candidates: 3, byStore: { user: 2, installation: 1 }, frozen: null, applied: 0,
    });
    expect(deps.stamp).not.toHaveBeenCalled();
  });

  it('reports tokens it cannot address so the operator sees them before the switch', async () => {
    const report = await backfillListenerCheckIn(makeDeps([candidate('user', 'a')], undefined, 2));
    expect(report).toMatchObject({ candidates: 1, unaddressable: 2 });
  });

  it('refuses to apply without the frozen set from a dry run', async () => {
    await expect(backfillListenerCheckIn(makeDeps([candidate('user', 'a')]), { apply: true }))
      .rejects.toThrow(/frozen id set/);
  });

  it('touches only the frozen set, even when more tokens became candidates since', async () => {
    const frozen = [candidate('user', 'a')];
    const deps = makeDeps([candidate('user', 'a'), candidate('user', 'new-since')]);
    const report = await backfillListenerCheckIn(deps, { apply: true, frozen });
    expect(deps.stamp).toHaveBeenCalledTimes(1);
    expect(deps.stamp).toHaveBeenCalledWith(frozen[0]);
    expect(report).toMatchObject({
      dryRun: false, frozen: 1, applied: 1, skippedAlreadyStamped: 0, 
    });
  });

  it('counts a token a listener already stamped as skipped, not applied', async () => {
    const frozen = [candidate('user', 'a'), candidate('installation', 'b')];
    const deps = makeDeps(frozen, async (c) => (c.tokenId === 'a' ? 0 : 1));
    const report = await backfillListenerCheckIn(deps, { apply: true, frozen });
    expect(report).toMatchObject({ applied: 1, skippedAlreadyStamped: 1, failed: 0 });
  });

  it('keeps going and reports a failed write', async () => {
    const frozen = [candidate('user', 'a'), candidate('user', 'b')];
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const deps = makeDeps(frozen, async (c) => {
      if (c.tokenId === 'a') throw new Error('boom');
      return 1;
    });
    const report = await backfillListenerCheckIn(deps, { apply: true, frozen });
    expect(report).toMatchObject({ applied: 1, failed: 1 });
    errSpy.mockRestore();
  });
});
