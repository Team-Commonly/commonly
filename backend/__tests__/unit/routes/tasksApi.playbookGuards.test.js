const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

const POD = 'aaaaaaaaaaaaaaaaaaaaaaaa';
jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.userId = req.get('x-user') || 'owner';
  req.user = { _id: req.userId, username: req.userId, isBot: req.get('x-bot') === 'yes' };
  next();
});
jest.mock('../../../middleware/agentRuntimeAuth', () => (_req, _res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: () => ({ lean: async () => ({
  members: ['owner', 'peer', 'bot'].map((id) => ({ toString: () => id })),
}) }) }));
jest.mock('../../../models/User', () => ({ findById: () => ({ select: () => ({ lean: async () => ({ username: 'owner' }) }) }) }));
jest.mock('../../../services/agentSendFreshness', () => ({ unseenMessages: async () => null }));
jest.mock('../../../services/taskEventService', () => ({ emitTaskUpdated: jest.fn(), notifyPodAgents: jest.fn() }));
jest.mock('../../../services/attentionItemService', () => ({ recordTaskAttention: jest.fn(), resolveTaskAttention: jest.fn() }));
jest.mock('../../../services/systemActionLineService', () => ({ emitSystemActionLine: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../services/systemExchangeTriggers', () => ({ recordTaskCompleted: jest.fn() }));

const Task = require('../../../models/Task');
const { claimTaskWithRevision } = require('../../../services/taskMutationService');
const router = require('../../../routes/tasksApi');
const events = require('../../../services/taskEventService');
let mongo;
let app;
const seed = (overrides = {}) => Task.create({ podId: POD, taskId: 'TASK-001', taskNum: 1,
  title: 'Send manually', source: 'playbook', sourceRef: 'playbook:install:run:1',
  assignee: 'owner', guard: 'person', ...overrides });
const call = (action, user = 'owner', bot = false, body = {}) => request(app)
  .post(`/tasks/${POD}/TASK-001/${action}`).set('x-user', user).set('x-bot', bot ? 'yes' : 'no').send(body);
const ruling = (state) => ({ state, approvalId: new mongoose.Types.ObjectId() });

beforeAll(async () => {
  const { MongoMemoryServer } = require('mongodb-memory-server');
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  app = express(); app.use(express.json()); app.use('/tasks', router);
});
afterAll(async () => { await mongoose.disconnect(); await mongo.stop(); });
beforeEach(async () => { await Task.deleteMany({}); jest.clearAllMocks(); });

test.each(['awaiting', 'declined'])('%s ruling refuses claim on blocked row and completion without mutation', async (state) => {
  const row = await seed({ status: 'blocked', ruling: ruling(state) });
  for (const action of ['claim', 'complete']) {
    const res = await call(action);
    expect(res.status).toBe(409); expect(res.body.code).toBe('awaiting_ruling');
    expect(res.body.approvalId).toBe(String(row.ruling.approvalId));
  }
  expect(await Task.findById(row._id).lean()).toEqual(row.toObject());
  expect(events.emitTaskUpdated).not.toHaveBeenCalled();
});

test('approval unlocks the row; only the bound human can claim then complete it', async () => {
  await seed({ status: 'blocked', ruling: ruling('approved') });
  expect((await call('claim')).status).toBe(200);
  expect((await call('complete')).status).toBe(200);
  const row = await Task.findOne().lean();
  expect(row).toMatchObject({ status: 'done', completedBy: 'owner' });
});

test.each([['peer', false, 'playbook_assignee'], ['bot', true, 'task_guard']])('%s cannot move a person step', async (user, bot, code) => {
  await seed();
  for (const action of ['claim', 'complete']) {
    const res = await call(action, user, bot);
    expect(res.status).toBe(409); expect(res.body.code).toBe(code);
  }
  expect((await Task.findOne()).status).toBe('pending');
});

test.each(['owner', 'bot'])('kernel run rows refuse %s through both APIs', async (user) => {
  await seed({ guard: 'kernel', assignee: user });
  for (const action of ['claim', 'complete']) {
    expect((await call(action, user, user === 'bot')).body.code).toBe('task_guard');
  }
});

test('CAS refuses an unapproved step even without the route pre-read', async () => {
  await seed({ ruling: ruling('awaiting') });
  const result = await claimTaskWithRevision({ podId: POD, taskId: 'TASK-001' },
    { $set: { status: 'done' } }, { userId: 'owner', assignee: 'owner', isBot: false });
  expect(result).toBeNull(); expect((await Task.findOne()).status).toBe('pending');
});

test('completion cannot race a ruling back to awaiting after the advisory read', async () => {
  const row = await seed({ ruling: ruling('approved') });
  const write = Task.findOneAndUpdate.bind(Task);
  const hook = jest.spyOn(Task, 'findOneAndUpdate').mockImplementationOnce(async (...args) => {
    await Task.updateOne({ _id: row._id }, { $set: { 'ruling.state': 'awaiting' } });
    return write(...args);
  });
  const res = await call('complete'); hook.mockRestore();
  expect(res.status).toBe(409); expect(res.body.code).toBe('awaiting_ruling');
  expect((await Task.findById(row._id)).status).toBe('pending');
  expect(events.emitTaskUpdated).not.toHaveBeenCalled();
});

test.each([false, true])('reserved refs and source are refused before lookup (bot=%s)', async (bot) => {
  const row = await seed({ status: 'done' });
  const lookup = jest.spyOn(Task, 'findOne');
  for (const body of [{ source: 'playbook' }, { sourceRef: row.sourceRef }]) {
    const res = await request(app).post(`/tasks/${POD}`).set('x-bot', bot ? 'yes' : 'no')
      .send({ title: row.title, ...body });
    expect(res.status).toBe(409); expect(res.body.code).toBe('playbook_reserved');
  }
  expect(lookup).not.toHaveBeenCalled(); lookup.mockRestore();
  expect(events.emitTaskUpdated).not.toHaveBeenCalled();
});

test('guarded done rows cannot be reopened under an ordinary ref', async () => {
  await seed({ source: 'human', sourceRef: 'issue:1', status: 'done' });
  const res = await request(app).post(`/tasks/${POD}`).send({ title: 'Send manually', sourceRef: 'issue:1' });
  expect(res.status).toBe(409); expect((await Task.findOne()).status).toBe('done');
});

test('a reserved ref matching a pre-existing ordinary row still refuses without reopening it', async () => {
  const row = await seed({ source: 'human', guard: undefined, status: 'done' });
  const res = await request(app).post(`/tasks/${POD}`).send({ title: row.title, sourceRef: row.sourceRef });
  expect(res.status).toBe(409);
  expect(await Task.findById(row._id).lean()).toEqual(row.toObject());
  expect(events.notifyPodAgents).not.toHaveBeenCalled();
});

test('a normal ref keeps retry identity and reopens done rows without a stale completer', async () => {
  const row = await seed({ source: 'human', guard: undefined, sourceRef: 'issue:1', status: 'done', completedBy: 'prior' });
  const create = () => request(app).post(`/tasks/${POD}`).send({ title: row.title, sourceRef: row.sourceRef });
  expect((await create()).body.reopened).toBe(true);
  const retry = await create();
  expect(retry.body.alreadyExists).toBe(true); expect(retry.body.reopened).toBeUndefined();
  expect(await Task.countDocuments()).toBe(1);
  expect((await Task.findById(row._id)).completedBy).toBeUndefined();
});

test('PATCH cannot move a kernel run row and note updates cannot change a playbook priority', async () => {
  await seed({ guard: 'kernel' });
  expect((await request(app).patch(`/tasks/${POD}/TASK-001`).send({ status: 'blocked' })).body.code).toBe('task_guard');
  expect((await call('updates', 'owner', false, { text: 'Keep context', priority: 'P0' })).body.code).toBe('playbook_patch');
  expect((await Task.findOne()).status).toBe('pending');
});

test.each([{ title: 'Renamed' }, { assignee: 'peer' }, { status: 'done' }, { ruling: ruling('approved') }])('PATCH refuses playbook-owned fields: %j', async (body) => {
  const row = await seed();
  const res = await request(app).patch(`/tasks/${POD}/TASK-001`).send(body);
  expect(res.status).toBe(409);
  expect(await Task.findById(row._id).lean()).toEqual(row.toObject());
});

test('PATCH permits notes and blocking, but only the assignee may set prUrl', async () => {
  await seed();
  expect((await request(app).patch(`/tasks/${POD}/TASK-001`).send({ notes: 'Context', status: 'blocked' })).status).toBe(200);
  expect((await request(app).patch(`/tasks/${POD}/TASK-001`).set('x-user', 'peer').send({ prUrl: 'https://example.com/pr' })).status).toBe(409);
  expect((await request(app).patch(`/tasks/${POD}/TASK-001`).send({ prUrl: 'https://example.com/pr' })).status).toBe(200);
});

test('legacy unguarded tasks retain normal claim and completion', async () => {
  await seed({ source: 'human', guard: undefined, assignee: 'peer' });
  expect((await call('claim')).status).toBe(200);
  expect((await call('complete')).status).toBe(200);
});
