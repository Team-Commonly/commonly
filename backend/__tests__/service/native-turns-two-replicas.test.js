process.env.PG_HOST = '';
jest.mock('../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));
jest.mock('../../services/agentWebSocketService', () => ({ pushEvent: jest.fn() }));
jest.mock('../../services/agentDigestFoldService', () => ({ readFoldedDigest: jest.fn().mockResolvedValue(null), settleFoldedDigest: jest.fn().mockResolvedValue(undefined), foldExpiredDigests: jest.fn().mockResolvedValue(0) }));
const mongoose = require('mongoose');
const AgentEvent = require('../../models/AgentEvent');
const SchedulerHeartbeatLease = require('../../models/SchedulerHeartbeatLease');
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
let replicas = 0;
let started = [];
const replica = (overrides = {}) => {
  class Replica extends Service {}
  replicas += 1;
  started.push(Replica);
  Object.assign(Replica, {
    inProcessDraining: false, inProcessDrain: undefined, inProcessRequeued: 0,
    inProcessWork: new Set(), inProcessRunning: new Map(), inProcessLanes: new Map(), inProcessLaneHolders: new Map(),
    inProcessLaneWaitMs: 180000, inProcessLaneRefreshMs: 30000,
    inProcessQueueTimer: undefined, inProcessQueuePolling: false,
    runnerId: `replica-${replicas}`, runnerEnforced: false, runnerLeaseUntil: 0, runnerRenewal: undefined,
    ...overrides,
  });
  return Replica;
};
const web = () => replica({ nativeTurnsOnWorker: true });

let active; let maxActive; let ran; let startedAt; let turns;
beforeAll(setupMongoDb);
beforeEach(async () => {
  active = 0; maxActive = 0; ran = []; startedAt = []; turns = [];
  jest.clearAllMocks(); await clearMongoDb();
  jest.spyOn(Service, 'resolveInProcessInstallation').mockResolvedValue(install);
  runAgent.mockImplementation(async (_installation, { eventId }) => {
    active += 1; maxActive = Math.max(maxActive, active); ran.push(String(eventId)); startedAt.push(Date.now());
    const turn = deferred(); turns.push(turn);
    await turn.promise;
    active -= 1;
    return success;
  });
});
afterEach(async () => {
  // A test that fails part-way must not leave work running into the next one.
  // A drain closes admission at once (a turn still waiting for its lane goes
  // back to the queue), waits for running turns, which the interval keeps
  // releasing, then stops the queue and awaits any renewal in flight. The poll
  // check covers a pass that had already started. Mocks stay until all of it ends.
  const release = setInterval(() => turns.forEach((turn) => turn.resolve()), 10);
  await Promise.allSettled(started.map((proc) => proc.drainInProcess(2000)));
  await waitFor(() => started.every((proc) => !proc.inProcessQueuePolling));
  clearInterval(release);
  started = [];
  jest.restoreAllMocks();
});
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
  const { deliveryNonce } = await AgentEvent.findById(event._id).lean();
  expect(deliveryNonce).toBeTruthy();
  // The old process's late success cannot settle the replacement's delivery.
  turns[0].resolve();
  await waitFor(() => old.inProcessWork.size === 0);
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'delivered', deliveryNonce });
  turns[1].resolve();
  await waitFor(() => next.inProcessWork.size === 0);
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
});

