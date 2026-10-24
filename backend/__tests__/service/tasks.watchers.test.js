process.env.PG_HOST = '';
process.env.JWT_SECRET = 'task-watchers-service-test';
const express = require('express');
const request = require('supertest');
const Task = require('../../models/Task');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { hash } = require('../../utils/secret');
const { notifyPodAgents, retryTaskWatcherDigests } = require('../../services/taskEventService');
const routes = require('../../routes/tasksApi');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../utils/testUtils');
const app = express(); app.use(express.json()); app.use('/api/v1/tasks', routes);
beforeAll(setupMongoDb); afterAll(closeMongoDb); afterEach(clearMongoDb);

test('a bot follows, loses its active installation, and receives exactly one digest with no wake', async () => {
  const secret = 'cm_agent_follow_test';
  const bot = await User.create({ username: 'watcher-secondary', email: 'watcher@test.com', password: 'Password123!', verified: true, isBot: true, botType: 'agent', botMetadata: { agentName: 'watcher', instanceId: 'default' }, agentRuntimeTokens: [{ tokenHash: hash(secret), label: 'test', createdAt: new Date() }] });
  const pod = await Pod.create({ name: 'Watched pod', type: 'team', createdBy: bot._id, members: [bot._id] });
  const installation = await AgentInstallation.create({ agentName: 'watcher', instanceId: 'secondary', podId: pod._id, version: '1.0.0', installedBy: bot._id });
  const row = await Task.create({ podId: pod._id, taskId: 'TASK-1', taskNum: 1, title: 'Watch this', status: 'pending' });
  await request(app).post(`/api/v1/tasks/${pod._id}/TASK-1/watch`).set('Authorization', `Bearer ${secret}`).send({ following: true }).expect(200);
  expect(await AgentEvent.countDocuments({})).toBe(0);
  await AgentInstallation.updateOne({ _id: installation._id }, { $set: { status: 'paused' } });
  const changed = await Task.findByIdAndUpdate(row._id, { $set: { notes: 'Work moved' } }, { new: true }).lean();
  await notifyPodAgents(pod._id, changed, 'updated', { isAgent: false });
  const events = await AgentEvent.find({ podId: pod._id }).lean();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ agentName: 'watcher', instanceId: 'secondary', deliveryMode: 'digest', status: 'pending', payload: { taskId: 'TASK-1', boardDigest: true } });
  await AgentEvent.deleteMany({});
  await AgentInstallation.updateOne({ _id: installation._id }, { $set: { status: 'active' } });
  await notifyPodAgents(pod._id, changed, 'updated', { isAgent: false });
  expect(await AgentEvent.countDocuments({ podId: pod._id })).toBe(1);
  expect(await AgentEvent.countDocuments({ podId: pod._id, deliveryMode: { $ne: 'digest' } })).toBe(0);
  await AgentEvent.deleteMany({});
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: bot._id } });
  await AgentInstallation.updateOne({ _id: installation._id }, { $set: { status: 'paused' } });
  await notifyPodAgents(pod._id, changed, 'updated', { isAgent: false });
  expect(await AgentEvent.countDocuments({})).toBe(0);
});


test.each(['user', 'pod'])('failed %s lookup retains a durable retry, then rechecks membership without a wake', async (failingModel) => {
  const bot = await User.create({ username: 'waiting-bot', email: 'waiting@test.com', password: 'Password123!', isBot: true, botType: 'agent', botMetadata: { agentName: 'waiting-bot', instanceId: 'default' } });
  const pod = await Pod.create({ name: 'Retry receipts', type: 'team', createdBy: bot._id, members: [bot._id] });
  const task = await Task.create({ podId: pod._id, taskId: 'TASK-2', taskNum: 2, title: 'Still visible', status: 'claimed', claimedBy: String(bot._id), claimExpiresAt: new Date(Date.now() + 60000), watchers: [bot._id] });
  const original = task.toObject();
  const target = failingModel === 'user' ? User : Pod;
  const method = failingModel === 'user' ? 'find' : 'findById';
  const lookup = jest.spyOn(target, method).mockReturnValueOnce({ select: () => ({ lean: () => Promise.reject(new Error('temporary lookup outage')) }) });
  await notifyPodAgents(pod._id, original, 'updated', { isAgent: false });
  lookup.mockRestore();
  const pending = await Task.findById(task._id).lean();
  expect(pending.watcherDeliveryPendingAt).toEqual(original.updatedAt);
  expect(pending.updatedAt).toEqual(original.updatedAt);
  expect(pending.claimExpiresAt).toEqual(original.claimExpiresAt);
  expect(await AgentEvent.countDocuments({})).toBe(0);
  await retryTaskWatcherDigests();
  expect(await AgentEvent.countDocuments({ deliveryMode: 'digest' })).toBe(1);
  expect(await AgentEvent.countDocuments({ deliveryMode: { $ne: 'digest' } })).toBe(0);
  expect((await Task.findById(task._id).lean()).watcherDeliveryPendingAt).toBeUndefined();
  await retryTaskWatcherDigests();
  expect(await AgentEvent.countDocuments({})).toBe(1);
  await AgentEvent.deleteMany({});
  await Task.updateOne({ _id: task._id }, { $set: { watcherDeliveryPendingAt: original.updatedAt } }, { timestamps: false });
  await Pod.updateOne({ _id: pod._id }, { $pull: { members: bot._id } });
  await retryTaskWatcherDigests();
  expect(await AgentEvent.countDocuments({})).toBe(0);
  expect((await Task.findById(task._id).lean()).watcherDeliveryPendingAt).toBeUndefined();
});

test('a permanently failing batch cannot starve a newer watched task', async () => {
  const bot = await User.create({ username: 'batch-watcher', email: 'batch@test.com', password: 'Password123!', isBot: true, botType: 'agent', botMetadata: { agentName: 'batch-watcher', instanceId: 'default' } });
  const pod = await Pod.create({ name: 'Receipt fairness', type: 'team', createdBy: bot._id, members: [bot._id] });
  const revision = new Date('2030-01-01T00:00:00Z');
  await Task.insertMany(Array.from({ length: 101 }, (_, index) => ({ podId: pod._id, taskId: `TASK-${index + 1}`, taskNum: index + 1, title: 'Pending receipt', watchers: [bot._id], watcherDeliveryPendingAt: revision })));
  const AgentEventService = require('../../services/agentEventService');
  const enqueue = AgentEventService.enqueue.bind(AgentEventService);
  const failure = jest.spyOn(AgentEventService, 'enqueue').mockImplementation((event) => {
    if (event.payload.taskId !== 'TASK-101') return Promise.reject(new Error('permanent recipient failure'));
    return enqueue(event);
  });
  const warning = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await retryTaskWatcherDigests();
    expect(await AgentEvent.countDocuments({})).toBe(0);
    await retryTaskWatcherDigests();
    expect(await AgentEvent.countDocuments({ 'payload.taskId': 'TASK-101', deliveryMode: 'digest' })).toBe(1);
    expect(await AgentEvent.countDocuments({ deliveryMode: { $ne: 'digest' } })).toBe(0);
    expect(await Task.countDocuments({ watcherDeliveryPendingAt: { $type: 'date' } })).toBe(100);
  } finally { failure.mockRestore(); warning.mockRestore(); }
});
