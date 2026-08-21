/**
 * Kernel work sweep (#1044). The properties pinned here are the ones whose
 * violation is quiet: a rescue that clobbers a live renewal looks like a
 * rescue; a wake on an empty board looks like liveness; an unpriced wake
 * looks like delivery.
 */
const mongoose = require('mongoose');

jest.mock('../../../models/Task', () => ({
  find: jest.fn(),
  findOneAndUpdate: jest.fn(),
  aggregate: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));

const mockNotifyFoundWork = jest.fn();
const mockNotifyLeaseWarning = jest.fn();
jest.mock('../../../services/taskEventService', () => ({
  notifyFoundWork: (...args) => mockNotifyFoundWork(...args),
  notifyLeaseWarning: (...args) => mockNotifyLeaseWarning(...args),
}));

const mockDeriveAgentState = jest.fn();
jest.mock('../../../services/agentStateService', () => ({
  deriveAgentState: (...args) => mockDeriveAgentState(...args),
}));

// The contract pin below requires routes/tasksApi for its claimableConditions
// export, and the route module drags express middleware at load —
// middleware/auth pulls jsonwebtoken, whose buffer-equal-constant-time dep
// crashes on Node 26 before any test registers (the incompat #1029's revert
// note recorded). Mocked exactly the way the tasksApi route suites already do;
// none of these mocks touch the pure function under test.
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/githubAppService', () => ({ isPatConfigured: jest.fn(() => false) }));

const Task = require('../../../models/Task');
const User = require('../../../models/User');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const KernelWorkSweepService = require('../../../services/kernelWorkSweepService');

const HOLDER_ID = new mongoose.Types.ObjectId().toString();

// A holder that resolves to a real install. `state` is whatever
// deriveAgentState is mocked to return — the point of the seam.
const mockHolderResolves = (state) => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        username: 'sprint-impl',
        isBot: true,
        botMetadata: { agentName: 'claude-code', instanceId: 'sprint-impl' },
        agentRuntimeTokens: [],
      }),
    }),
  });
  AgentInstallation.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ agentName: 'claude-code', instanceId: 'sprint-impl' }),
    }),
  });
  mockDeriveAgentState.mockReturnValue({ agentName: 'claude-code', instanceId: 'sprint-impl', state });
};

const POD_A = new mongoose.Types.ObjectId().toString();
const NOW = new Date('2026-08-20T20:00:00Z');

const lapsedTask = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  podId: POD_A,
  taskId: 'TASK-007',
  title: 'stalled work',
  status: 'claimed',
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.AGENT_WORK_SWEEP_DISABLED;
  Task.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
  });
  Task.aggregate.mockResolvedValue([]);
  mockNotifyFoundWork.mockResolvedValue({ woken: 1 });
  mockNotifyLeaseWarning.mockResolvedValue({ warned: true });
  // Default: the holder cannot be resolved at all, which is the pre-#1080
  // behaviour — rescue as today. Tests that care opt in via mockHolderResolves.
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  });
  AgentInstallation.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }),
  });
});

