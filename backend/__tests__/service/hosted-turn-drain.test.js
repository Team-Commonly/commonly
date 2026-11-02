process.env.PG_HOST = '';
jest.mock('../../services/nativeRuntimeService', () => ({ runAgent: jest.fn() }));
jest.mock('../../services/agentWebSocketService', () => ({ pushEvent: jest.fn() }));
jest.mock('../../services/agentDigestFoldService', () => ({ readFoldedDigest: jest.fn().mockResolvedValue(null), settleFoldedDigest: jest.fn().mockResolvedValue(undefined), foldExpiredDigests: jest.fn().mockResolvedValue(0) }));
const mongoose = require('mongoose');
const AgentEvent = require('../../models/AgentEvent');
const Service = require('../../services/agentEventService');
const { runAgent } = require('../../services/nativeRuntimeService');
const { setupMongoDb, clearMongoDb, closeMongoDb, waitFor } = require('../utils/testUtils');
const podId = new mongoose.Types.ObjectId();
const install = { agentName: 'clerk', instanceId: 'default', runtimeType: 'internal', podId };
const input = { agentName: 'clerk', podId, type: 'test.long-turn', payload: { content: 'work' } };
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const success = { status: 'succeeded', runId: 'run-long', totalTurns: 1 };
beforeAll(setupMongoDb);
beforeEach(async () => {
  // Simulate a fresh process for each rollout, without a production reset API.
  Service.inProcessRequeued = 0; Service.inProcessDraining = false; Service.inProcessDrain = undefined;
  Service.inProcessWork.clear(); Service.inProcessRunning.clear(); Service.inProcessLanes?.clear(); Service.inProcessLaneHolders?.clear();
  Service.inProcessLaneWaitMs = 180000;
  jest.clearAllMocks(); await clearMongoDb();
  jest.spyOn(Service, 'resolveInProcessInstallation').mockResolvedValue(install);
});
afterEach(() => jest.restoreAllMocks());
afterAll(closeMongoDb);

test('fake long turn is acked before drain resolves; new native events stay pending', async () => {
  const turn = deferred(); runAgent.mockReturnValue(turn.promise);
  const event = await Service.enqueue(input);
  await waitFor(() => runAgent.mock.calls.length === 1);
  let finished = false;
  const drain = Service.drainInProcess(2000).then((result) => { finished = true; return result; });
  expect(Service.isInProcessDraining()).toBe(true);
  const queued = await Service.enqueue(input);
  expect((await AgentEvent.findById(queued._id)).status).toBe('pending');
  expect(runAgent).toHaveBeenCalledTimes(1); expect(finished).toBe(false);
  turn.resolve(success);
  await expect(drain).resolves.toEqual({ timedOut: false, requeued: 0 });
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
  expect(await Service.rescueStrandedPendingInProcess(new Date(), 5)).toEqual({ rescued: 0, closed: 0 });
  expect(await Service.redispatchStuckInProcess(new Date(), 5)).toEqual({ redispatched: 0, acked: 0 });
});
test('deadline requeues only local turns; late success cannot ack a replacement', async () => {
  const turn = deferred(); runAgent.mockReturnValue(turn.promise);
  const event = await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
  const sibling = await AgentEvent.create({ ...input, status: 'delivered', deliveryNonce: 'sibling-nonce', attempts: 1 });
  await expect(Service.drainInProcess(20)).resolves.toEqual({ timedOut: true, requeued: 1 });
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'pending', deliveryNonce: null, attempts: 1 });
  expect((await AgentEvent.findById(sibling._id)).status).toBe('delivered');
  await AgentEvent.updateOne({ _id: event._id }, { $set: { status: 'delivered', deliveryNonce: 'replacement-nonce' } });
  turn.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'delivered', deliveryNonce: 'replacement-nonce' });
});
test('a create claim crossing SIGTERM is requeued without starting a model', async () => {
  const created = deferred(), release = deferred(), original = AgentEvent.create.bind(AgentEvent);
  jest.spyOn(AgentEvent, 'create').mockImplementationOnce(async (...args) => {
    const row = await original(...args); created.resolve(row); await release.promise; return row;
  });
  const enqueue = Service.enqueue(input), claimed = await created.promise;
  const drain = Service.drainInProcess(2000); release.resolve(); await enqueue;
  await expect(drain).resolves.toEqual({ timedOut: false, requeued: 1 });
  expect((await AgentEvent.findById(claimed._id)).status).toBe('pending'); expect(runAgent).not.toHaveBeenCalled();
});
test('a failed in-flight turn settles failure before drain completes', async () => {
  const turn = deferred(); runAgent.mockReturnValue(turn.promise);
  const event = await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
  const drain = Service.drainInProcess(2000); turn.resolve({ status: 'failed', error: 'provider refused' }); await drain;
  expect((await AgentEvent.findById(event._id)).status).toBe('failed');
});
test('deadline waits for sibling requeues before propagating a cleanup failure', async () => {
  const turn = deferred(), cleanup = deferred(), entered = deferred();
  runAgent.mockReturnValue(turn.promise);
  // Two pods, so both turns are in flight at once: one agent's turns in one pod run in order.
  await Service.enqueue(input); const second = await Service.enqueue({ ...input, podId: new mongoose.Types.ObjectId() });
  await waitFor(() => runAgent.mock.calls.length === 2);
  const original = AgentEvent.updateOne.bind(AgentEvent);
  jest.spyOn(AgentEvent, 'updateOne').mockImplementation((filter, update, ...rest) => {
    if (update.$set?.status !== 'pending') return original(filter, update, ...rest);
    if (String(filter._id) !== String(second._id)) return Promise.reject(new Error('first requeue failed'));
    entered.resolve();
    return cleanup.promise.then(() => original(filter, update, ...rest));
  });
  let settled = false;
  const drain = Service.drainInProcess(20).finally(() => { settled = true; });
  const rejection = expect(drain).rejects.toThrow('first requeue failed');
  await entered.promise; await new Promise((resolve) => setImmediate(resolve));
  expect(settled).toBe(false);
  cleanup.resolve(); await rejection;
  expect((await AgentEvent.findById(second._id)).status).toBe('pending');
  turn.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
});
test('SIGTERM during digest lookup requeues before runAgent starts', async () => {
  const entered = deferred(), release = deferred();
  const digest = require('../../services/agentDigestFoldService');
  digest.readFoldedDigest.mockImplementationOnce(async () => { entered.resolve(); await release.promise; return null; });
  const event = await Service.enqueue(input); await entered.promise;
  expect(Service.inProcessRunning.size).toBe(1);
  const drain = Service.drainInProcess(2000); release.resolve();
  await expect(drain).resolves.toEqual({ timedOut: false, requeued: 1 });
  expect((await AgentEvent.findById(event._id)).status).toBe('pending');
  expect(runAgent).not.toHaveBeenCalled();
});
test('deadline cleanup cannot steal a delivery reclaimed by a sibling', async () => {
  const turn = deferred(); runAgent.mockReturnValue(turn.promise);
  const event = await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
  await AgentEvent.updateOne({ _id: event._id }, { $set: { deliveryNonce: 'newer-owner' } });
  await expect(Service.drainInProcess(20)).resolves.toEqual({ timedOut: true, requeued: 0 });
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status: 'delivered', deliveryNonce: 'newer-owner' });
  turn.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
});


