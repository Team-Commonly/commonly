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
  return res.body.agents.find((a) => a.agentName === 'Nova' || a.name === 'Nova');
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

  it('drops the command once the seat has polled', async () => {
    const agent = await agentFor(owner, [{ tokenHash: 'h', lastUsedAt: new Date() }]);
    expect(agent.connection.state).not.toBe('never');
    expect(agent.fixCommand).toBeUndefined();
  });
});
