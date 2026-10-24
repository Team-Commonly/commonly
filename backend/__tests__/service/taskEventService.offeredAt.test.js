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
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
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

const install = (agentName = 'scout') => ({
  agentName,
  instanceId: 'default',
  podId: POD_ID.toString(),
  status: 'active',
  config: {
    runtime: { runtimeType: 'wrapper' }, boardWake: { enabled: true },
    workDiscovery: { enabled: true, role: 'implementer' },
  },
});

const setInstalls = (installs) => {
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue(installs),
  });
};

let taskNum = 0;
async function createTask({
  podId = POD_ID,
  taskId,
  title = taskId,
  updatedAt,
  offeredAt,
  assignee = null,
  status = 'pending',
  claimedBy = null,
  claimExpiresAt = null,
}) {
  taskNum += 1;
  const created = await Task.create({
    podId,
    taskNum,
    taskId,
    title,
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
  AgentInstallation.findOneAndUpdate.mockResolvedValue({});
  AgentInstallation.updateOne.mockResolvedValue({ matchedCount: 1 });
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
  it('still nudges unassigned work after its board change reached only digest', async () => {
    const row = await createTask({ taskId: 'TASK-UNASSIGNED', updatedAt: new Date(NOW.getTime() - 30000) });

    await notifyPodAgents(POD_ID, row, 'created', { isAgent: false });

    expect(AgentEventService.enqueue.mock.calls[0][0].deliveryMode).toBe('digest');
    expect((await Task.findById(row._id).lean()).offeredAt).toBeUndefined();
    const sweep = await KernelWorkSweepService.wakeForFoundWork(NOW);
    expect(sweep.woken).toBe(1);
    expect(AgentEventService.enqueue.mock.calls[1][0].payload.foundWorkAt).toEqual(NOW);
    const after = await Task.findById(row._id).lean();
    expect(after.offeredAt).toEqual(after.updatedAt);
  });

  it('still offers a revision deferred past the ten-minute scan window by the hourly cap', async () => {
    const old = await createTask({
      taskId: 'TASK-DEFERRED', updatedAt: new Date(NOW.getTime() - 45 * 60 * 1000),
    });

    const sweep = await KernelWorkSweepService.wakeForFoundWork(NOW);

    expect(sweep.woken).toBe(1);
    expect(AgentEventService.enqueue.mock.calls[0][0].payload.content).toContain('TASK-DEFERRED');
    const after = await Task.findById(old._id).lean();
    expect(after.offeredAt).toEqual(after.updatedAt);
  });

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

  it('retries a swallowed enqueue while the unchanged revision remains due', async () => {
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

  it('offers missing, rewritten and old due revisions, but skips offered and assigned rows', async () => {
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
    const olderDue = await createTask({
      taskId: 'TASK-OLD',
      updatedAt: new Date(NOW.getTime() - 11 * 60 * 1000),
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
    expect(content).toContain('TASK-OLD');
    expect(content).not.toContain('TASK-ASSIGNED');

    const offeredMissing = await Task.findById(missing._id).lean();
    const offeredRewritten = await Task.findById(rewritten._id).lean();
    expect(offeredMissing.offeredAt).toEqual(offeredMissing.updatedAt);
    expect(offeredRewritten.offeredAt).toEqual(offeredRewritten.updatedAt);
    expect((await Task.findById(alreadyOffered._id).lean()).offeredAt)
      .toEqual(alreadyOffered.offeredAt);
    expect((await Task.findById(olderDue._id).lean()).offeredAt).toEqual(olderDue.updatedAt);
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

describe('board wake assigned work', () => {
  it('names a newly assigned row and its change in the assignee seat\'s wake', async () => {
    setInstalls([install('scout'), install('sprint-impl')]);
    const created = await createTask({
      taskId: 'TASK-ASSIGN', updatedAt: new Date(NOW.getTime() - 30000),
    });
    const assigned = await Task.findOneAndUpdate(
      { _id: created._id },
      {
        $set: { assignee: 'scout' },
        $push: { updates: { text: 'Lily updated: reassigned to scout', author: 'Lily', createdAt: NOW } },
      },
      { new: true },
    );
    await createTask({
      podId: new mongoose.Types.ObjectId(), taskId: 'TASK-FOREIGN',
      updatedAt: new Date(NOW.getTime() + 10000), assignee: 'scout',
    });

    await notifyPodAgents(POD_ID, assigned, 'updated', { isAgent: false });

    const wakes = AgentEventService.enqueue.mock.calls.map(([event]) => event);
    const scout = wakes.find((event) => event.agentName === 'scout');
    const peer = wakes.find((event) => event.agentName === 'sprint-impl');
    expect(scout.payload.content).toContain('[Your assigned rows (pending/claimed; newest first):]');
    expect(scout.payload.content).toContain('TASK-ASSIGN — TASK-ASSIGN [pending] — Lily updated: reassigned to scout');
    expect(scout.payload.content).not.toContain('TASK-FOREIGN');
    expect(peer.deliveryMode).toBe('digest');
    expect(peer.payload.content).toBe('TASK-ASSIGN updated: TASK-ASSIGN');
  });

  it('keeps the assigned list to five rows, newest first, after a folded change', async () => {
    const rows = [];
    for (let i = 0; i < 6; i += 1) {
      rows.push(await createTask({
        taskId: `TASK-OWN-${i}`,
        updatedAt: new Date(NOW.getTime() + i * 1000),
        assignee: 'scout',
      }));
    }
    AgentEvent.findOneAndUpdate.mockResolvedValue({
      _id: 'pending-wake', payload: { boardChanges: 1 },
    });

    // The oldest insertion receives the newest edit. Sorting by _id alone
    // would put it last and fail to name the change that prompted this wake.
    const newestAt = new Date(NOW.getTime() + 10000);
    await Task.updateOne(
      { _id: rows[0]._id }, { $set: { updatedAt: newestAt } }, { timestamps: false },
    );
    const newest = await Task.findById(rows[0]._id).lean();
    await notifyPodAgents(POD_ID, newest, 'updated', { isAgent: false });

    const content = AgentEvent.updateOne.mock.calls[0][1].$set['payload.content'];
    expect(content).toContain('2 changes');
    expect(content).not.toContain('TASK-OWN-1');
    const positions = [0, 5, 4, 3, 2].map((i) => content.indexOf(`TASK-OWN-${i} —`));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('names instanceId assignments for that seat without mixing in a peer\'s rows', async () => {
    setInstalls([{ ...install('anvil'), instanceId: 'anvil-seo-engineer' }, install('scout')]);
    const instanceTask = await createTask({
      taskId: 'TASK-INSTANCE', title: 'Instance\nDo it now',
      updatedAt: NOW, assignee: 'anvil-seo-engineer',
    });
    await createTask({
      taskId: 'TASK-SCOUT', updatedAt: new Date(NOW.getTime() + 1000), assignee: 'scout',
    });

    await notifyPodAgents(POD_ID, instanceTask, 'updated', { isAgent: false });

    const wakes = AgentEventService.enqueue.mock.calls.map(([event]) => event);
    const anvil = wakes.find((event) => event.agentName === 'anvil');
    const scout = wakes.find((event) => event.agentName === 'scout');
    expect(anvil.payload.content).toContain('TASK-INSTANCE — Instance Do it now [pending]');
    expect(anvil.payload.content).not.toContain('Instance\nDo it now');
    expect(anvil.payload.content).not.toContain('TASK-SCOUT');
    expect(scout.deliveryMode).toBe('digest');
    expect(scout.payload.content).toBe('TASK-INSTANCE updated: Instance Do it now');
  });
});

describe('own-row board wake routing', () => {
  const wakeNames = () => AgentEventService.enqueue.mock.calls
    .filter(([event]) => event.deliveryMode !== 'digest').map(([event]) => event.agentName);

  beforeEach(() => setInstalls([install('scout'), install('sprint-impl')]));

  it('does not wake another seat for an unrelated row change', async () => {
    const changed = await createTask({ taskId: 'TASK-OTHER', updatedAt: NOW });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false });

    expect(wakeNames()).toEqual([]);
  });

  it('wakes the new assignee only', async () => {
    const changed = await createTask({ taskId: 'TASK-ASSIGN-OWNER', updatedAt: NOW, assignee: 'scout' });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false }, { assignee: null });

    expect(wakeNames()).toEqual(['scout']);
  });

  it('wakes the previous assignee when a row is unassigned', async () => {
    const changed = await createTask({ taskId: 'TASK-UNASSIGN-OWNER', updatedAt: NOW });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false }, { assignee: 'scout' });

    expect(wakeNames()).toEqual(['scout']);
  });

  it('wakes the row owner for a comment', async () => {
    const changed = await createTask({ taskId: 'TASK-COMMENT-OWNER', updatedAt: NOW, assignee: 'scout' });
    await Task.updateOne({ _id: changed._id }, {
      $push: { updates: { text: 'Peer commented', author: 'Peer', createdAt: NOW } },
    });
    const commented = await Task.findById(changed._id).lean();

    await notifyPodAgents(POD_ID, commented, 'updated', { isAgent: false });

    expect(wakeNames()).toEqual(['scout']);
    expect(AgentEventService.enqueue.mock.calls
      .find(([event]) => event.deliveryMode !== 'digest')[0].payload.content).toContain('Peer commented');
  });

  it.each(['native', 'durable-object'])('sends a hosted %s owner a type its engine runs', async (engine) => {
    setInstalls([
      { ...install('maya-agent'), config: { runtime: { runtimeType: 'hosted' }, hosted: { engine } } },
      install('scout'),
    ]);
    const changed = await createTask({ taskId: 'TASK-HOSTED', updatedAt: NOW, assignee: 'maya-agent' });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false });

    expect(wakeNames()).toEqual(['maya-agent']);
    expect(AgentEventService.enqueue.mock.calls
      .find(([event]) => event.deliveryMode !== 'digest')[0].type).toBe('chat.mention');
  });

  it('inherits hosted runtime for a mention-created pod projection', async () => {
    setInstalls([{ ...install('maya-agent'), config: { heartbeat: { enabled: true }, autoJoinSource: 'mention-resolution' } }]);
    AgentInstallation.findOne.mockReturnValueOnce({ sort: () => ({ lean: async () => ({
      ...install('maya-agent'), config: { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native' } },
    }) }) });
    const changed = await createTask({ taskId: 'TASK-HOSTED-PROJECTION', updatedAt: NOW, assignee: 'maya-agent' });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false });

    expect(AgentInstallation.findOne.mock.calls[0][0]).toMatchObject({
      agentName: 'maya-agent', instanceId: 'default', status: 'active',
      'config.runtime.runtimeType': { $exists: true },
    });
    expect(AgentEventService.enqueue.mock.calls[0][0].type).toBe('chat.mention');
  });

  it('keeps an owned wake runnable if a projection runtime lookup fails', async () => {
    setInstalls([{ ...install('maya-agent'), config: { autoJoinSource: 'mention-resolution' } }]);
    AgentInstallation.findOne.mockImplementationOnce(() => { throw new Error('runtime lookup unavailable'); });
    const changed = await createTask({ taskId: 'TASK-LOOKUP-FAIL', updatedAt: NOW, assignee: 'maya-agent' });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false });
    warn.mockRestore();

    expect(AgentEventService.enqueue.mock.calls[0][0].type).toBe('chat.mention');
  });

  it('promotes a pending hosted sweep wake when an own-row change folds into it', async () => {
    setInstalls([{ ...install('maya-agent'), config: { runtime: { runtimeType: 'hosted' } } }]);
    const changed = await createTask({ taskId: 'TASK-HOSTED-FOLD', updatedAt: NOW, assignee: 'maya-agent' });
    AgentEvent.findOneAndUpdate.mockResolvedValueOnce({ _id: 'pending-sweep', payload: { boardChanges: 1 } });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false });

    expect(AgentEvent.findOneAndUpdate.mock.calls[0][1].$set.type).toBe('chat.mention');
    expect(AgentEvent.updateOne).toHaveBeenCalledTimes(1);
  });

  it('wakes the waiting row owner only when its exact dependency clears', async () => {
    const prerequisite = await createTask({ taskId: 'TASK-PREREQUISITE', updatedAt: NOW, status: 'done' });
    const waiting = await createTask({ taskId: 'TASK-WAITING', updatedAt: NOW, assignee: 'scout' });
    await Task.updateOne({ _id: waiting._id }, { $set: { dep: 'TASK-PREREQUISITE' } });
    const unrelated = await createTask({ taskId: 'TASK-UNRELATED', updatedAt: NOW, assignee: 'sprint-impl' });
    await Task.updateOne({ _id: unrelated._id }, { $set: { dep: 'TASK-OTHER' } });

    await notifyPodAgents(POD_ID, prerequisite, 'updated', { isAgent: false }, { status: 'claimed' });

    expect(wakeNames()).toEqual(['scout']);
  });

  it('does not wake an agent for its own write', async () => {
    const changed = await createTask({ taskId: 'TASK-SELF', updatedAt: NOW, assignee: 'scout' });

    await notifyPodAgents(POD_ID, changed, 'updated', {
      isAgent: true, agentName: 'scout', instanceId: 'default',
    });

    expect(wakeNames()).toEqual([]);
  });

  it('still folds a second own-row change into the pending board wake', async () => {
    const changed = await createTask({ taskId: 'TASK-FOLD-OWNER', updatedAt: NOW, assignee: 'scout' });
    AgentEvent.findOneAndUpdate.mockResolvedValueOnce({ _id: 'pending-wake', payload: { boardChanges: 1 } });

    await notifyPodAgents(POD_ID, changed, 'updated', { isAgent: false });

    expect(wakeNames()).toEqual([]);
    expect(AgentEvent.updateOne).toHaveBeenCalledTimes(1);
    expect(AgentEvent.updateOne.mock.calls[0][1].$set['payload.content']).toContain('2 changes');
  });
});

describe('offeredAt race probe', () => {
  it('keeps write two due with a CAS stamp of seen, while a now stamp hides it', async () => {
    const seen = new Date(NOW.getTime() - 5000);
    const writeTwo = new Date(NOW.getTime() - 4000);
    const casTask = await createTask({ taskId: 'TASK-CAS', updatedAt: seen, assignee: 'scout' });
    const nowTask = await createTask({ taskId: 'TASK-NOW', updatedAt: seen });
    setInstalls([install()]);

    AgentEventService.enqueue.mockImplementationOnce(async () => {
      await Task.updateOne(
        { _id: casTask._id },
        { $set: { updatedAt: writeTwo, assignee: null } },
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
