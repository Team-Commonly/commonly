const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../services/outboundUrlGuard', () => ({ postToPublicAddress: jest.fn() }));
const { postToPublicAddress } = require('../../services/outboundUrlGuard');
const Task = require('../../models/Task');
const User = require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const { dispatchAssignedTaskWakes } = require('../../services/assignedTaskWakeService');

async function awaitAck(id) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const event = await AgentEvent.findById(id).lean();
    if (event.status === 'acked') return event;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Webhook did not acknowledge event');
}

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(clearMongoDb);

it.each([
  [{ outcome: 'no_action', reason: 'claim-held' }, 0],
  [{ outcome: 'no_action' }, 1],
  [{ outcome: 'acknowledged' }, 1],
])('uses the persisted webhook result %j to decide continuation', async (response, expected) => {
  const podId = new mongoose.Types.ObjectId();
  const user = await User.create({
    username: 'forge-webhook-test', email: 'forge-webhook@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'forge' },
  });
  await AgentInstallation.create({
    agentName: 'codex', instanceId: 'forge', podId, version: '1', installedBy: user._id,
    config: { runtime: { runtimeType: 'webhook', webhookUrl: 'https://example.test/events' } }, status: 'active',
  });
  await Task.create({ podId, taskNum: 1, taskId: 'TASK-1', title: 'Assigned work', assignee: 'forge' });
  postToPublicAddress.mockResolvedValue({ ok: true, status: 200, text: JSON.stringify(response) });
  const event = await AgentEventService.enqueue({
    agentName: 'codex', instanceId: 'forge', podId: String(podId), type: 'chat.mention',
  });
  const completed = await awaitAck(event._id);
  const now = new Date(new Date(completed.delivery.updatedAt).getTime() + 6 * 60000);
  expect((await dispatchAssignedTaskWakes(now)).woken).toBe(expected);
  expect(completed.delivery.reason).toBe(response.reason);
  const continuation = await AgentEvent.findOne({ 'payload.assignedTaskWake': true }).lean();
  expect(Boolean(continuation)).toBe(Boolean(expected));
  if (continuation) await awaitAck(continuation._id);
});

it.each(['removed', 'replaced'])('does not trust a legacy webhook completion after its runtime is %s', async (change) => {
  const podId = new mongoose.Types.ObjectId();
  const user = await User.create({
    username: 'legacy-webhook', email: 'legacy-webhook@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'forge' },
  });
  await AgentInstallation.create({
    agentName: 'codex', instanceId: 'forge', podId, version: '1', installedBy: user._id,
    config: { runtime: { webhookUrl: 'https://example.test/events' } }, status: 'active',
  });
  await Task.create({ podId, taskNum: 1, taskId: 'TASK-1', title: 'Assigned work', assignee: 'forge' });
  const completedAt = new Date(Date.now() - 6 * 60000);
  await AgentEvent.collection.insertOne({
    agentName: 'codex', instanceId: 'forge', podId, type: 'chat.mention', status: 'acked',
    delivery: { outcome: 'no_action', updatedAt: completedAt },
    createdAt: completedAt, updatedAt: completedAt,
  });
  if (change === 'removed') {
    await AgentInstallation.updateOne({ podId }, { $unset: { 'config.runtime': 1 } });
  } else {
    await AgentInstallation.updateOne({ podId }, { $set: { 'config.runtime': { runtimeType: 'cli' } } });
  }
  expect((await dispatchAssignedTaskWakes()).woken).toBe(0);
  expect(await AgentEvent.countDocuments({ 'payload.assignedTaskWake': true })).toBe(0);
});

it('persists a fresh CLI silent completion through acknowledge and restores continuation', async () => {
  const podId = new mongoose.Types.ObjectId();
  const user = await User.create({
    username: 'cli-completion', email: 'cli-completion@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'forge' },
  });
  await AgentInstallation.create({
    agentName: 'codex', instanceId: 'forge', podId, version: '1', installedBy: user._id, status: 'active',
  });
  await Task.create({ podId, taskNum: 1, taskId: 'TASK-1', title: 'Assigned work', assignee: 'forge' });
  const event = await AgentEvent.create({
    agentName: 'codex', instanceId: 'forge', podId, type: 'chat.mention', status: 'delivered',
    deliveryNonce: 'test-nonce',
  });
  await AgentEventService.acknowledge(String(event._id), 'codex', 'forge', { outcome: 'no_action' }, 'test-nonce');
  const completed = await awaitAck(event._id);
  expect(completed.delivery.reasonRecorded).toBe(true);
  const now = new Date(new Date(completed.delivery.updatedAt).getTime() + 6 * 60000);
  expect((await dispatchAssignedTaskWakes(now)).woken).toBe(1);
  expect(await AgentEvent.countDocuments({ 'payload.assignedTaskWake': true })).toBe(1);
});
