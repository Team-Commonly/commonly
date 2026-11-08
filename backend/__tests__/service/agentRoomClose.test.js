// F307: a person closes the direct message pod they hold with an agent.
// Real mongod and the real pods router and controller, because every claim
// here is about which rows a list returns and who may write closedAt.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');

jest.mock('../../models/pg/Message', () => ({
  findByPodId: jest.fn().mockResolvedValue([]),
  getLatestByPodIds: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../config/socket', () => ({ getIO: () => ({ to: () => ({ emit: jest.fn() }) }) }));

const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const DMService = require('../../services/dmService');
const { reopenIfClosed } = require('../../services/agentRoomCloseService');

const SECRET = 'agent-room-close-test';
const bearer = (user) => `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`;

let app;
let previousSecret;
let human;
let agent;
let room;
let team;

const listIds = async (user) => {
  const res = await request(app).get('/api/pods').set('Authorization', bearer(user));
  expect(res.status).toBe(200);
  return res.body.map((p) => String(p._id));
};

beforeAll(async () => {
  previousSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  await setupMongoDb();
  app = express();
  app.use(express.json());
  app.use('/api/pods', require('../../routes/pods'));
});

afterAll(async () => {
  process.env.JWT_SECRET = previousSecret;
  await closeMongoDb();
});

beforeEach(async () => {
  await Promise.all([User.deleteMany({}), Pod.deleteMany({}), AgentInstallation.deleteMany({})]);
  human = await User.create({ username: 'person', email: 'person@x.test', password: 'x'.repeat(12) });
  agent = await User.create({ username: 'otter', email: 'otter@x.test', password: 'x'.repeat(12), isBot: true });
  room = await Pod.create({ name: 'otter', type: 'agent-room', createdBy: agent._id, members: [agent._id, human._id] });
  team = await Pod.create({ name: 'team', type: 'chat', createdBy: human._id, members: [human._id] });
});

it('a closed room leaves GET /api/pods, its URL still opens, and reopen brings it back', async () => {
  expect(await listIds(human)).toEqual(expect.arrayContaining([String(room._id), String(team._id)]));

  const closed = await request(app).post(`/api/pods/${room._id}/close`).set('Authorization', bearer(human));
  expect(closed.status).toBe(200);
  expect(await listIds(human)).toEqual([String(team._id)]);

  const opened = await request(app).get(`/api/pods/${room._id}`).set('Authorization', bearer(human));
  expect(opened.status).toBe(200);

  const reopened = await request(app).post(`/api/pods/${room._id}/reopen`).set('Authorization', bearer(human));
  expect(reopened.status).toBe(200);
  expect(await listIds(human)).toContain(String(room._id));
});

it('refuses the agent member, a stranger, and any pod that is not an agent-room', async () => {
  const stranger = await User.create({ username: 'stranger', email: 's@x.test', password: 'x'.repeat(12) });
  expect((await request(app).post(`/api/pods/${room._id}/close`).set('Authorization', bearer(agent))).status).toBe(403);
  expect((await request(app).post(`/api/pods/${room._id}/close`).set('Authorization', bearer(stranger))).status).toBe(403);
  expect((await request(app).post(`/api/pods/${team._id}/close`).set('Authorization', bearer(human))).status).toBe(400);
  expect((await request(app).post(`/api/pods/${team._id}/close`).set('Authorization', bearer(stranger))).status).toBe(404);
  expect((await Pod.findById(room._id).lean()).closedAt).toBeUndefined();
});

it('Talk to on a closed room reopens it and returns the same pod', async () => {
  await request(app).post(`/api/pods/${room._id}/close`).set('Authorization', bearer(human));
  const again = await DMService.getOrCreateAgentRoom(agent._id, human._id);
  expect(String(again._id)).toBe(String(room._id));
  expect((await Pod.findById(room._id).lean()).closedAt).toBeUndefined();
  expect(await listIds(human)).toContain(String(room._id));
});

it('the room read says agentGone only when every install row is uninstalled', async () => {
  const read = async () => (await request(app).get(`/api/pods/${room._id}`).set('Authorization', bearer(human))).body.agentGone;
  // No row at all is not evidence the agent was removed.
  expect(await read()).toBe(false);
  await AgentInstallation.collection.insertOne({
    agentName: 'otter', instanceId: 'default', podId: room._id, installedBy: human._id, version: '1.0.0', status: 'paused',
  });
  expect(await read()).toBe(false);
  await AgentInstallation.collection.updateMany({ podId: room._id }, { $set: { status: 'uninstalled' } });
  expect(await read()).toBe(true);
  const teamRead = await request(app).get(`/api/pods/${team._id}`).set('Authorization', bearer(human));
  expect(teamRead.body.agentGone).toBeUndefined();
});

it('a write in the room reopens it', async () => {
  await request(app).post(`/api/pods/${room._id}/close`).set('Authorization', bearer(human));
  await reopenIfClosed(room._id);
  expect(await listIds(human)).toContain(String(room._id));
});