describe('rescueLapsed', () => {
  it('rescues through a CAS whose filter carries the lapsed predicate', async () => {
    const t = lapsedTask();
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([t]) }),
    });
    Task.findOneAndUpdate.mockResolvedValue({ ...t, status: 'pending' });

    const { rescued } = await KernelWorkSweepService.rescueLapsed(NOW);

    expect(rescued).toHaveLength(1);
    const [filter, update] = Task.findOneAndUpdate.mock.calls[0];
    // The lapsed predicate must travel INTO the write. Filtering only by _id
    // is the read-then-write @sprint-review caught: a claimant renewing
    // between the find and the update gets silently clobbered.
    expect(filter._id).toBe(t._id);
    expect(Array.isArray(filter.$or)).toBe(true);
    expect(JSON.stringify(filter.$or)).toContain('claimExpiresAt');
    // Assignee cleared, or the task returns to the dead seat's lane where no
    // other assignee-scoped fetch ever sees it (#1023).
    expect(update.$set.assignee).toBeNull();
    expect(update.$set.status).toBe('pending');
  });

  it('a renewal between find and update wins — the sweep records no rescue', async () => {
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([lapsedTask()]) }),
    });
    // CAS misses: the holder renewed, no lapsed branch matches.
    Task.findOneAndUpdate.mockResolvedValue(null);

    const { rescued } = await KernelWorkSweepService.rescueLapsed(NOW);
    expect(rescued).toHaveLength(0);
  });

  it('the write names the kernel actor in the audit trail', async () => {
    const t = lapsedTask();
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([t]) }),
    });
    Task.findOneAndUpdate.mockResolvedValue({ ...t, status: 'pending' });

    await KernelWorkSweepService.rescueLapsed(NOW);

    const [, update] = Task.findOneAndUpdate.mock.calls[0];
    expect(update.$push.updates.author).toBe('kernel-sweep');
    expect(update.$push.updates.text).toContain('kernel sweep');
  });
});

describe('#1080 part 2 — liveness gates the rescue, and only liveness', () => {
  const withCandidate = (overrides = {}) => {
    const t = lapsedTask({ claimedBy: HOLDER_ID, assignee: 'sprint-impl', ...overrides });
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([t]) }),
    });
    Task.findOneAndUpdate.mockResolvedValue({ ...t });
    return t;
  };

  it('a provably-live holder is deferred, not rescued', async () => {
    withCandidate();
    mockHolderResolves('listening');

    const { rescued, deferred } = await KernelWorkSweepService.rescueLapsed(NOW);

    expect(rescued).toHaveLength(0);
    expect(deferred).toHaveLength(1);
    const [, update] = Task.findOneAndUpdate.mock.calls[0];
    // The deferring write must NOT touch status/assignee — the whole point is
    // that the row stays exactly as the holder left it.
    expect(update.$set.status).toBeUndefined();
    expect(update.$set.assignee).toBeUndefined();
    expect(update.$set.rescueDeferrals).toBe(1);
  });

  it('deferral does NOT extend the lease — the row stays claimable by peers', async () => {
    withCandidate();
    mockHolderResolves('listening');

    await KernelWorkSweepService.rescueLapsed(NOW);

    const [, update] = Task.findOneAndUpdate.mock.calls[0];
    // "liveness isn't tenure" (fable, 56210). If deferral pushed
    // claimExpiresAt forward, the kernel would be renewing on the holder's
    // behalf — a seat that never renews would hold the row indefinitely, and
    // a peer who legitimately needs it could no longer win the claim CAS.
    expect(update.$set.claimExpiresAt).toBeUndefined();
    expect(update.$set.claimedAt).toBeUndefined();
  });

  it('warns the holder it deferred for, naming the task and the budget', async () => {
    const t = withCandidate();
    mockHolderResolves('listening');

    await KernelWorkSweepService.rescueLapsed(NOW);

    expect(mockNotifyLeaseWarning).toHaveBeenCalledTimes(1);
    const [podId, holder, task, used, max] = mockNotifyLeaseWarning.mock.calls[0];
    expect(String(podId)).toBe(String(t.podId));
    expect(holder.label).toBe('sprint-impl');
    expect(task.taskId).toBe('TASK-007');
    expect(used).toBe(1);
    expect(max).toBe(3);
  });

  it('rescues once the deferral budget is spent, and says why', async () => {
    withCandidate({ rescueDeferrals: 3 });
    mockHolderResolves('listening');

    const { rescued, deferred } = await KernelWorkSweepService.rescueLapsed(NOW);

    expect(deferred).toHaveLength(0);
    expect(rescued).toHaveLength(1);
    const [, update] = Task.findOneAndUpdate.mock.calls[0];
    expect(update.$set.status).toBe('pending');
    expect(update.$push.updates.text).toContain('3 deferrals');
    expect(mockNotifyLeaseWarning).not.toHaveBeenCalled();
  });

  it.each([
    ['gone-dark', 'the wrapper stopped polling'],
    ['never-connected', 'the wrapper never polled'],
    ['unknown', 'the gateway tier cannot say'],
    ['reachable', 'asserted by construction, never measured'],
  ])('%s rescues as today (%s)', async (state) => {
    withCandidate();
    mockHolderResolves(state);

    const { rescued, deferred } = await KernelWorkSweepService.rescueLapsed(NOW);

    // Only 'listening' is evidence. 'reachable' and 'unknown' are NOT the
    // opposite of dead — they are the derivation declining to measure — and
    // deferring on them would grant tenure to a class nobody checked.
    expect(deferred).toHaveLength(0);
    expect(rescued).toHaveLength(1);
    expect(mockNotifyLeaseWarning).not.toHaveBeenCalled();
  });

  it('an unresolvable holder rescues as today', async () => {
    withCandidate({ claimedBy: null, assignee: null });

    const { rescued } = await KernelWorkSweepService.rescueLapsed(NOW);

    expect(rescued).toHaveLength(1);
    expect(mockDeriveAgentState).not.toHaveBeenCalled();
  });

  it('a warning that fails to deliver still leaves the deferral standing', async () => {
    withCandidate();
    mockHolderResolves('listening');
    mockNotifyLeaseWarning.mockRejectedValue(new Error('queue down'));

    const { rescued, deferred } = await KernelWorkSweepService.rescueLapsed(NOW);

    // An undeliverable warning is a missing signal, not a verdict on the
    // holder. Rescuing here would make a queue outage look like abandonment.
    expect(deferred).toHaveLength(1);
    expect(rescued).toHaveLength(0);
  });
});

