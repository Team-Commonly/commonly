// TASK-716: a never-connected BYO seat carries the command that makes it run,
// for the installer only, and only while it has never polled.
const request = require('supertest');
const express = require('express');
const mongoose = require('mongoose');

let mockViewer = '6a0000000000000000000002';
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.userId = mockViewer;
  req.user = { id: mockViewer };
  next();
});
jest.mock('../../../services/dmService', () => ({ canViewPod: jest.fn().mockResolvedValue(true) }));

const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');
const podAgentsRouter = require('../../../routes/registry/pod-agents');

const app = express();
app.use(express.json());
app.use('/api/registry', podAgentsRouter);

const owner = new mongoose.Types.ObjectId('6a0000000000000000000002');
const other = new mongoose.Types.ObjectId('6a0000000000000000000003');
const podId = new mongoose.Types.ObjectId();
const username = AgentIdentityService.buildAgentUsername('Nova', 'default');

const agentFor = async (viewerId, tokens = []) => {
  mockViewer = String(viewerId);
  await AgentInstallation.create({
    agentName: 'Nova',
    instanceId: 'default',
    podId,
    version: '1.0.0',
    installedBy: owner,
    status: 'active',
    config: { runtime: { runtimeType: 'wrapper', host: 'byo' } },
    runtimeTokens: tokens,
  });
  const res = await request(app).get(`/api/registry/pods/${podId}/agents`);
  expect(res.status).toBe(200);
  return res.body.agents.find((a) => a.name === 'nova');
};

beforeAll(setupMongoDb);
afterAll(closeMongoDb);
beforeEach(async () => {
  await Pod.collection.insertOne({
    _id: podId, name: 'p', type: 'chat', createdBy: owner, members: [owner, other],
  });
  await mongoose.connection.collection('users').insertOne({
    username,
    email: `${username}@agents.commonly.invalid`,
    isBot: true,
    botMetadata: { agentName: 'Nova', instanceId: 'default' },
  });
});
afterEach(async () => {
  await clearMongoDb();
  await mongoose.connection.collection('users').deleteMany({});
});

describe('never-connected seat command (TASK-716)', () => {
  it('gives the installer the run command while the seat has never polled', async () => {
    const agent = await agentFor(owner);
    expect(agent.connection.state).toBe('never');
    expect(agent.fixCommand).toBe('commonly agent run nova');
  });

  it('gives another member no command', async () => {
    const agent = await agentFor(other);
    expect(agent.connection.state).toBe('never');
    expect(agent.fixCommand).toBeUndefined();
  });

  it("gives a guest no command on the room row that names them", async () => {
    await agentFor(owner);
    const roomId = new mongoose.Types.ObjectId();
    await Pod.collection.insertOne({
      _id: roomId, name: 'Nova', type: 'agent-room', createdBy: other, members: [other],
    });
    await AgentInstallation.create({
      agentName: 'Nova', instanceId: 'default', podId: roomId, version: '1.0.0', installedBy: other,
      status: 'active', config: { runtime: { runtimeType: 'wrapper', host: 'byo' } },
    });
    mockViewer = String(other);
    const res = await request(app).get(`/api/registry/pods/${roomId}/agents`);
    const agent = res.body.agents.find((a) => a.name === 'nova');
    expect(agent.connection.state).toBe('never');
    expect(agent.fixCommand).toBeUndefined();
  });

  it('reads a room the same for a guest as for any other member', async () => {
    const url = 'https://example.com/hook';
    const config = { runtime: { runtimeType: 'webhook', host: 'byo', webhookUrl: url } };
    await AgentInstallation.create({
      agentName: 'Nova', instanceId: 'default', podId, version: '1.0.0', installedBy: owner, status: 'active', config,
    });
    const roomId = new mongoose.Types.ObjectId();
    await Pod.collection.insertOne({
      _id: roomId, name: 'Nova', type: 'agent-room', createdBy: other, members: [other],
    });
    await AgentInstallation.create({
      agentName: 'Nova', instanceId: 'default', podId: roomId, version: '1.0.0', installedBy: other, status: 'active', config,
    });
    mockViewer = String(other);
    const list = await request(app).get(`/api/registry/pods/${roomId}/agents`);
    const one = await request(app).get(`/api/registry/pods/${roomId}/agents/nova`);
    expect(list.body.agents.map((a) => a.name)).toContain('nova');
    expect(one.body.agent.name).toBe('nova');
    expect(JSON.stringify(list.body)).not.toContain(url);
    expect(JSON.stringify(one.body)).not.toContain(url);

    const standing = new mongoose.Types.ObjectId();
    await Pod.collection.insertOne({
      _id: standing, name: 'Theirs', type: 'chat', createdBy: other, members: [other],
    });
    await AgentInstallation.create({
      agentName: 'Nova', instanceId: 'default', podId: standing, version: '1.0.0', installedBy: other, status: 'active',
      config: { ...config, autoJoinSource: 'mention-resolution' },
    });
    const joined = await request(app).get(`/api/registry/pods/${standing}/agents/nova`);
    expect(joined.body.agent.name).toBe('nova');
    expect(JSON.stringify(joined.body)).not.toContain(url);

    mockViewer = String(owner);
    const own = await request(app).get(`/api/registry/pods/${podId}/agents/nova`);
    expect(JSON.stringify(own.body)).toContain(url);
  });

  it('drops the command once the seat has polled', async () => {
    const agent = await agentFor(owner, [{ tokenHash: 'h', lastUsedAt: new Date() }]);
    expect(agent.connection.state).not.toBe('never');
    expect(agent.fixCommand).toBeUndefined();
  });
});
