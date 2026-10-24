const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
jest.mock('jsonwebtoken', () => ({}));
jest.mock('../../services/agentEventService', () => ({ enqueue: jest.fn().mockResolvedValue({}) }));
const Task = require('../../models/Task');
const User = require('../../models/User');
const AgentEvent = require('../../models/AgentEvent');
const AgentRun = require('../../models/AgentRun');
const AgentTaskWakeState = require('../../models/AgentTaskWakeState');
const { AgentInstallation } = require('../../models/AgentRegistry');
const AgentEventService = require('../../services/agentEventService');
const { dispatchAssignedTaskWakes } = require('../../services/assignedTaskWakeService');

const NOW = new Date('2026-10-24T11:00:00Z');
const minutesAgo = (minutes) => new Date(NOW.getTime() - minutes * 60000);
let podId;
let user;

async function completed(extra = {}, minutes = 6) {
  const at = minutesAgo(minutes);
  return AgentEvent.collection.insertOne({
    agentName: 'codex', instanceId: 'forge', podId,
    type: 'chat.mention', status: 'acked', deliveryMode: 'wake',
    delivery: { outcome: 'no_action', updatedAt: at },
    createdAt: at, updatedAt: at, ...extra,
  });
}

async function fixture() {
  podId = new mongoose.Types.ObjectId();
  user = await User.create({
    username: 'forge-wake-test', email: 'forge-wake@example.test', password: 'test-password',
    isBot: true, botType: 'agent',
    botMetadata: { agentName: 'codex', instanceId: 'forge' },
  });
  await AgentInstallation.create({
    agentName: 'codex', instanceId: 'forge', podId, version: '1', installedBy: user._id,
    config: { boardWake: { enabled: false } }, status: 'active',
  });
  await Task.create({ podId, taskNum: 1, taskId: 'TASK-1', title: 'Do the assigned work', assignee: 'forge' });
}

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  await fixture();
  AgentEventService.enqueue.mockReset().mockResolvedValue({});
});

it('wakes an assigned seat after five minutes, even with ambient board wake disabled', async () => {
  await completed({}, 5);
  expect(await dispatchAssignedTaskWakes(NOW)).toEqual({ eligible: 1, woken: 1 });
  expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
    agentName: 'codex', instanceId: 'forge', podId: String(podId), type: 'chat.mention',
    payload: expect.objectContaining({ triggerAuthor: 'kernel', assignedTaskWake: true }),
  }));
  expect(AgentEventService.enqueue.mock.calls[0][0].payload.content).toContain('TASK-1');
  expect(await AgentTaskWakeState.countDocuments()).toBe(1);
});

it('waits five minutes after the latest completed turn', async () => {
  await completed({}, 15);
  await completed({}, 4);
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
});

it('admits only one concurrent replica and caps the identity across pods for thirty minutes', async () => {
  const otherPod = new mongoose.Types.ObjectId();
  await AgentInstallation.create({ agentName: 'codex', instanceId: 'forge', podId: otherPod, version: '1', installedBy: user._id });
  await Task.create({ podId: otherPod, taskNum: 1, taskId: 'TASK-2', title: 'Other pod', assignee: 'forge' });
  await completed();
  const results = await Promise.all([dispatchAssignedTaskWakes(NOW), dispatchAssignedTaskWakes(NOW)]);
  expect(results.reduce((sum, result) => sum + result.woken, 0)).toBe(1);
  expect((await dispatchAssignedTaskWakes(new Date(NOW.getTime() + 29 * 60000))).woken).toBe(0);
  expect((await dispatchAssignedTaskWakes(new Date(NOW.getTime() + 30 * 60000))).woken).toBe(1);
});

it.each(['pending', 'folding', 'delivered'])('defers when a wake is %s in any pod', async (status) => {
  await completed();
  await AgentEvent.create({ agentName: 'codex', instanceId: 'forge', podId: new mongoose.Types.ObjectId(), type: 'chat.mention', status });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
  expect(await AgentTaskWakeState.countDocuments()).toBe(0);
});