test('a turn a drain gives back before its lane gets its attempt back', async () => {
  const event = await AgentEvent.create({ ...input, instanceId: 'default', status: 'delivered', deliveryNonce: 'claim', attempts: 1 });
  const old = replica({ inProcessDraining: true });
  old.dispatchInProcess(event.toObject(), install, 'clerk', 'default', input.type);
  await waitFor(() => old.inProcessWork.size === 0);
  expect(runAgent).not.toHaveBeenCalled();
  expect(await AgentEvent.findById(event._id).lean())
    .toMatchObject({ status: 'pending', deliveryNonce: null, attempts: 0 });
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

// The runner lease: where the queue runs, one process at a time runs turns.
const runner = (id, overrides = {}) => replica({ runnerId: id, inProcessQueuePollMs: 20, ...overrides });
const holds = (proc) => Date.now() < proc.runnerLeaseUntil;
const stop = async (...procs) => { for (const proc of procs) await proc.drainInProcess(1000); };

test('a replacement worker waits for a draining one before it runs a lane', async () => {
  // An eviction, a node drain or a spot reclaim: the ReplicaSet starts the
  // replacement while the old pod is still finishing its turn.
  const old = runner('old'); old.startInProcessQueue();
  await waitFor(() => holds(old));
  const first = await web().enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  const draining = old.drainInProcess(5000);
  const next = runner('next'); next.startInProcessQueue();
  const second = await web().enqueue(input);
  await settle(); await settle();
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(holds(next)).toBe(false);

  turns[0].resolve();
  await draining;
  await waitFor(() => runAgent.mock.calls.length === 2);
  turns[1].resolve();
  await waitFor(() => next.inProcessWork.size === 0);
  expect(maxActive).toBe(1);
  expect(ran).toEqual([String(first._id), String(second._id)]);
  await stop(next);
});

// A short lease: turns may start in the first 300 ms after each write.
const short = { runnerLeaseMs: 1000, runnerTurnBoundMs: 600, runnerSkewMs: 100 };

test('a runner that died holding the lease is replaced once it expires', async () => {
  const dead = runner('dead', short); dead.startInProcessQueue();
  await waitFor(() => holds(dead));
  dead.stopInProcessQueue(); // SIGKILL: no drain, no release
  await dead.runnerRenewal; // a renewal already sent still lands, and moves the expiry
  const { expiresAt } = await SchedulerHeartbeatLease.findById('native-turn-runner').lean();
  const next = runner('next', short); next.startInProcessQueue();
  const event = await web().enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1, { timeout: 3000 });
  // Measured against the lease itself, not a fixed wait a slow runner outlasts.
  expect(startedAt[0]).toBeGreaterThanOrEqual(expiresAt.getTime());
  turns[0].resolve();
  await waitFor(() => next.inProcessWork.size === 0);
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
  await stop(next);
});

test('a single-process rolling deploy never runs one lane in two pods', async () => {
  const before = runner('before'); before.startInProcessQueue();
  await waitFor(() => holds(before));
  const own = await before.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  const after = runner('after'); after.startInProcessQueue();
  // Routed to the new pod while the old one still holds the lease.
  const routed = await after.enqueue(input);
  await settle();
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect((await AgentEvent.findById(routed._id).lean()).inProcessQueued).toBe(true);
  turns[0].resolve();
  await waitFor(() => runAgent.mock.calls.length === 2);
  turns[1].resolve();
  await stop(before);
  await waitFor(() => holds(after));
  const later = await after.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 3);
  turns[2].resolve();
  await waitFor(() => after.inProcessWork.size === 0);
  expect(maxActive).toBe(1);
  expect(ran).toEqual([String(own._id), String(routed._id), String(later._id)]);
  await stop(after);
});

test("a drained runner's unfinished turns keep the mark, its own included", async () => {
  const proc = runner('proc'); proc.startInProcessQueue();
  await waitFor(() => holds(proc));
  const own = await proc.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  await expect(proc.drainInProcess(20)).resolves.toEqual({ timedOut: true, requeued: 1 });
  expect(await AgentEvent.findById(own._id).lean()).toMatchObject({ status: 'pending', inProcessQueued: true });
  // Its turn may still be running, so it does not hand the lease over.
  expect(await SchedulerHeartbeatLease.findById('native-turn-runner').lean()).toMatchObject({ ownerId: 'proc' });
  turns[0].resolve();
});

test('after a timed-out drain the next runner waits for the lease to run out', async () => {
  const slow = runner('slow', short); slow.startInProcessQueue();
  await waitFor(() => holds(slow));
  const event = await slow.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  await slow.drainInProcess(20);
  const { expiresAt } = await SchedulerHeartbeatLease.findById('native-turn-runner').lean();
  // Within its bound, as every turn is, but it left no succeeded run: the pod
  // was killed before it answered. So the next holder answers it.
  turns[0].resolve();
  const next = runner('next', short); next.startInProcessQueue();
  await waitFor(() => runAgent.mock.calls.length === 2, { timeout: 3000 });
  expect(startedAt[1]).toBeGreaterThanOrEqual(expiresAt.getTime());
  expect(ran).toEqual([String(event._id), String(event._id)]);
  turns[1].resolve();
  await waitFor(() => next.inProcessWork.size === 0);
  expect(maxActive).toBe(1);
  await stop(next);
});

test('a requeued turn that already answered is acked, not answered again', async () => {
  const AgentRun = require('../../models/AgentRun');
  const slow = runner('slow', short); slow.startInProcessQueue();
  await waitFor(() => holds(slow));
  const event = await slow.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  await slow.drainInProcess(20);
  // It answered after its drain gave up on it.
  await AgentRun.create({
    podId, agentName: 'clerk', instanceId: 'default', trigger: 'mention', triggerEventId: event._id, status: 'succeeded',
  });
  turns[0].resolve();
  const next = runner('next', short); next.startInProcessQueue();
  await waitFor(async () => (await AgentEvent.findById(event._id)).status === 'acked', { timeout: 3000 });
  expect(runAgent).toHaveBeenCalledTimes(1);
  await stop(next);
});

