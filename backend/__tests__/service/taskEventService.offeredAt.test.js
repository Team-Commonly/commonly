/**
 * offeredAt is a revision marker, not a delivery timestamp. These probes use
 * Mongo's real CAS and aggregation semantics because either error is silent:
 * a stale stamp can lose a wake, and a future stamp can hide one.
 */
/* eslint-disable import/no-unresolved, import/extensions */
const mongoose = require('mongoose');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../utils/testUtils');

jest.mock('../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

jest.mock('../../models/AgentEvent', () => ({
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

const mockBoardWakeEnabled = jest.fn(() => true);
jest.mock('../../services/agentMentionService', () => ({
  boardWakeEnabled: (...args) => mockBoardWakeEnabled(...args),
}));

const Task = require('../../models/Task');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const AgentEvent = require('../../models/AgentEvent');
const { notifyPodAgents } = require('../../services/taskEventService');
const KernelWorkSweepService = require('../../services/kernelWorkSweepService');

const POD_ID = new mongoose.Types.ObjectId();
const NOW = new Date('2026-08-20T20:00:00.000Z');
const SINCE = new Date(NOW.getTime() - 10 * 60 * 1000);

const install = (agentName = 'scout') => ({
  agentName,
  instanceId: 'default',
  podId: POD_ID.toString(),
  status: 'active',
  config: { boardWake: { enabled: true } },
});

const setInstalls = (installs) => {
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue(installs),
  });
};

let taskNum = 0;
async function createTask({
  taskId,
  updatedAt,
  offeredAt,
  assignee = null,
  status = 'pending',
  claimedBy = null,
  claimExpiresAt = null,
}) {
  taskNum += 1;
  const created = await Task.create({
    podId: POD_ID,
    taskNum,
    taskId,
    title: taskId,
    status,
    assignee,
    claimedBy,
    claimExpiresAt,
  });
  const set = { updatedAt };
  if (offeredAt) set.offeredAt = offeredAt;
  await Task.updateOne({ _id: created._id }, { $set: set }, { timestamps: false });
  return Task.findById(created._id).lean();
}

beforeAll(async () => {
  await setupMongoDb();
  await Task.init();
});

beforeEach(async () => {
  await clearMongoDb();
  jest.clearAllMocks();
  taskNum = 0;
  setInstalls([install()]);
  AgentEvent.findOneAndUpdate.mockResolvedValue(null);
  AgentEvent.updateOne.mockResolvedValue({});
  AgentEventService.enqueue.mockResolvedValue({});
  mockBoardWakeEnabled.mockReturnValue(true);
  AgentInstallation.findOne.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(null),
    }),
  });
});

afterAll(async () => {
  await clearMongoDb();
  await closeMongoDb();
});