it('does not mistake unread digest or another identity for a queued turn', async () => {
  await completed();
  await AgentEvent.create({ agentName: 'codex', instanceId: 'forge', podId, type: 'message.posted', deliveryMode: 'digest' });
  await AgentEvent.create({ agentName: 'codex', instanceId: 'other', podId, type: 'chat.mention' });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
});

it('defers while a native run is running', async () => {
  await completed();
  await AgentRun.create({ agentName: 'codex', instanceId: 'forge', podId, trigger: 'mention', status: 'running' });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
});

it.each([
  { status: 'blocked' }, { status: 'done' }, { assignee: 'other' },
  { status: 'claimed', claimedBy: 'other' }, { dep: 'TASK-MISSING' },
])('excludes non-actionable rows %j', async (change) => {
  await Task.updateOne({ podId }, { $set: change });
  await completed();
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
});

it('resolves ObjectId claim holders and completed dependencies', async () => {
  await Task.updateOne({ podId }, { $set: { status: 'claimed', claimedBy: String(user._id), assignee: null, dep: 'TASK-DEP' } });
  await Task.create({ podId, taskNum: 2, taskId: 'TASK-DEP', title: 'Dependency', status: 'done' });
  await completed({ delivery: { outcome: 'acknowledged', reason: 'native-runtime-completed', updatedAt: minutesAgo(6) } });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
});

it.each([
  { delivery: { outcome: 'no_action', reason: 'claim-held', updatedAt: minutesAgo(6) } },
  { delivery: { outcome: 'no_action', reason: 'native-no-turn', updatedAt: minutesAgo(6) } },
  { status: 'failed', delivery: { outcome: 'error', updatedAt: minutesAgo(6) } },
])('does not schedule from a skipped or failed delivery %j', async (event) => {
  await completed(event);
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
});

it('rechecks a completed row after reserving a wake', async () => {
  await completed();
  const reserve = AgentTaskWakeState.findOneAndUpdate.bind(AgentTaskWakeState);
  const spy = jest.spyOn(AgentTaskWakeState, 'findOneAndUpdate').mockImplementation(async (...args) => {
    const result = await reserve(...args);
    await Task.updateOne({ podId }, { $set: { status: 'done' } });
    return result;
  });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
  expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  expect(await AgentTaskWakeState.findOne({ lastWakeAt: { $exists: true } }).lean()).toBeNull();
  spy.mockRestore();
});

it.each(['pause', 'queued', 'new turn', 'dependency'])('rechecks %s after reserving', async (change) => {
  await completed();
  if (change === 'dependency') {
    await Task.updateOne({ podId }, { $set: { dep: 'TASK-DEP' } });
    await Task.create({ podId, taskNum: 2, taskId: 'TASK-DEP', title: 'Dependency', status: 'done' });
  }
  const reserve = AgentTaskWakeState.findOneAndUpdate.bind(AgentTaskWakeState);
  const spy = jest.spyOn(AgentTaskWakeState, 'findOneAndUpdate').mockImplementation(async (...args) => {
    const result = await reserve(...args);
    if (change === 'pause') await AgentInstallation.updateOne({ podId }, { $set: { status: 'paused' } });
    if (change === 'queued') await AgentEvent.create({ agentName: 'codex', instanceId: 'forge', podId, type: 'chat.mention' });
    if (change === 'new turn') await completed({}, 1);
    if (change === 'dependency') await Task.updateOne({ taskId: 'TASK-DEP' }, { $set: { status: 'blocked' } });
    return result;
  });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
  expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  expect(await AgentTaskWakeState.findOne({ lastWakeAt: { $exists: true } }).lean()).toBeNull();
  spy.mockRestore();
});

