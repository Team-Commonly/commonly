process.env.PG_HOST = '';
jest.mock('../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));
jest.mock('../../services/agentWebSocketService', () => ({ pushEvent: jest.fn() }));
jest.mock('../../services/agentDigestFoldService', () => ({ readFoldedDigest: jest.fn().mockResolvedValue(null), settleFoldedDigest: jest.fn().mockResolvedValue(undefined), foldExpiredDigests: jest.fn().mockResolvedValue(0) }));
const mongoose = require('mongoose');
const AgentEvent = require('../../models/AgentEvent');
const Service = require('../../services/agentEventService');
const { runAgent } = require('../../services/nativeRuntimeService');
const { setupMongoDb, clearMongoDb, closeMongoDb, waitFor } = require('../utils/testUtils');

// F52: the lane that keeps one agent's turns in a pod in order is per process.
// Two backend replicas each running native turns could start two at once.
const podId = new mongoose.Types.ObjectId();
const install = { agentName: 'clerk', instanceId: 'default', runtimeType: 'internal', podId };
const input = { agentName: 'clerk', podId, type: 'test.turn', payload: { content: 'work' } };
const success = { status: 'succeeded', runId: 'run', totalTurns: 1 };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

// One backend process: its own in-process state, as a second pod has its own.
const replica = (overrides = {}) => {
  class Replica extends Service {}
  Object.assign(Replica, {
    inProcessDraining: false, inProcessDrain: undefined, inProcessRequeued: 0,
    inProcessWork: new Set(), inProcessRunning: new Map(), inProcessLanes: new Map(), inProcessLaneHolders: new Map(),
    inProcessLaneWaitMs: 180000, inProcessLaneRefreshMs: 30000,
    inProcessQueueTimer: undefined, inProcessQueuePolling: false,
    ...overrides,
  });
  return Replica;
};
const web = () => replica({ nativeTurnsOnWorker: true });

let active; let maxActive; let ran; let turns;
beforeAll(setupMongoDb);
beforeEach(async () => {
  active = 0; maxActive = 0; ran = []; turns = [];
  jest.clearAllMocks(); await clearMongoDb();
  jest.spyOn(Service, 'resolveInProcessInstallation').mockResolvedValue(install);
  runAgent.mockImplementation(async (_installation, { eventId }) => {
    active += 1; maxActive = Math.max(maxActive, active); ran.push(String(eventId));
    const turn = deferred(); turns.push(turn);
    await turn.promise;
    active -= 1;
    return success;
  });
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeMongoDb);

const settle = () => new Promise((done) => { setTimeout(done, 50); });
const finish = async (n) => {
  for (let i = 0; i < n; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    await waitFor(() => turns.length > i);
    turns[i].resolve();
  }
};

test('one lane on two web replicas never runs two turns at once (F52)', async () => {
  const webA = web(); const webB = web(); const worker = replica();
  const first = await webA.enqueue(input);
  const second = await webB.enqueue(input);
  await settle();
  // Each web replica running its own turn is F52: two at once in one lane.
  expect(maxActive).toBeLessThanOrEqual(1);
  expect(runAgent).not.toHaveBeenCalled();

  await worker.pollInProcessQueue();
  await finish(2);
  await waitFor(() => worker.inProcessWork.size === 0);
  expect(maxActive).toBe(1);
  expect(ran).toEqual([String(first._id), String(second._id)]);
  expect((await AgentEvent.findById(first._id)).status).toBe('acked');
  expect((await AgentEvent.findById(second._id)).status).toBe('acked');
});

test('a web replica hands a native turn over unclaimed and runs nothing', async () => {
  const event = await web().enqueue(input);
  await settle();
  expect(runAgent).not.toHaveBeenCalled();
  expect(await AgentEvent.findById(event._id).lean())
    .toMatchObject({ status: 'pending', inProcessQueued: true, attempts: 0, deliveryNonce: null });
});

test("the worker's own turns share the lane with the ones it is handed", async () => {
  const webA = web(); const worker = replica();
  // A heartbeat the worker's scheduler enqueues runs where it is enqueued.
  const own = await worker.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  const handed = await webA.enqueue(input);
  await worker.pollInProcessQueue();
  await settle();
  expect(runAgent).toHaveBeenCalledTimes(1);
  await finish(2);
  await waitFor(() => worker.inProcessWork.size === 0);
  expect(maxActive).toBe(1);
  expect(ran).toEqual([String(own._id), String(handed._id)]);
});

test('a pass and a second worker never run one handed turn twice', async () => {
  const event = await web().enqueue(input);
  const first = replica(); const second = replica();
  const counts = await Promise.all([first.pollInProcessQueue(), second.pollInProcessQueue()]);
  expect(counts.sort()).toEqual([0, 1]);
  await finish(1);
  await waitFor(() => first.inProcessWork.size === 0 && second.inProcessWork.size === 0);
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'acked', attempts: 1 });
});

