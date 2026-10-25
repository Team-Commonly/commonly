const { randomUUID } = require('crypto');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('../../services/toolBrokerService', () => ({ allToolDefinitions: () => [] }));
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { createOffPlaybook, setPlaybookOn } = require('../../services/playbooks/store');
const { startPlaybookRun } = require('../../services/playbooks/runState');
const { deliverPlaybookStep } = require('../../services/playbooks/delivery');
const { settleNativePlaybookStep } = require('../../services/playbooks/nativeSettle');
let pod; let root; let step; let wakes; let enqueue;
const propose = jest.fn(); const flag = process.env.PLAYBOOKS_ENABLED;
beforeAll(setupMongoDb); afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb(); process.env.PLAYBOOKS_ENABLED = 'true'; wakes = [];
  enqueue = jest.fn(async (event) => { wakes.push(event); });
  const human = await User.create({ username: 'owner', email: 'owner@example.test', password: 'test-password' });
  const agent = await User.create({ username: 'native-worker-worker', email: 'worker@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'native-worker', instanceId: 'worker' } });
  pod = await Pod.create({ name: 'Native workflow', members: [human._id, agent._id], createdBy: human._id });
  await AgentInstallation.create({ agentName: 'native-worker', instanceId: 'worker', version: '1', podId: pod._id,
    installedBy: human._id, config: { runtime: { runtimeType: 'native' } } });
  const installation = await createOffPlaybook(String(pod._id), String(human._id), { title: 'Post result', definition: {
    v: 1, roles: [{ key: 'worker', kind: 'agent' }],
    steps: [{ key: 'post', title: 'Post', role: 'worker', do: 'Post the result', delivers: 'post' }],
    done: [{ says: 'Posted', step: 'post', check: 'done' }],
  } });
  await setPlaybookOn(String(pod._id), String(human._id), String(installation._id), { worker: String(agent._id) }, true);
  ({ run: root, step } = await startPlaybookRun({ podId: String(pod._id), installationId: String(installation._id),
    userId: String(human._id), triggerKey: `manual:${randomUUID()}`, input: '', label: 'Run' }));
});
afterEach(() => { if (flag === undefined) delete process.env.PLAYBOOKS_ENABLED; else process.env.PLAYBOOKS_ENABLED = flag; });
const settle = (wake, result) => settleNativePlaybookStep(wake, result, enqueue, propose);
test('only the first delivery claims and wakes a native step, whose post completes the run', async () => {
  await Promise.all([deliverPlaybookStep(String(pod._id), step.taskId, enqueue, propose),
    deliverPlaybookStep(String(pod._id), step.taskId, enqueue, propose)]);
  expect(wakes).toHaveLength(1);
  expect((await Task.findById(step._id)).status).toBe('claimed');
  expect(await settle(wakes[0], { status: 'succeeded', postedMessageIds: ['post-1'] })).toBe(true);
  expect((await Task.findById(step._id)).status).toBe('done');
  expect((await Task.findById(root._id)).status).toBe('done');
});
test('no post retries once, rejects a stale first-attempt settle, then blocks', async () => {
  await deliverPlaybookStep(String(pod._id), step.taskId, enqueue, propose);
  await settle(wakes[0], { status: 'succeeded', postedMessageIds: [] });
  expect(wakes).toHaveLength(2);
  const retry = (await Task.findById(step._id)).toObject();
  expect(retry.status).toBe('claimed'); expect(retry.rescueDeferrals).toBe(1);
  await settle(wakes[0], { status: 'succeeded', postedMessageIds: ['late-post'] });
  expect((await Task.findById(step._id)).toObject()).toEqual(retry);
  await settle(wakes[1], { status: 'failed', postedMessageIds: [] });
  expect(wakes).toHaveLength(2);
  expect((await Task.findById(step._id)).status).toBe('blocked');
  expect((await Task.findById(root._id)).status).toBe('blocked');
});
test('a failed event enqueue releases its native claim so recovery can deliver it', async () => {
  await expect(deliverPlaybookStep(String(pod._id), step.taskId, async () => { throw new Error('queue down'); }, propose))
    .rejects.toThrow('queue down');
  const released = await Task.findById(step._id);
  expect(released.status).toBe('pending'); expect(released.offeredAt).toBeUndefined();
  await deliverPlaybookStep(String(pod._id), step.taskId, enqueue, propose);
  expect(wakes).toHaveLength(1);
});