it('releases a failed preflight slot and continues to the next seat', async () => {
  await completed();
  const other = await User.create({
    username: 'other-wake-test', email: 'other-wake@example.test', password: 'test-password',
    isBot: true, botType: 'agent', botMetadata: { agentName: 'codex', instanceId: 'other' },
  });
  await AgentInstallation.create({ agentName: 'codex', instanceId: 'other', podId, version: '1', installedBy: other._id });
  await Task.create({ podId, taskNum: 2, taskId: 'TASK-2', title: 'Other seat', assignee: 'other' });
  await completed({ instanceId: 'other' });
  const originalExists = AgentInstallation.exists.bind(AgentInstallation);
  let failed = false;
  const exists = jest.spyOn(AgentInstallation, 'exists').mockImplementation((query) => {
    if (query.status === 'active' && query.instanceId === 'forge' && !failed) {
      failed = true;
      return Promise.reject(new Error('preflight unavailable'));
    }
    return originalExists(query);
  });
  const log = jest.spyOn(console, 'error').mockImplementation(() => {});
  try {
    expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
    expect(AgentEventService.enqueue.mock.calls[0][0].instanceId).toBe('other');
    expect((await AgentTaskWakeState.findById(JSON.stringify(['codex', 'forge'])).lean()).lastWakeAt).toBeUndefined();
    expect(log).toHaveBeenCalledWith('[assigned-task-wake] preflight failed:', expect.any(String), 'preflight unavailable');
  } finally {
    exists.mockRestore();
    log.mockRestore();
  }
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
  expect(AgentEventService.enqueue.mock.calls[1][0].instanceId).toBe('forge');
});

it('never wakes from an installation without the matching bot principal', async () => {
  await completed();
  await User.updateOne({ _id: user._id }, { $set: { 'botMetadata.instanceId': 'someone-else' } });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
});

it('uses the default agent name for assignments without waking a different instance', async () => {
  await User.updateOne({ _id: user._id }, { $set: { 'botMetadata.instanceId': 'default' } });
  await AgentInstallation.updateOne({ podId }, { $set: { instanceId: 'default' } });
  await Task.updateOne({ podId }, { $set: { assignee: 'CODEX' } });
  await completed({ instanceId: 'default' });
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
});

it('resolves legacy bot metadata without changing the stored delivery identity casing', async () => {
  await User.updateOne({ _id: user._id }, { $set: { 'botMetadata.agentName': 'CODEX', 'botMetadata.instanceId': 'FORGE' } });
  await completed();
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
  expect(AgentEventService.enqueue.mock.calls[0][0].instanceId).toBe('forge');
});

it('keeps the cap after an ambiguous enqueue failure', async () => {
  await completed();
  AgentEventService.enqueue.mockRejectedValueOnce(new Error('queue unavailable'));
  await expect(dispatchAssignedTaskWakes(NOW)).rejects.toThrow('queue unavailable');
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(0);
  expect((await dispatchAssignedTaskWakes(new Date(NOW.getTime() + 30 * 60000))).woken).toBe(1);
});

it.each(['claim-held', 'native-no-turn'])('keeps an earlier completion visible after a newer %s skip', async (reason) => {
  await completed({}, 15);
  await completed({ delivery: { outcome: 'no_action', reason, updatedAt: minutesAgo(1) } }, 1);
  expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
});

it('does not cancel a reserved continuation when a skip arrives during preflight', async () => {
  await completed({}, 15);
  const reserve = AgentTaskWakeState.findOneAndUpdate.bind(AgentTaskWakeState);
  const spy = jest.spyOn(AgentTaskWakeState, 'findOneAndUpdate').mockImplementation(async (...args) => {
    const result = await reserve(...args);
    await completed({ delivery: { outcome: 'no_action', reason: 'claim-held', updatedAt: minutesAgo(1) } }, 1);
    return result;
  });
  try {
    expect((await dispatchAssignedTaskWakes(NOW)).woken).toBe(1);
  } finally {
    spy.mockRestore();
  }
});