test('a draining worker hands an unfinished turn to the next one', async () => {
  const event = await web().enqueue(input);
  const old = replica();
  await old.pollInProcessQueue();
  await waitFor(() => runAgent.mock.calls.length === 1);
  await expect(old.drainInProcess(20)).resolves.toEqual({ timedOut: true, requeued: 1 });
  expect(await AgentEvent.findById(event._id).lean())
    .toMatchObject({ status: 'pending', inProcessQueued: true, deliveryNonce: null });

  const next = replica();
  await next.pollInProcessQueue();
  await waitFor(() => runAgent.mock.calls.length === 2);
  turns[1].resolve();
  await waitFor(() => next.inProcessWork.size === 0);
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
  // The old process's late success cannot settle the replacement's delivery.
  turns[0].resolve();
  await waitFor(() => old.inProcessWork.size === 0);
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
});

test('a handed turn whose agent no longer runs in-process leaves the queue', async () => {
  const event = await web().enqueue(input);
  Service.resolveInProcessInstallation.mockResolvedValue(null);
  const worker = replica();
  await expect(worker.pollInProcessQueue()).resolves.toBe(0);
  expect(runAgent).not.toHaveBeenCalled();
  const row = await AgentEvent.findById(event._id).lean();
  expect(row.status).toBe('pending');
  expect(row.inProcessQueued).toBeUndefined();
});

test('a lookup that fails keeps the turn queued for the next pass', async () => {
  const event = await web().enqueue(input);
  Service.resolveInProcessInstallation.mockRejectedValueOnce(new Error('mongo blip'));
  const worker = replica();
  await expect(worker.pollInProcessQueue()).resolves.toBe(0);
  expect((await AgentEvent.findById(event._id).lean()).inProcessQueued).toBe(true);
  await expect(worker.pollInProcessQueue()).resolves.toBe(1);
  await finish(1);
  await waitFor(() => worker.inProcessWork.size === 0);
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
});

test('a Start on a web replica hands what waited to the worker', async () => {
  // Enqueued while the agent was stopped: pending, not handed over.
  const waiting = await AgentEvent.create({ ...input, payload: { content: 'while stopped' } });
  jest.spyOn(Service, 'inProcessEventTargets').mockResolvedValue([{ agentName: 'clerk', instanceId: 'default', podId }]);
  const webA = web(); const worker = replica();
  await webA.rescuePendingForIdentity('clerk', 'default');
  await settle();
  expect(runAgent).not.toHaveBeenCalled();
  expect((await AgentEvent.findById(waiting._id).lean()).inProcessQueued).toBe(true);
  await expect(worker.pollInProcessQueue()).resolves.toBe(1);
  await finish(1);
  await waitFor(() => worker.inProcessWork.size === 0);
  expect((await AgentEvent.findById(waiting._id)).status).toBe('acked');
});

test('the queue polls on its interval and stops when the worker drains', async () => {
  const worker = replica({ inProcessQueuePollMs: 20 });
  worker.startInProcessQueue();
  const first = await web().enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  turns[0].resolve();
  await waitFor(() => worker.inProcessWork.size === 0);
  expect((await AgentEvent.findById(first._id)).status).toBe('acked');

  await worker.drainInProcess(1000);
  expect(worker.inProcessQueueTimer).toBeUndefined();
  const late = await web().enqueue(input);
  await settle();
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect((await AgentEvent.findById(late._id)).status).toBe('pending');
});

test('a web replica runs no queue', async () => {
  const webA = replica({ nativeTurnsOnWorker: true, inProcessQueuePollMs: 20 });
  webA.startInProcessQueue();
  expect(webA.inProcessQueueTimer).toBeUndefined();
  await web().enqueue(input);
  await expect(webA.pollInProcessQueue()).resolves.toBe(0);
  expect(runAgent).not.toHaveBeenCalled();
});
