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
  AgentInstallation: { find: jest.fn() },
}));

const mockNotifyFoundWork = jest.fn();
jest.mock('../../../services/taskEventService', () => ({
  notifyFoundWork: (...args) => mockNotifyFoundWork(...args),
}));

const Task = require('../../../models/Task');
const KernelWorkSweepService = require('../../../services/kernelWorkSweepService');

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
});

describe('rescueLapsed', () => {
  it('rescues through a CAS whose filter carries the lapsed predicate', async () => {
    const t = lapsedTask();
    Task.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([t]) }),
    });
    Task.findOneAndUpdate.mockResolvedValue({ ...t, status: 'pending' });

    const rescued = await KernelWorkSweepService.rescueLapsed(NOW);

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

    const rescued = await KernelWorkSweepService.rescueLapsed(NOW);
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

    expect(result).toEqual({ scannedPods: 0, rescued: 0, woken: 0, skippedNoWork: 0 });
    expect(Task.find).not.toHaveBeenCalled();
    expect(mockNotifyFoundWork).not.toHaveBeenCalled();
  });
});