test('drain waits for the successful terminal write, not just the model promise', async () => {
  const ack = deferred(), entered = deferred(), original = Service.acknowledge.bind(Service);
  jest.spyOn(Service, 'acknowledge').mockImplementation(async (...args) => {
    entered.resolve(); await ack.promise; return original(...args);
  });
  runAgent.mockResolvedValue(success);
  const event = await Service.enqueue(input); await entered.promise;
  let complete = false;
  const drain = Service.drainInProcess(2000).then(() => { complete = true; });
  await Promise.resolve(); expect(complete).toBe(false);
  ack.resolve(); await drain;
  expect((await AgentEvent.findById(event._id)).status).toBe('acked');
});

test.each(['pending', 'delivered'])('SIGTERM during a %s recovery lookup prevents the claim', async (status) => {
  const entered = deferred(), release = deferred();
  Service.resolveInProcessInstallation.mockImplementation(async () => { entered.resolve(); await release.promise; return install; });
  jest.spyOn(Service, 'inProcessEventTargets').mockResolvedValue([{ agentName: 'clerk', instanceId: 'default', podId }]);
  const old = new Date(Date.now() - 5 * 60000);
  const event = await AgentEvent.create({ ...input, status, createdAt: old, deliveredAt: old, deliveryNonce: 'old-nonce', attempts: 1 });
  const sweep = status === 'pending'
    ? Service.rescueStrandedPendingInProcess(new Date(), 5)
    : Service.redispatchStuckInProcess(new Date(), 5);
  await entered.promise;
  const drain = Service.drainInProcess(2000); release.resolve(); await sweep; await drain;
  expect(await AgentEvent.findById(event._id).lean()).toMatchObject({ status, deliveryNonce: 'old-nonce', attempts: 1 });
  expect(runAgent).not.toHaveBeenCalled();
});

