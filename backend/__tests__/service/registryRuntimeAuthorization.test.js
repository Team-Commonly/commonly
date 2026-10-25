const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');

// External runtime adapters are the side-effect boundary. Authentication,
// installation lookup and ownership checks use the real models/database.
jest.mock('../../services/agentProvisionerService', () => ({
  startAgentRuntime: jest.fn(async () => ({})),
  stopAgentRuntime: jest.fn(async () => ({})),
  restartAgentRuntime: jest.fn(async () => ({})),
  getAgentRuntimeStatus: jest.fn(async () => ({})),
  getAgentRuntimeLogs: jest.fn(async () => ({ logs: 'runtime output' })),
  clearAgentRuntimeSessions: jest.fn(async () => ({})),
  resolveOpenClawAccountId: jest.fn(({ instanceId }) => instanceId),
}));
const adapters = require('../../services/agentProvisionerService');
const runtimeRouter = require('../../routes/registry/runtime');
const operations = [
  ['get', 'runtime-status', 'getAgentRuntimeStatus'],
  ['post', 'runtime-start', 'startAgentRuntime'],
  ['post', 'runtime-stop', 'stopAgentRuntime'],
  ['post', 'runtime-restart', 'restartAgentRuntime'],
  ['post', 'runtime-clear-sessions', 'clearAgentRuntimeSessions'],
  ['get', 'runtime-logs', 'getAgentRuntimeLogs'],
];
const SECRET = 'runtime-route-authorization-test';

describe('registry runtime authorization', () => {
  let app;
  let server;
  let owner;
  let member;
  let creator;
  let admin;
  let pod;
  let ownPod;
  let installation;
  const effects = () => Object.values(adapters).reduce((count, method) => count + method.mock.calls.length, 0);
  const call = (method, operation, user, { podId = pod._id, instanceId = 'curator' } = {}) => {
    const url = `/api/registry/pods/${podId}/agents/openclaw/${operation}`;
    const req = request(server)[method](url).set('Authorization', `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`);
    return method === 'get' ? req.query({ instanceId }) : req.send({ instanceId });
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    [owner, member, creator, admin] = await Promise.all(['owner', 'member', 'creator', 'admin'].map((name) => User.create({
      username: `runtime-${name}`, email: `runtime-${name}@example.test`, password: 'test-password',
      role: name === 'admin' ? 'admin' : 'user',
    })));
    pod = await Pod.create({
      name: 'Runtime controls', createdBy: creator._id,
      members: [owner._id, member._id, creator._id],
    });
    ownPod = await Pod.create({ name: 'Personal controls', createdBy: member._id, members: [member._id] });
    installation = await AgentInstallation.create({
      agentName: 'openclaw', instanceId: 'curator', podId: pod._id,
      version: '1', installedBy: owner._id,
    });
    app = express();
    app.use(express.json());
    app.use('/api/registry', runtimeRouter);
    server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
  });
  beforeEach(() => { jest.clearAllMocks(); });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await clearMongoDb(); await closeMongoDb();
  });

  it('limits unauthenticated requests before authentication and dispatch', async () => {
    const url = `/api/registry/pods/${pod._id}/agents/openclaw/runtime-status`;
    for (let count = 0; count < 120; count += 1) {
      const response = await request(server).get(url).set('cf-connecting-ip', '192.0.2.50');
      expect(response.status).toBe(401);
    }
    const response = await request(server).get(url).set('cf-connecting-ip', '192.0.2.50');
    expect(response.status).toBe(429);
    expect(effects()).toBe(0);
  });

  describe.each(operations)('%s %s', (method, operation, adapter) => {
    it('refuses a non-installer member before adapter dispatch', async () => {
      expect((await call(method, operation, member)).status).toBe(403);
      expect(effects()).toBe(0);
    });
    it('requires pod access from a non-admin installer', async () => {
      await Pod.updateOne({ _id: pod._id }, { $pull: { members: owner._id } });
      try {
        expect((await call(method, operation, owner)).status).toBe(403);
        expect(effects()).toBe(0);
      } finally { await Pod.updateOne({ _id: pod._id }, { $addToSet: { members: owner._id } }); }
    });
    it('refuses a pod creator who is not the installer', async () => {
      expect((await call(method, operation, creator)).status).toBe(403);
      expect(effects()).toBe(0);
    });
    it('requires an installation in the requested pod', async () => {
      expect((await call(method, operation, member, { podId: ownPod._id })).status).toBe(404);
      expect(effects()).toBe(0);
    });
    it('requires the exact installed instance', async () => {
      expect((await call(method, operation, owner, { instanceId: 'default' })).status).toBe(404);
      expect(effects()).toBe(0);
    });
    it('allows the installer and dispatches the installed identity', async () => {
      expect((await call(method, operation, owner)).status).toBe(200);
      expect(adapters[adapter]).toHaveBeenCalledWith('moltbot', 'curator', ...(
        adapter === 'getAgentRuntimeLogs' ? [200, expect.any(Object)] : [expect.any(Object)]
      ));
    });
    it('allows a global admin without pod membership', async () => {
      expect((await call(method, operation, admin)).status).toBe(200);
      expect(adapters[adapter]).toHaveBeenCalled();
    });
    it('requires an installation even for an admin', async () => {
      expect((await call(method, operation, admin, { podId: ownPod._id })).status).toBe(404);
      expect(effects()).toBe(0);
    });
    it('refuses an uninstalled record', async () => {
      await AgentInstallation.updateOne({ _id: installation._id }, { status: 'uninstalled' });
      try {
        expect((await call(method, operation, owner)).status).toBe(404);
        expect(effects()).toBe(0);
      } finally { await AgentInstallation.updateOne({ _id: installation._id }, { status: 'active' }); }
    });
  });
});
