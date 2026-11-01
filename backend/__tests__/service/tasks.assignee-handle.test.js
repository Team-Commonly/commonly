// F45: an agent has three names (board name, @mention username, agentName). The
// wake matches the board name, so the board stores that spelling whichever one
// was typed, and keeps anything else as typed.
process.env.PG_HOST = '';
process.env.JWT_SECRET = 'task-assignee-handle-test';

jest.mock('../../services/taskEventService', () => ({
  ...jest.requireActual('../../services/taskEventService'),
  notifyPodAgents: jest.fn().mockResolvedValue(undefined),
}));
const express = require('express');
const request = require('supertest');
const Task = require('../../models/Task');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken } = require('../utils/testUtils');
const routes = require('../../routes/tasksApi');

let pod;
let token;
const app = express();
app.use(express.json());
app.use('/api/v1/tasks', routes);

const bot = (username, agentName, instanceId) => User.create({
  username, email: `${username}@example.test`, password: 'Password123!', isBot: true, botType: 'agent', botMetadata: { agentName, instanceId },
});

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await clearMongoDb();
  const owner = await User.create({ username: 'assign-owner', email: 'assign-owner@example.test', password: 'Password123!', verified: true });
  const pat = await User.create({ username: 'pat', email: 'pat@example.test', password: 'Password123!', verified: true });
  // A person whose username is also an agent's agentName.
  const scoutPerson = await User.create({ username: 'scout', email: 'scout@example.test', password: 'Password123!', verified: true });
  const agents = await Promise.all([
    bot('cto-walk-1016-cto-walk', 'cto-walk-1016', 'cto-walk'),
    bot('rivet', 'rivet', 'default'),
    bot('openclaw-pixel', 'openclaw', 'pixel'),
    bot('openclaw-nova', 'openclaw', 'nova'),
    bot('scout-scout-1', 'scout', 'scout-1'),
  ]);
  token = generateTestToken(owner._id);
  pod = await Pod.create({
    name: 'Assignee pod', type: 'team', createdBy: owner._id, members: [owner._id, pat._id, scoutPerson._id, ...agents.map((a) => a._id)],
  });
});

const api = () => `/api/v1/tasks/${pod._id}`;
const create = async (assignee) => (await request(app).post(api()).set('Authorization', `Bearer ${token}`)
  .send({ title: `Row for ${assignee}`, assignee }).expect(201)).body.task;

describe('an assignee that names one agent is stored as its board name', () => {
  test.each([
    ['its @mention handle', '@cto-walk-1016-cto-walk', 'cto-walk'],
    ['its handle without the @', 'cto-walk-1016-cto-walk', 'cto-walk'],
    ['its agentName, when only it carries that name', 'cto-walk-1016', 'cto-walk'],
    ['its board name in other case', 'CTO-Walk', 'cto-walk'],
    ['its board name with an @', '@rivet', 'rivet'],
    ['the handle of one of two agents sharing an agentName', 'openclaw-pixel', 'pixel'],
  ])('%s', async (_label, typed, stored) => {
    const task = await create(typed);
    expect(task.assignee).toBe(stored);
    expect((await Task.findById(task._id).lean()).assignee).toBe(stored);
  });
});

describe('anything else is kept as typed', () => {
  test.each([
    ['an agentName two agents share', 'openclaw'],
    ['a person in the pod', 'pat'],
    ['a person whose username is also an agentName', 'scout'],
    ['a name nobody in the pod has', 'someone-else'],
  ])('%s', async (_label, typed) => {
    expect((await create(typed)).assignee).toBe(typed);
  });
});

test('a PATCH reassigning by handle stores the board name and says so in the history', async () => {
  const task = await create('pat');
  const res = await request(app).patch(`${api()}/${task.taskId}`).set('Authorization', `Bearer ${token}`)
    .send({ assignee: '@openclaw-nova' }).expect(200);
  expect(res.body.task.assignee).toBe('nova');
  const saved = await Task.findById(task._id).lean();
  expect(saved.assignee).toBe('nova');
  expect(saved.updates.at(-1).text).toMatch(/reassigned to nova/);
});

describe('the list filter reads an assignee the way the writers store it', () => {
  test.each([
    ['the handle the row was assigned by', '@cto-walk-1016-cto-walk'],
    ['the handle without the @', 'cto-walk-1016-cto-walk'],
    ['the board name', 'cto-walk'],
  ])('%s finds the row', async (_label, filter) => {
    const task = await create('@cto-walk-1016-cto-walk');
    await create('pat');
    const res = await request(app).get(api()).query({ assignee: filter })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.tasks.map((t) => t.taskId)).toEqual([task.taskId]);
  });

  test('a person is still filtered by their username', async () => {
    await create('@rivet');
    const task = await create('pat');
    const res = await request(app).get(api()).query({ assignee: 'pat' })
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body.tasks.map((t) => t.taskId)).toEqual([task.taskId]);
  });
});