describe('one agent answers one pod a turn at a time', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  test('a second event for the same agent and pod starts after the first turn ends', async () => {
    const first = deferred(), second = deferred();
    runAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    await Service.enqueue(input); await settle();
    expect(runAgent).toHaveBeenCalledTimes(1);
    first.resolve(success); await waitFor(() => runAgent.mock.calls.length === 2);
    second.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
    expect(Service.inProcessLanes.size).toBe(0);
  });
  test('the same agent in another pod, or another agent in this pod, runs at once', async () => {
    const turn = deferred(); runAgent.mockReturnValue(turn.promise);
    await Service.enqueue(input);
    await Service.enqueue({ ...input, podId: new mongoose.Types.ObjectId() });
    await Service.enqueue({ ...input, agentName: 'scribe' });
    await waitFor(() => runAgent.mock.calls.length === 3);
    turn.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
  });
  test('a failed turn still hands the pod to the next one', async () => {
    runAgent.mockRejectedValueOnce(new Error('provider down')).mockResolvedValueOnce(success);
    await Service.enqueue(input); const next = await Service.enqueue(input);
    await waitFor(() => runAgent.mock.calls.length === 2);
    await waitFor(() => Service.inProcessWork.size === 0);
    expect((await AgentEvent.findById(next._id)).status).toBe('acked');
  });
  test('a waiting event reclaimed by the stuck sweep is left to its new owner', async () => {
    const first = deferred(); runAgent.mockReturnValueOnce(first.promise).mockResolvedValue(success);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    const waiting = await Service.enqueue(input); await settle();
    await AgentEvent.updateOne({ _id: waiting._id }, { $set: { deliveryNonce: 'sweep-nonce' } });
    first.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(await AgentEvent.findById(waiting._id).lean()).toMatchObject({ status: 'delivered', deliveryNonce: 'sweep-nonce' });
  });
  test('a re-check that cannot reach the database still runs the waiting turn', async () => {
    const first = deferred(); runAgent.mockReturnValueOnce(first.promise).mockResolvedValue(success);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    const waiting = await Service.enqueue(input); await settle();
    const original = AgentEvent.updateOne.bind(AgentEvent);
    let failed = false;
    jest.spyOn(AgentEvent, 'updateOne').mockImplementation((filter, update, ...rest) => {
      const recheck = update?.$set?.deliveredAt && !('status' in update.$set);
      if (recheck && !failed && String(filter._id) === String(waiting._id)) {
        failed = true; return Promise.reject(new Error('mongo unavailable'));
      }
      return original(filter, update, ...rest);
    });
    first.resolve(success); await waitFor(() => runAgent.mock.calls.length === 2);
    expect(failed).toBe(true);
    await waitFor(() => Service.inProcessWork.size === 0);
    expect((await AgentEvent.findById(waiting._id)).status).toBe('acked');
  });
  test('a turn that waited starts its own requeue clock when it starts', async () => {
    const first = deferred(), second = deferred();
    runAgent.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    const waiting = await Service.enqueue(input); await settle();
    const startedAt = new Date();
    first.resolve(success); await waitFor(() => runAgent.mock.calls.length === 2);
    expect((await AgentEvent.findById(waiting._id).lean()).deliveredAt.getTime()).toBeGreaterThanOrEqual(startedAt.getTime());
    expect(await Service.redispatchStuckInProcess(startedAt, 5)).toEqual({ redispatched: 0, acked: 0 });
    second.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
  });
  test('a turn that never ends holds the pod only for the wait cap', async () => {
    Service.inProcessLaneWaitMs = 100;
    const hung = deferred(); runAgent.mockReturnValueOnce(hung.promise).mockResolvedValue(success);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    const next = await Service.enqueue(input); await settle();
    expect(runAgent).toHaveBeenCalledTimes(1);
    await waitFor(() => runAgent.mock.calls.length === 2);
    await waitFor(async () => (await AgentEvent.findById(next._id)).status === 'acked');
    hung.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
  });
  test('with two turns that never end, the third still waits for the second', async () => {
    Service.inProcessLaneWaitMs = 200;
    const hungA = deferred(), hungB = deferred();
    runAgent.mockReturnValueOnce(hungA.promise).mockReturnValueOnce(hungB.promise).mockResolvedValue(success);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    await Service.enqueue(input); await Service.enqueue(input);
    await waitFor(() => runAgent.mock.calls.length === 2); await settle();
    expect(runAgent).toHaveBeenCalledTimes(2);
    await waitFor(() => runAgent.mock.calls.length === 3);
    hungA.resolve(success); hungB.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
  });
  test('a drain deadline requeues a turn still waiting for the pod, without starting it', async () => {
    const first = deferred(); runAgent.mockReturnValueOnce(first.promise);
    await Service.enqueue(input); await waitFor(() => runAgent.mock.calls.length === 1);
    const waiting = await Service.enqueue(input); await settle();
    await expect(Service.drainInProcess(20)).resolves.toEqual({ timedOut: true, requeued: 2 });
    expect((await AgentEvent.findById(waiting._id)).status).toBe('pending');
    first.resolve(success); await waitFor(() => Service.inProcessWork.size === 0);
    expect(runAgent).toHaveBeenCalledTimes(1);
  });
});