test('a turn that waited out its lane past the lease goes back to the queue', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const holder = runner('holder', short); holder.startInProcessQueue();
  await waitFor(() => holds(holder));
  const first = await holder.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  const second = await holder.enqueue(input); // waits behind the first in its lane
  const write = jest.spyOn(SchedulerHeartbeatLease, 'findOneAndUpdate').mockRejectedValue(new Error('no primary'));
  await waitFor(() => !holds(holder));
  turns[0].resolve();
  await waitFor(async () => (await AgentEvent.findById(second._id)).status === 'pending');
  await settle();
  expect(runAgent).toHaveBeenCalledTimes(1);
  // Queued again, with the attempt it never used given back.
  expect(await AgentEvent.findById(second._id).lean()).toMatchObject({ inProcessQueued: true, attempts: 0 });
  write.mockRestore();
  await waitFor(() => runAgent.mock.calls.length === 2);
  turns[1].resolve();
  await waitFor(() => holder.inProcessWork.size === 0);
  expect(maxActive).toBe(1);
  expect(ran).toEqual([String(first._id), String(second._id)]);
  await stop(holder);
});

test('the lease keeps renewing while a queue pass is blocked', async () => {
  await web().enqueue(input);
  // Hold the pass inside its lookup until the test lets it go.
  const gate = deferred();
  let lookups = 0;
  jest.spyOn(Service, 'resolveInProcessInstallation').mockImplementation(async () => {
    lookups += 1;
    await gate.promise;
    return install;
  });
  const expiry = async () => (await SchedulerHeartbeatLease.findById('native-turn-runner').lean())?.expiresAt?.getTime();
  const proc = runner('busy', short); proc.startInProcessQueue();
  await waitFor(() => lookups === 1);
  const blockedAt = await expiry();
  // The stored expiry moves forward behind a pass that has not.
  await waitFor(async () => (await expiry()) > blockedAt);
  expect(lookups).toBe(1);
  expect(await SchedulerHeartbeatLease.findById('native-turn-runner').lean()).toMatchObject({ ownerId: 'busy' });
  gate.resolve();
  await waitFor(() => runAgent.mock.calls.length === 1);
  turns[0].resolve();
  await waitFor(() => proc.inProcessWork.size === 0);
  await stop(proc);
});

test('a runner that cannot write its lease stops starting turns until it can', async () => {
  jest.spyOn(console, 'warn').mockImplementation(() => {});
  const cut = runner('cut', short); cut.startInProcessQueue();
  await waitFor(() => holds(cut));
  const write = jest.spyOn(SchedulerHeartbeatLease, 'findOneAndUpdate').mockRejectedValue(new Error('no primary'));
  await waitFor(() => !holds(cut));
  const event = await cut.enqueue(input);
  await settle(); await settle();
  expect(runAgent).not.toHaveBeenCalled();
  expect((await AgentEvent.findById(event._id).lean()).inProcessQueued).toBe(true);
  write.mockRestore();
  await waitFor(() => runAgent.mock.calls.length === 1);
  turns[0].resolve();
  await waitFor(() => cut.inProcessWork.size === 0);
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
  await stop(cut);
});

test('an external poller never sees a handed turn', async () => {
  const { pushEvent } = require('../../services/agentWebSocketService');
  const event = await web().enqueue(input);
  await expect(Service.list({ agentName: 'clerk', instanceId: 'default', podId })).resolves.toEqual([]);
  expect((await AgentEvent.findById(event._id)).status).toBe('pending');
  expect(pushEvent).not.toHaveBeenCalled();
});

test('a handed turn at the attempt cap leaves the queue to the sweep, which closes it with a reason', async () => {
  const old = new Date(Date.now() - 31 * 60 * 1000);
  const capped = await AgentEvent.create({ ...input, inProcessQueued: true, attempts: 3, createdAt: old });
  jest.spyOn(Service, 'inProcessEventTargets').mockResolvedValue([{ agentName: 'clerk', instanceId: 'default', podId }]);
  const worker = replica();
  await expect(worker.pollInProcessQueue()).resolves.toBe(0);
  await expect(worker.rescueStrandedPendingInProcess(new Date(), 3)).resolves.toEqual({ rescued: 0, closed: 1 });
  const row = await AgentEvent.findById(capped._id).lean();
  expect(row.status).toBe('failed');
  expect(row.error).toMatch(/stranded/);
  expect(runAgent).not.toHaveBeenCalled();
});

test('the queue and the sweep in one worker never both run one row', async () => {
  const event = await AgentEvent.create({ ...input, inProcessQueued: true, createdAt: new Date(Date.now() - 2 * 60 * 1000) });
  jest.spyOn(Service, 'inProcessEventTargets').mockResolvedValue([{ agentName: 'clerk', instanceId: 'default', podId }]);
  const worker = replica();
  await Promise.all([worker.pollInProcessQueue(), worker.rescueStrandedPendingInProcess(new Date(), 3)]);
  await finish(1);
  await waitFor(() => worker.inProcessWork.size === 0);
  expect(runAgent).toHaveBeenCalledTimes(1);
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'acked', attempts: 1 });
});

test('a web replica runs no queue', async () => {
  const webA = replica({ nativeTurnsOnWorker: true, inProcessQueuePollMs: 20 });
  webA.startInProcessQueue();
  expect(webA.inProcessQueueTimer).toBeUndefined();
  await web().enqueue(input);
  await expect(webA.pollInProcessQueue()).resolves.toBe(0);
  expect(runAgent).not.toHaveBeenCalled();
});
