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
  let audit;
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
  beforeEach(() => {
    jest.clearAllMocks();
    audit = jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { audit.mockRestore(); });
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

  it('coerces a body instance value instead of accepting a Mongo query operator', async () => {
    expect((await call('post', 'runtime-start', owner, { instanceId: { $ne: null } })).status).toBe(404);
    expect(effects()).toBe(0);
  });
  it.each([[undefined, 200], ['NaN', 200], ['Infinity', 200], ['1000000', 1000], ['-1', 1], ['0', 1], ['2.9', 2]])(
    'bounds runtime log lines %s to %s', async (requested, expected) => {
      const query = { instanceId: 'curator', ...(requested === undefined ? {} : { lines: requested }) };
      const response = await request(server).get(`/api/registry/pods/${pod._id}/agents/openclaw/runtime-logs`)
        .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`).query(query);
      expect(response.status).toBe(200);
      expect(adapters.getAgentRuntimeLogs.mock.calls[0][2]).toBe(expected);
    },
  );
  it('keeps paused installations inspectable by their owner', async () => {
    await AgentInstallation.updateOne({ _id: installation._id }, { status: 'paused' });
    try { expect((await call('get', 'runtime-status', owner)).status).toBe(200); }
    finally { await AgentInstallation.updateOne({ _id: installation._id }, { status: 'active' }); }
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
    it.each([['owner', 'allowed', 200], ['member', 403, 403], ['missing', 404, 404]])(
      'audits one %s outcome without content or credentials', async (actor, outcome, status) => {
        const user = actor === 'member' ? member : owner;
        const options = actor === 'missing' ? { instanceId: 'missing' } : {};
        expect((await call(method, operation, user, options)).status).toBe(status);
        expect(audit).toHaveBeenCalledTimes(1);
        expect(JSON.parse(audit.mock.calls[0][0])).toEqual({
          event: 'registry.runtime', route: `/pods/:podId/agents/:name/${operation}`,
          podId: String(pod._id), agentName: 'openclaw',
          instanceId: actor === 'missing' ? 'missing' : 'curator',
          callerUserId: String(user._id), outcome,
        });
      },
    );
    it('looks up a stored session ID without changing its spelling', async () => {
      await AgentInstallation.updateOne({ _id: installation._id }, { instanceId: 'My Session' });
      try {
        expect((await call(method, operation, owner, { instanceId: 'My Session' })).status).toBe(200);
        expect(adapters[adapter].mock.calls[0][1]).toBe('My Session');
        expect(JSON.parse(audit.mock.calls[0][0]).instanceId).toBe('My Session');
      } finally { await AgentInstallation.updateOne({ _id: installation._id }, { instanceId: 'curator' }); }
    });
    it('audits the same method-specific instance used by authorization', async () => {
      const req = request(server)[method](`/api/registry/pods/${pod._id}/agents/openclaw/${operation}`)
        .set('Authorization', `Bearer ${jwt.sign({ id: String(owner._id) }, SECRET)}`);
      if (method === 'post') await AgentInstallation.updateOne({ _id: installation._id }, { instanceId: 'default' });
      try {
        const response = method === 'get'
          ? await req.query({ instanceId: 'curator' }).send({ instanceId: 'wrong-body' })
          : await req.query({ instanceId: 'wrong-query' }).send({});
        expect(response.status).toBe(200);
        expect(JSON.parse(audit.mock.calls[0][0]).instanceId).toBe(method === 'get' ? 'curator' : 'default');
      } finally { await AgentInstallation.updateOne({ _id: installation._id }, { instanceId: 'curator' }); }
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
