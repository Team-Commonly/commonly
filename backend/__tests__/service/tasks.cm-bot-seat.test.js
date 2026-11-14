/**
 * F501: a bot holding a cm_ user token rides the human branch of auth
 * (middleware/auth.ts sets req.botCaller, never req.user.isBot). On the task
 * board it is still an agent: it is held to a peer seat's live lease, it gets
 * the freshness hold, and its board writes are priced as an agent's wake and
 * skip itself, exactly as on its cm_agent_ runtime token.
 */

process.env.PG_HOST = '';
process.env.JWT_SECRET = 'tasks-cm-bot-seat-test-secret';

jest.mock('../../services/taskEventService', () => {
  const actual = jest.requireActual('../../services/taskEventService');
  return { ...actual, notifyPodAgents: jest.fn().mockResolvedValue(undefined) };
});
jest.mock('../../services/systemActionLineService', () => ({
  emitSystemActionLine: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/agentSendFreshness', () => ({
  unseenMessages: jest.fn().mockResolvedValue(null),
}));

const express = require('express');
const request = require('supertest');
const Pod = require('../../models/Pod');
const Task = require('../../models/Task');
const User = require('../../models/User');
const { AgentInstallation } = require('../../models/AgentRegistry');
const { notifyPodAgents } = require('../../services/taskEventService');
const AgentSendFreshness = require('../../services/agentSendFreshness');
const tasksApiRoutes = require('../../routes/tasksApi');
const { hash } = require('../../utils/secret');
const {
  setupMongoDb, closeMongoDb, clearMongoDb, generateTestToken,
} = require('../utils/testUtils');

const PEER_RUNTIME = 'cm_agent_cm_bot_seat_peer_test';
const BOT_RUNTIME = 'cm_agent_cm_bot_seat_bot_test';
const BOT_USER = 'cm_cmbotseatusertoken00000000000000001';
const HOLD = { error: 'There are pod messages you have not read', code: 'unseen_messages' };

describe('F501: a member bot on a cm_ user token is a seat on the board', () => {
  let app;
  let owner; let bot; let peer; let pod; let ownerToken;

  const seat = (agentName, runtimeToken) => User.create({
    username: agentName,
    email: `${agentName}-${Date.now()}@agents.commonly.local`,
    password: 'Password123!',
    verified: true,
    isBot: true,
    botType: 'agent',
    botMetadata: { agentName, instanceId: 'default', displayName: agentName },
    agentRuntimeTokens: [{ tokenHash: hash(runtimeToken), label: agentName, createdAt: new Date() }],
  });

  beforeAll(async () => {
    await setupMongoDb();
    await Task.init();
    app = express();
    app.use(express.json());
    app.use('/api/v1/tasks', tasksApiRoutes);
  });

  beforeEach(async () => {
    await clearMongoDb();
    notifyPodAgents.mockClear();
    AgentSendFreshness.unseenMessages.mockReset().mockResolvedValue(null);
    owner = await User.create({
      username: `owner-${Date.now()}`, email: `owner-${Date.now()}@test.com`, password: 'Password123!', verified: true,
    });
    bot = await seat('cm-bot', BOT_RUNTIME);
    peer = await seat('peer-seat', PEER_RUNTIME);
    await User.updateOne({ _id: bot._id }, { $set: { apiTokenHash: hash(BOT_USER) } });
    pod = await Pod.create({
      name: 'Board', type: 'team', createdBy: owner._id, members: [owner._id, bot._id, peer._id], 
    });
    await Promise.all(['cm-bot', 'peer-seat'].map((agentName) => AgentInstallation.create({
      agentName, instanceId: 'default', podId: pod._id, version: '1.0.0', installedBy: owner._id,
    })));
    ownerToken = generateTestToken(owner._id);
    await Task.create({
      podId: pod._id, taskNum: 1, taskId: 'TASK-001', title: 'the row', status: 'pending', 
    });
  });

  afterAll(async () => {
    await clearMongoDb();
    await closeMongoDb();
  });

  const base = () => `/api/v1/tasks/${pod._id}/TASK-001`;
  const as = (token) => ({ Authorization: `Bearer ${token}` });
  const claim = (token) => request(app).post(`${base()}/claim`).set(as(token)).send({});

  describe('against a peer seat holding a live lease', () => {
    beforeEach(async () => {
      expect((await claim(PEER_RUNTIME)).status).toBe(200);
    });

    test('PATCH is refused, as on its runtime token', async () => {
      const viaRuntime = await request(app).patch(base()).set(as(BOT_RUNTIME)).send({ status: 'pending' });
      const viaUser = await request(app).patch(base()).set(as(BOT_USER)).send({ status: 'pending' });
      expect(viaRuntime.status).toBe(409);
      expect(viaUser.status).toBe(409);
      expect(viaUser.body.claimedBy).toBe(String(peer._id));
    });

    test('complete is refused and the peer keeps the row', async () => {
      const res = await request(app).post(`${base()}/complete`).set(as(BOT_USER)).send({});
      expect(res.status).toBe(409);
      const row = await Task.findOne({ taskId: 'TASK-001' }).lean();
      expect(row).toEqual(expect.objectContaining({ status: 'claimed', claimedByUserId: String(peer._id) }));
    });

    test('a priority change through a note is refused', async () => {
      const res = await request(app).post(`${base()}/updates`).set(as(BOT_USER)).send({ text: 'bump', priority: 'P0' });
      expect(res.status).toBe(409);
    });

    test('it cannot PATCH the row to claimed', async () => {
      const res = await request(app).patch(base()).set(as(BOT_USER)).send({ status: 'claimed' });
      expect(res.status).toBe(400);
    });

    test('a person still writes over the lease', async () => {
      const res = await request(app).patch(base()).set(as(ownerToken)).send({ status: 'pending' });
      expect(res.status).toBe(200);
    });
  });

  test('its own lease is its own on either token', async () => {
    expect((await claim(BOT_RUNTIME)).status).toBe(200);
    const res = await request(app).post(`${base()}/complete`).set(as(BOT_USER)).send({});
    expect(res.status).toBe(200);
    expect(res.body.task.status).toBe('done');
  });

  test('it gets the freshness hold on claim and on a note', async () => {
    AgentSendFreshness.unseenMessages.mockResolvedValue(HOLD);
    const held = await claim(BOT_USER);
    expect(held.status).toBe(409);
    expect(held.body.code).toBe('unseen_messages');
    const noteHeld = await request(app).post(`${base()}/updates`).set(as(BOT_USER)).send({ text: 'progress' });
    expect(noteHeld.status).toBe(409);
    expect((await request(app).post(`${base()}/updates`).set(as(ownerToken)).send({ text: 'progress' })).status).toBe(200);
  });

  test('its board write wakes the pod as an agent and names itself, so it is skipped', async () => {
    const res = await request(app).post(`${base()}/updates`).set(as(BOT_USER)).send({ text: 'progress' });
    expect(res.status).toBe(200);
    expect(notifyPodAgents).toHaveBeenCalled();
    const actor = notifyPodAgents.mock.calls.at(-1)[3];
    expect(actor).toEqual(expect.objectContaining({
      userId: String(bot._id), isAgent: true, agentName: 'cm-bot', instanceId: 'default',
    }));
  });

  test('a person writing is still priced as a person', async () => {
    await request(app).post(`${base()}/updates`).set(as(ownerToken)).send({ text: 'progress' });
    const actor = notifyPodAgents.mock.calls.at(-1)[3];
    expect(actor).toEqual(expect.objectContaining({ isAgent: false }));
    expect(actor.agentName).toBeUndefined();
  });
});
