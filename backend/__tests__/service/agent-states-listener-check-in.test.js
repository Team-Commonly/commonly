// /agent-states reads listener check-ins (TASK-721), through the real models and
// the real route. The unit suite builds token rows by hand and so cannot see a
// dropped projection field or a stamp written to the wrong store: this one
// writes with `recordListenerCheckIn` and reads back over HTTP.
const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');
const podsRouter = require('../../routes/pods');
const { recordListenerCheckIn, resetListenerCheckInThrottle } = require('../../services/agentListenerCheckIn');

const SECRET = 'agent-states-listener-test';
const WRAPPER = { runtimeType: 'webhook', host: 'byo' };

describe('GET /api/pods/:podId/agent-states reads listener check-ins', () => {
  let app; let owner; let pod; let authHeader;

  const install = (agentName, runtimeTokens = []) => AgentInstallation.create({
    agentName,
    instanceId: 'default',
    podId: pod._id,
    version: '1',
    installedBy: owner._id,
    config: new Map([['runtime', WRAPPER]]),
    runtimeTokens,
  });
  const botUser = (agentName, agentRuntimeTokens) => User.create({
    username: agentName,
    email: `${agentName}@test.com`,
    password: 'password123',
    isBot: true,
    botMetadata: { agentName, instanceId: 'default' },
    agentRuntimeTokens,
  });
  const states = async () => {
    const res = await request(app).get(`/api/pods/${pod._id}/agent-states`).set('Authorization', authHeader);
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.agents.map((a) => [a.agentName, a]));
  };
  // The check-in writes are fire-and-forget, so wait for them to land.
  const settle = () => new Promise((resolve) => { setTimeout(resolve, 150); });

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    app = express();
    app.use(express.json());
    app.use('/api/pods', podsRouter);
    owner = await User.create({ username: 'states-owner', email: 'states-owner@test.com', password: 'password123' });
    pod = await Pod.create({
      name: 'States', type: 'chat', createdBy: owner._id, members: [owner._id], 
    });
    authHeader = `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`;
  });

  afterAll(async () => closeMongoDb());
  beforeEach(() => resetListenerCheckInThrottle());

  it('an MCP call alone is never-connected; a check-in on the User token flips it to listening', async () => {
    const used = new Date();
    await install('mcp-only');
    await botUser('mcp-only', [{ tokenHash: 'h-user', lastUsedAt: used }]);
    expect((await states())['mcp-only'].state).toBe('never-connected');

    recordListenerCheckIn((await User.findOne({ username: 'mcp-only' }))._id, 'h-user');
    await settle();
    expect((await states())['mcp-only'].state).toBe('listening');
  });

  it('a check-in on an installation-only token flips it to listening', async () => {
    await install('install-only', [{ tokenHash: 'h-install', lastUsedAt: new Date() }]);
    expect((await states())['install-only'].state).toBe('never-connected');

    recordListenerCheckIn(null, 'h-install');
    await settle();
    expect((await states())['install-only'].state).toBe('listening');
  });
});
