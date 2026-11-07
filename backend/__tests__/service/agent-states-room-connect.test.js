// The agent room's Connect link: the room's own install is a
// copy, and Bring your own refuses a DM pod, so the row must name the pod that
// holds the agent. Real models and the real route.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const podsRouter = require('../../routes/pods');

const SECRET = 'agent-states-room-connect-test';
const BYO = { runtimeType: 'webhook', host: 'byo' };

describe('GET /api/pods/:podId/agent-states in an agent room', () => {
  let app; let owner; let other; let home; let authHeader;

  const makePod = (name, type, extra = {}) => Pod.create({
    name, type, createdBy: owner._id, members: [owner._id], ...extra,
  });
  const install = (agentName, podId, runtime = BYO, installedBy = owner._id) => AgentInstallation.create({
    agentName, instanceId: 'default', podId, version: '1', installedBy, config: new Map([['runtime', runtime]]),
  });
  const rowIn = async (room, agentName) => {
    const res = await request(app).get(`/api/pods/${room._id}/agent-states`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    return res.body.agents.find((a) => a.agentName === agentName);
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/pods', podsRouter);
    owner = await User.create({ username: 'room-owner', email: 'room-owner@test.com', password: 'password123' });
    other = await User.create({ username: 'room-other', email: 'room-other@test.com', password: 'password123' });
    home = await makePod('Home', 'chat');
    authHeader = `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`;
  });

  afterAll(async () => closeMongoDb());

  it('names the pod that holds the agent, not the room', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('plain', home._id);
    await install('plain', room._id);
    const row = await rowIn(room, 'plain');
    expect(row.state).toBe('never-connected');
    expect(row.connectPodId).toBe(String(home._id));
  });

  it('gives a wrapper none: Reconnect refuses an agent never bound to a computer', async () => {
    const room = await makePod('Room', 'agent-room');
    const wrapper = { runtimeType: 'wrapper', host: 'byo' };
    await install('bound', home._id, wrapper);
    await install('bound', room._id, wrapper);
    const row = await rowIn(room, 'bound');
    expect(row.fixCommand).toBe('commonly agent run bound');
    expect(row.connectPodId).toBeUndefined();
  });

  it('gives a seat bound to a machine none, whatever its install says', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('seat', home._id);
    await install('seat', room._id);
    await User.create({
      username: 'seat',
      email: 'seat@test.com',
      password: 'password123',
      isBot: true,
      botMetadata: { agentName: 'seat', instanceId: 'default', machineId: new mongoose.Types.ObjectId() },
    });
    expect((await rowIn(room, 'seat')).connectPodId).toBeUndefined();
  });

  it('gives a push webhook none: it has no command to connect', async () => {
    const room = await makePod('Room', 'agent-room');
    const hook = { runtimeType: 'webhook', webhookUrl: 'https://example.test/hook' };
    await install('hook', home._id, hook);
    await install('hook', room._id, hook);
    expect((await rowIn(room, 'hook')).connectPodId).toBeUndefined();
  });

  it('gives someone who did not install it none', async () => {
    const room = await makePod('Room', 'agent-room');
    await install('theirs', home._id, BYO, other._id);
    await install('theirs', room._id, BYO, other._id);
    expect((await rowIn(room, 'theirs')).connectPodId).toBeUndefined();
  });

  it('skips pods the page would refuse, and gives none when nothing is left', async () => {
    const room = await makePod('Room', 'agent-room');
    const secondRoom = await makePod('Other room', 'agent-room');
    const open = await makePod('Open', 'chat', { publicRead: true });
    await install('stranded', room._id);
    await install('stranded', secondRoom._id);
    await install('stranded', open._id);
    expect((await rowIn(room, 'stranded')).connectPodId).toBeUndefined();
  });

  it('leaves a group pod alone: its rows carry no such field', async () => {
    await install('group', home._id);
    expect((await rowIn(home, 'group')).connectPodId).toBeUndefined();
  });
});
