const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { setupMongoDb, clearMongoDb, closeMongoDb } = require('../utils/testUtils');
const User = require('../../models/User');
const Pod = require('../../models/Pod');
const { AgentInstallation } = require('../../models/AgentRegistry');

jest.mock('../../services/agentProvisionerService', () => ({
  startAgentRuntime: jest.fn(async () => ({})),
  stopAgentRuntime: jest.fn(async () => ({})),
  restartAgentRuntime: jest.fn(async () => ({})),
  getAgentRuntimeStatus: jest.fn(async () => ({})),
  getAgentRuntimeLogs: jest.fn(async () => ({ logs: '' })),
  clearAgentRuntimeSessions: jest.fn(async () => ({})),
  resolveOpenClawAccountId: jest.fn(({ instanceId }) => instanceId),
}));
const adapters = require('../../services/agentProvisionerService');
const router = require('../../routes/registry/runtime');
const operations = [
  ['get', 'runtime-status'], ['post', 'runtime-start'], ['post', 'runtime-stop'],
  ['post', 'runtime-restart'], ['post', 'runtime-clear-sessions'], ['get', 'runtime-logs'],
];
const SECRET = 'registry-runtime-admin-test';

describe('registry runtime admin access', () => {
  let app;
  let pod;
  let member;
  let admin;
  const call = (method, route, user) => request(app)[method](
    `/api/registry/pods/${pod._id}/agents/openclaw/${route}`,
  ).set('Authorization', `Bearer ${jwt.sign({ id: String(user._id) }, SECRET)}`);

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    await setupMongoDb();
    [member, admin] = await Promise.all(['user', 'admin'].map((role) => User.create({
      username: `runtime-admin-${role}`, email: `runtime-admin-${role}@example.test`,
      password: 'test-password', role,
    })));
    pod = await Pod.create({ name: 'Runtime administration', createdBy: member._id, members: [member._id, admin._id] });
    await AgentInstallation.create({
      agentName: 'openclaw', instanceId: 'default', podId: pod._id, version: '1', installedBy: member._id,
    });
    app = express();
    app.use(express.json());
    app.use('/api/registry', router);
  });
  beforeEach(() => { jest.clearAllMocks(); });
  afterAll(async () => { await clearMongoDb(); await closeMongoDb(); });

  it.each(operations)('refuses a non-admin member for %s %s', async (method, route) => {
    const response = await call(method, route, member);
    expect(response.status).toBe(403);
    expect(response.body.message).toBe('Admin access required');
    for (const adapter of Object.values(adapters)) expect(adapter).not.toHaveBeenCalled();
  });

  it.each(operations)('permits an admin member for %s %s', async (method, route) => {
    expect((await call(method, route, admin)).status).toBe(200);
    expect(Object.values(adapters).some((adapter) => adapter.mock.calls.length)).toBe(true);
  });
});