describe('kernel sweep offeredAt filter', () => {
  it('keeps starter rows due until a Guide installation can receive them', async () => {
    const starter = await createTask({
      taskId: 'TASK-STARTER',
      updatedAt: new Date(NOW.getTime() - 30000),
    });
    setInstalls([]);

    const beforeInstall = await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(beforeInstall).toEqual({ woken: 0, skippedNoWork: 1, scannedPods: 1 });
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect((await Task.findById(starter._id).lean()).offeredAt).toBeUndefined();

    setInstalls([install('guide')]);
    const afterInstall = await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(afterInstall).toEqual({ woken: 1, skippedNoWork: 0, scannedPods: 1 });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const [{ payload: { content } }] = AgentEventService.enqueue.mock.calls[0];
    expect(content).toContain('TASK-STARTER');
    const afterOffer = await Task.findById(starter._id).lean();
    expect(afterOffer.offeredAt).toEqual(afterOffer.updatedAt);
  });

  it('retries a swallowed enqueue while the unchanged revision remains in the scan window', async () => {
    const task = await createTask({
      taskId: 'TASK-RETRY',
      updatedAt: new Date(NOW.getTime() - 30000),
    });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentEventService.enqueue.mockRejectedValueOnce(new Error('event store unavailable'));

    const first = await KernelWorkSweepService.wakeForFoundWork(NOW);
    warn.mockRestore();

    expect(first.woken).toBe(0);
    expect((await Task.findById(task._id).lean()).offeredAt).toBeUndefined();
    AgentEventService.enqueue.mockResolvedValueOnce({});

    const retry = await KernelWorkSweepService.wakeForFoundWork(NOW);

    expect(retry.woken).toBe(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
    const afterRetry = await Task.findById(task._id).lean();
    expect(afterRetry.offeredAt).toEqual(afterRetry.updatedAt);
  });

  it('offers missing/rewritten revisions, skips offered/out-of-window rows, and offers each once', async () => {
    const missing = await createTask({
      taskId: 'TASK-MISSING',
      updatedAt: new Date(NOW.getTime() - 30000),
    });
    const alreadyOffered = await createTask({
      taskId: 'TASK-OFFERED',
      updatedAt: new Date(NOW.getTime() - 25000),
      offeredAt: new Date(NOW.getTime() - 25000),
    });
    const rewritten = await createTask({
      taskId: 'TASK-REWRITTEN',
      updatedAt: new Date(NOW.getTime() - 20000),
      offeredAt: new Date(NOW.getTime() - 40000),
    });
    const outsideWindow = await createTask({
      taskId: 'TASK-OLD',
      updatedAt: new Date(SINCE.getTime() - 1),
    });
    const assigned = await createTask({
      taskId: 'TASK-ASSIGNED',
      updatedAt: new Date(NOW.getTime() - 15000),
      assignee: 'sprint-impl',
    });

    const first = await KernelWorkSweepService.wakeForFoundWork(NOW);

    expect(first).toEqual({ woken: 1, skippedNoWork: 0, scannedPods: 1 });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const [{ payload: { content } }] = AgentEventService.enqueue.mock.calls[0];
    expect(content).toContain('TASK-MISSING');
    expect(content).toContain('TASK-REWRITTEN');
    expect(content).not.toContain('TASK-OFFERED');
    expect(content).not.toContain('TASK-OLD');
    expect(content).not.toContain('TASK-ASSIGNED');

    const offeredMissing = await Task.findById(missing._id).lean();
    const offeredRewritten = await Task.findById(rewritten._id).lean();
    expect(offeredMissing.offeredAt).toEqual(offeredMissing.updatedAt);
    expect(offeredRewritten.offeredAt).toEqual(offeredRewritten.updatedAt);
    expect((await Task.findById(alreadyOffered._id).lean()).offeredAt)
      .toEqual(alreadyOffered.offeredAt);
    expect((await Task.findById(outsideWindow._id).lean()).offeredAt).toBeUndefined();
    expect((await Task.findById(assigned._id).lean()).offeredAt).toBeUndefined();

    const second = await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(second).toEqual({ woken: 0, skippedNoWork: 0, scannedPods: 0 });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });

  it('offers a rescued revision once after the rescue write advances updatedAt', async () => {
    const now = new Date(Date.now() + 5000);
    const priorRevision = new Date(now.getTime() - 30000);
    const lapsed = await createTask({
      taskId: 'TASK-RESCUED',
      updatedAt: priorRevision,
      offeredAt: priorRevision,
      status: 'claimed',
      assignee: 'sprint-impl',
      claimedBy: 'missing-seat',
      claimExpiresAt: new Date(now.getTime() - 1000),
    });

    const first = await KernelWorkSweepService.sweep(now);

    expect(first.rescued).toBe(1);
    expect(first.woken).toBe(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    const [{ payload: { content } }] = AgentEventService.enqueue.mock.calls[0];
    expect(content).toContain('TASK-RESCUED');
    const rescued = await Task.findById(lapsed._id).lean();
    expect(rescued.status).toBe('pending');
    expect(rescued.lapsedFrom).toBe('sprint-impl');
    expect(rescued.updatedAt.getTime()).toBeGreaterThan(priorRevision.getTime());
    expect(rescued.offeredAt).toEqual(rescued.updatedAt);

    const second = await KernelWorkSweepService.sweep(new Date(now.getTime() + 1000));
    expect(second.woken).toBe(0);
    expect(second.scannedPods).toBe(0);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('offeredAt race probe', () => {
  it('keeps write two due with a CAS stamp of seen, while a now stamp hides it', async () => {
    const seen = new Date(NOW.getTime() - 5000);
    const writeTwo = new Date(NOW.getTime() - 4000);
    const casTask = await createTask({ taskId: 'TASK-CAS', updatedAt: seen });
    const nowTask = await createTask({ taskId: 'TASK-NOW', updatedAt: seen });
    setInstalls([install()]);

    AgentEventService.enqueue.mockImplementationOnce(async () => {
      await Task.updateOne(
        { _id: casTask._id },
        { $set: { updatedAt: writeTwo } },
        { timestamps: false },
      );
    });
    await notifyPodAgents(POD_ID, casTask, 'updated', { isAgent: false });

    const afterWriteTwo = await Task.findById(casTask._id).lean();
    expect(afterWriteTwo.updatedAt).toEqual(writeTwo);
    expect(afterWriteTwo.offeredAt).toBeUndefined();

    await Task.updateOne(
      { _id: nowTask._id },
      { $set: { updatedAt: writeTwo, offeredAt: NOW } },
      { timestamps: false },
    );
    const due = await Task.aggregate([
      {
        $match: {
          _id: { $in: [casTask._id, nowTask._id] },
          updatedAt: { $gte: SINCE },
          $expr: { $lt: ['$offeredAt', '$updatedAt'] },
        },
      },
    ]);
    expect(due.map((row) => row.taskId)).toEqual(['TASK-CAS']);

    await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
    const afterOffer = await Task.findById(casTask._id).lean();
    expect(afterOffer.offeredAt).toEqual(writeTwo);

    await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(2);
  });
});