describe('#1080 part 3 — provenance survives the clearing', () => {
  it('the rescue records who held it, in the field AND the audit trail', async () => {
    const t = lapsedTask({ claimedBy: HOLDER_ID, assignee: 'sprint-impl' });
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([t]) }),
    });
    Task.findOneAndUpdate.mockResolvedValue({ ...t, status: 'pending' });

    await KernelWorkSweepService.rescueLapsed(NOW);

    const [, update] = Task.findOneAndUpdate.mock.calls[0];
    // assignee/claimedBy are cleared in the SAME write — that clearing is what
    // erased the only record of ownership and let a finished PR be advertised
    // as unclaimed work. lapsedFrom is the record that outlives it.
    expect(update.$set.assignee).toBeNull();
    expect(update.$set.claimedBy).toBeNull();
    expect(update.$set.lapsedFrom).toBe('sprint-impl');
    expect(update.$push.updates.text).toContain('was: sprint-impl');
  });

  it('falls back to claimedBy when the row carries no assignee', async () => {
    const t = lapsedTask({ claimedBy: 'nova', assignee: null });
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([t]) }),
    });
    Task.findOneAndUpdate.mockResolvedValue({ ...t, status: 'pending' });

    await KernelWorkSweepService.rescueLapsed(NOW);

    const [, update] = Task.findOneAndUpdate.mock.calls[0];
    expect(update.$set.lapsedFrom).toBe('nova');
  });

  it('the found-work wake carries lapsedFrom out of the aggregate', async () => {
    Task.aggregate.mockResolvedValue([
      {
        _id: POD_A,
        tasks: [{ taskId: 'TASK-015', title: 'decouple', lapsedFrom: 'sprint-impl' }],
        count: 1,
      },
    ]);

    await KernelWorkSweepService.wakeForFoundWork(NOW);

    const [, items] = mockNotifyFoundWork.mock.calls[0];
    expect(items[0].lapsedFrom).toBe('sprint-impl');
    // The projection is where this can silently die: $group must $push the
    // field, or the wake renders "unclaimed" about work that has an owner.
    const pipeline = Task.aggregate.mock.calls[0][0];
    expect(JSON.stringify(pipeline)).toContain('lapsedFrom');
  });
});

