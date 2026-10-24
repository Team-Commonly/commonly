process.env.PG_HOST = '';
process.env.JWT_SECRET = 'task-priority-service-test';

jest.mock('../../services/taskEventService', () => ({
  ...jest.requireActual('../../services/taskEventService'),
  notifyPodAgents: jest.fn().mockResolvedValue(undefined),
}));
const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const Task = require('../../models/Task');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const AgentEvent = require('../../models/AgentEvent');
const { migrateTaskPriority } = require('../../scripts/migrate-task-priority');
const { setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken } = require('../utils/testUtils');
const routes = require('../../routes/tasksApi');
const { bindSocketIO } = require('../../services/taskEventService');

let pod;
let token;
const app = express();
app.use(express.json());
app.use('/api/v1/tasks', routes);
beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  const owner = await User.create({ username: 'priority-owner', email: 'priority@test.com', password: 'Password123!', verified: true });
  token = generateTestToken(owner._id);
  pod = await Pod.create({ name: 'Priority pod', type: 'team', createdBy: owner._id, members: [owner._id] });
});
const api = () => `/api/v1/tasks/${pod._id}`;

test('create, edit and list use validated P0–P3 and priority order', async () => {
  const normal = await request(app).post(api()).set('Authorization', `Bearer ${token}`).send({ title: 'Normal' }).expect(201);
  expect(normal.body.task.priority).toBe('P2');
  await request(app).post(api()).set('Authorization', `Bearer ${token}`).send({ title: 'Urgent', priority: 'P0' }).expect(201);
  await request(app).post(api()).set('Authorization', `Bearer ${token}`).send({ title: 'Bad', priority: { $ne: null } }).expect(400);
  await request(app).patch(`${api()}/${normal.body.task.taskId}`).set('Authorization', `Bearer ${token}`).send({ priority: 'P1' }).expect(200);
  await request(app).patch(`${api()}/${normal.body.task.taskId}`).set('Authorization', `Bearer ${token}`).send({ priority: 'critical' }).expect(400);
  const list = await request(app).get(api()).set('Authorization', `Bearer ${token}`).expect(200);
  expect(list.body.tasks.map((row) => row.priority)).toEqual(['P0', 'P1']);
});

test('migration copies prefixes silently, preserves explicit priority/revisions and is rerunnable', async () => {
  const at = new Date('2026-10-01T00:00:00Z');
  const rows = [
    { taskId: 'TASK-1', title: '[P0] Urgent' },
    { taskId: 'TASK-2', title: 'Ordinary' },
    { taskId: 'TASK-3', title: '[P3] Explicit', priority: 'P1' },
    { taskId: 'TASK-4', title: '[P0] Finished', status: 'done' },
  ].map((row, i) => ({ _id: new mongoose.Types.ObjectId(), podId: pod._id, taskNum: i + 1, status: 'pending', createdAt: at, updatedAt: at, offeredAt: at, updates: [], ...row }));
  await Task.collection.insertMany(rows);
  const before = await AgentEvent.countDocuments({});
  const emit = jest.fn();
  bindSocketIO({ to: () => ({ emit }) });
  expect(await migrateTaskPriority()).toEqual({ matched: 3, modified: 0 });
  expect((await Task.collection.findOne({ taskId: 'TASK-1' })).title).toBe('[P0] Urgent');
  expect(await migrateTaskPriority(false)).toEqual({ matched: 3, modified: 3 });
  expect(await migrateTaskPriority(false)).toEqual({ matched: 0, modified: 0 });
  const migrated = await Task.collection.find({ podId: pod._id }).sort({ taskNum: 1 }).toArray();
  expect(migrated.map((row) => [row.title, row.priority])).toEqual([
    ['Urgent', 'P0'], ['Ordinary', 'P2'], ['Explicit', 'P1'], ['[P0] Finished', undefined],
  ]);
  for (const row of migrated) {
    expect(row.updatedAt).toEqual(at);
    expect(row.offeredAt).toEqual(at);
    expect(row.updates).toEqual([]);
  }
  expect(await AgentEvent.countDocuments({})).toBe(before);
  expect(emit).not.toHaveBeenCalled();
  bindSocketIO(null);
});

test('self-follow is idempotent and preserves task revisions without waking agents', async () => {
  const row = await Task.create({ podId: pod._id, taskId: 'TASK-1', taskNum: 1, title: 'Watch me' });
  const before = await AgentEvent.countDocuments({});
  const watch = `${api()}/TASK-1/watch`;
  for (let i = 0; i < 2; i += 1) {
    await request(app).post(watch).set('Authorization', `Bearer ${token}`).send({ following: true, userId: new mongoose.Types.ObjectId() }).expect(200);
  }
  const followed = await Task.findById(row._id).lean();
  expect(followed.watchers.map(String)).toEqual([String(pod.createdBy)]);
  expect(followed.updatedAt).toEqual(row.updatedAt);
  const stranger = await User.create({ username: 'stranger', email: 'stranger@test.com', password: 'Password123!', verified: true });
  await request(app).post(watch).set('Authorization', `Bearer ${generateTestToken(stranger._id)}`).send({ following: true }).expect(403);
  await request(app).post(watch).set('Authorization', `Bearer ${token}`).send({ following: false }).expect(200);
  expect((await Task.findById(row._id)).watchers).toHaveLength(0);
  expect(await AgentEvent.countDocuments({})).toBe(before);
});

test('note updates can change priority and reject invalid values', async () => {
  const row = await Task.create({ podId: pod._id, taskId: 'TASK-1', taskNum: 1, title: 'Prioritize me' });
  await request(app).post(`${api()}/TASK-1/updates`).set('Authorization', `Bearer ${token}`).send({ text: 'Urgent', priority: 'P0' }).expect(200);
  expect((await Task.findById(row._id)).priority).toBe('P0');
  await request(app).post(`${api()}/TASK-1/updates`).set('Authorization', `Bearer ${token}`).send({ text: 'Invalid', priority: 0 }).expect(400);
});

test('viewer members can follow, while a DM observer still cannot subscribe', async () => {
  await Task.create({ podId: pod._id, taskId: 'TASK-1', taskNum: 1, title: 'Read-only work' });
  // Exercise the role-bearing membership shape supported by the route helper.
  await Pod.collection.updateOne({ _id: pod._id }, { $set: { members: [{ userId: pod.createdBy, role: 'viewer' }] } });
  await request(app).post(`${api()}/TASK-1/watch`).set('Authorization', `Bearer ${token}`).send({ following: true }).expect(200);
  await request(app).patch(`${api()}/TASK-1`).set('Authorization', `Bearer ${token}`).send({ priority: 'P0' }).expect(403);
  const DMService = require('../../services/dmService');
  const observerAccess = jest.spyOn(DMService, 'canViewPod').mockResolvedValue(true);
  const observer = await User.create({ username: 'observer', email: 'observer@test.com', password: 'Password123!', verified: true });
  try {
    await request(app).post(`${api()}/TASK-1/watch`).set('Authorization', `Bearer ${generateTestToken(observer._id)}`).send({ following: true }).expect(403);
    expect(observerAccess).not.toHaveBeenCalled();
  } finally { observerAccess.mockRestore(); }
});
