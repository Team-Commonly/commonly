const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');

// F612: an agent-room or agent-admin pod is private to its members, admins
// included (getPodById answers a non-member admin 404 there). The registry
// routes that act on one installed agent share one authorization helper, so
// an admin reaches an agent in one of those pods only as a member of it. On a
// team or chat pod the admin keeps the instance-wide access. The runtime
// adapters and the LLM call are the side-effect boundary; auth, pod and
// installation lookups run against the real models.
jest.mock('../../services/agentProvisionerService', () => ({
  startAgentRuntime: jest.fn(async () => ({})),
  stopAgentRuntime: jest.fn(async () => ({})),
  restartAgentRuntime: jest.fn(async () => ({})),
  getAgentRuntimeStatus: jest.fn(async () => ({})),
  getAgentRuntimeLogs: jest.fn(async () => ({ logs: 'runtime output' })),
}));
jest.mock('../../services/llmService', () => ({
  generateText: jest.fn(async () => JSON.stringify({ tone: 'calm', specialties: [], boundaries: [] })),
}));
const adapters = require('../../services/agentProvisionerService');
const { generateText } = require('../../services/llmService');
const runtimeRouter = require('../../routes/registry/runtime');
const filesRouter = require('../../routes/registry/files');
const AgentProfileModule = require('../../models/AgentProfile');

const AgentProfile = AgentProfileModule.default || AgentProfileModule;
const SECRET = 'registry-personal-pod-admin-test';

// [method, path suffix, side effects an allowed call reaches (the heartbeat read has none)]
const operations = [
  ['get', 'heartbeat-file', 0],
  ['post', 'persona/generate', 1],
  ['get', 'runtime-logs', 1],
  ['post', 'runtime-restart', 1],
];

describe('an admin acts on an agent in a personal pod only as a member of it', () => {
  let server;
  let installer;
  let admin;
  let agentUser;
  const pods = {};
  let ipCounter = 0;
  const effects = () => generateText.mock.calls.length
    + Object.values(adapters).reduce((count, fn) => count + fn.mock.calls.length, 0);
  const call = (method, operation, user, podId) => {
    ipCounter += 1;
    const req = request(server)[method](`/api/registry/pods/${podId}/agents/codex/${operation}`)
      .set('Authorization', `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`)
      .set('cf-connecting-ip', `203.0.113.${ipCounter % 250}`);
    return method === 'get' ? req.query({ instanceId: 'curator' }) : req.send({ instanceId: 'curator' });
  };

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    [installer, admin, agentUser] = await Promise.all(['installer', 'admin', 'agent'].map((name) => User.create({
      username: `personal-${name}`,
      email: `personal-${name}@example.test`,
      password: 'test-password',
      role: name === 'admin' ? 'admin' : 'user',
    })));
    const podSpecs = [
      ['agentRoom', 'agent-room'],
      ['agentAdmin', 'agent-admin'],
      ['team', 'team'],
      ['chat', 'chat'],
    ];
    await Promise.all(podSpecs.map(async ([key, type]) => {
      pods[key] = await Pod.create({
        name: `Personal test ${type}`, type, createdBy: installer._id, members: [installer._id, agentUser._id],
      });
      await AgentInstallation.create({
        agentName: 'codex', instanceId: 'curator', podId: pods[key]._id, version: '1', installedBy: installer._id,
      });
      await AgentProfile.create({
        agentId: 'codex:curator', agentName: 'codex', instanceId: 'curator', podId: pods[key]._id,
        name: 'Curator', purpose: 'Keeps the pod tidy.', createdBy: installer._id, heartbeatContent: '- check in',
      });
    }));
    const app = express();
    app.use(express.json());
    app.use('/api/registry', runtimeRouter);
    app.use('/api/registry', filesRouter);
    server = await new Promise((resolve) => { const listening = app.listen(0, () => resolve(listening)); });
  });
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => { console.info.mockRestore(); });
  afterAll(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    await clearMongoDb();
    await closeMongoDb();
  });

  describe.each(operations)('%s %s', (method, operation, reachedEffects) => {
    it.each(['agentRoom', 'agentAdmin'])('refuses an admin who is not a member of the %s pod', async (key) => {
      const res = await call(method, operation, admin, pods[key]._id);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Access denied');
      expect(res.body.code).toBeUndefined();
      expect(effects()).toBe(0);
    });

    it('lets the same admin through once a member of the agent-room', async () => {
      await Pod.updateOne({ _id: pods.agentRoom._id }, { $addToSet: { members: admin._id } });
      try {
        const res = await call(method, operation, admin, pods.agentRoom._id);
        expect(res.status).toBe(200);
        expect(effects()).toBe(reachedEffects);
      } finally {
        await Pod.updateOne({ _id: pods.agentRoom._id }, { $pull: { members: admin._id } });
      }
    });

    it.each(['team', 'chat'])('still lets an admin who is not a member of a %s pod through', async (key) => {
      const res = await call(method, operation, admin, pods[key]._id);
      expect(res.status).toBe(200);
      expect(effects()).toBe(reachedEffects);
    });

    it('still lets the installer act on the agent-room agent', async () => {
      const res = await call(method, operation, installer, pods.agentRoom._id);
      expect(res.status).toBe(200);
      expect(effects()).toBe(reachedEffects);
    });
  });
});

beforeEach(() => {
  // eslint-disable-next-line global-require
  require('../../services/cloudRuntimeOwnership').clearCloudRuntimeCache();
});