describe('sweep', () => {
  it('the empty case enqueues NOTHING — zero turns is the entire point', async () => {
    const result = await KernelWorkSweepService.sweep(NOW);

    expect(result.rescued).toBe(0);
    expect(result.woken).toBe(0);
    expect(mockNotifyFoundWork).not.toHaveBeenCalled();
  });

  it('wakes only pods that actually have actionable work, naming it', async () => {
    Task.aggregate.mockResolvedValue([
      { _id: POD_A, tasks: [{ taskId: 'TASK-007', title: 'stalled work' }], count: 1 },
    ]);

    const result = await KernelWorkSweepService.sweep(NOW);

    expect(mockNotifyFoundWork).toHaveBeenCalledTimes(1);
    const [podId, items, count] = mockNotifyFoundWork.mock.calls[0];
    expect(String(podId)).toBe(POD_A);
    expect(items[0].taskId).toBe('TASK-007');
    expect(count).toBe(1);
    expect(result.woken).toBe(1);
  });

  it('matches only NEWLY actionable rows — standing stock is never re-nagged', async () => {
    // fable's gate one. Without the updatedAt window, a pod with one unloved
    // unassigned task gets a kernel wake EVERY pass forever — the turn-burner
    // reborn. A task every seat declined once is deliberately unclaimed.
    Task.aggregate.mockResolvedValue([]);

    await KernelWorkSweepService.sweep(NOW);

    const [pipeline] = Task.aggregate.mock.calls[0];
    const match = pipeline[0].$match;
    expect(match.updatedAt).toBeDefined();
    expect(match.updatedAt.$gte).toEqual(new Date(NOW.getTime() - 10 * 60 * 1000));
    expect(match.status).toBe('pending');
  });

  it('names at most five items inline — a longer wake is a report, not a wake', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ taskId: `TASK-${i}`, title: `t${i}` }));
    Task.aggregate.mockResolvedValue([{ _id: POD_A, tasks: many, count: 9 }]);

    await KernelWorkSweepService.sweep(NOW);

    const [, items, count] = mockNotifyFoundWork.mock.calls[0];
    expect(items).toHaveLength(5);
    expect(count).toBe(9);
  });

  it('the kill switch stops everything without a deploy', async () => {
    process.env.AGENT_WORK_SWEEP_DISABLED = 'true';
    Task.aggregate.mockResolvedValue([{ _id: POD_A, tasks: [{ taskId: 'T' }], count: 1 }]);

    const result = await KernelWorkSweepService.sweep(NOW);

    expect(result).toEqual({
      scannedPods: 0, rescued: 0, deferred: 0, woken: 0, skippedNoWork: 0,
    });
    expect(Task.find).not.toHaveBeenCalled();
    expect(mockNotifyFoundWork).not.toHaveBeenCalled();
  });
});

describe('lapsed contract — the sweep and the claim CAS agree on what lapsed means', () => {
  // A SUBSET assertion, not toEqual: claimableConditions has four branches
  // (pending, self-renewal, and the two expiry ones); lapsedConditions is only
  // the expiry pair. Equality on the whole would simply always fail (fable,
  // 56080). The pin is that the sweep's definition deep-equals the LAST TWO
  // entries of the claim CAS's — same fields, same operators, same lease
  // arithmetic — so "claimable by a peer" and "rescued by the kernel" can
  // never quietly mean different things.
  //
  // Mutation-probed before shipping (fable, 56081): with the sweep's lease
  // constant changed to 31 minutes, this test went red on the claimedAt date.
  // It is not a test that can only pass.
  it('lapsedConditions deep-equals the two expiry branches of claimableConditions', () => {
    // eslint-disable-next-line global-require
    const { claimableConditions } = require('../../../routes/tasksApi');
    const now = new Date('2026-08-20T20:00:00Z');

    const sweep = KernelWorkSweepService.lapsedConditions(now);
    const cas = claimableConditions(now);

    expect(sweep).toEqual(cas.slice(-2));
  });
});
