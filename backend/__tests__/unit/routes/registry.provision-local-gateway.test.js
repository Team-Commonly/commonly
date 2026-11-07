// The local compose gateway retired under ADR-021 Part B. In docker mode a
// moltbot provision used to mint tokens, fail to start the removed service and
// record the install as provisioned. It now refuses first.
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { _id: 'user-1', id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), install: jest.fn(), updateOne: jest.fn() },
}));

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: jest.fn((name) => String(name).toLowerCase()),
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'moltbot' })),
  isCloudRuntime: jest.fn(() => false),
  getOrCreateAgentUser: jest.fn().mockRejectedValue(new Error('past the refusal')),
  ensureAgentInPod: jest.fn(),
}));

jest.mock('../../../routes/registry/helpers', () => ({
  getUserId: jest.fn((req) => req.userId),
  isGlobalAdminUser: jest.fn().mockResolvedValue(true),
  resolveInstallation: jest.fn().mockResolvedValue({
    installation: { status: 'active', config: { runtime: {} }, runtimeTokens: [] },
    instanceId: 'default',
  }),
  resolveRuntimeInstanceId: jest.fn().mockReturnValue('default'),
  normalizeConfigMap: jest.fn((c) => c),
  normalizeRuntimeAuthProfiles: jest.fn(),
  normalizeSkillEnvEntries: jest.fn(),
  buildOpenClawIntegrationChannels: jest.fn(),
  userHasPodAccess: jest.fn(),
  resolveGatewayForRequest: jest.fn(),
  resolveGatewayForInstallation: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const AgentIdentityService = require('../../../services/agentIdentityService');
const provisionRouter = require('../../../routes/registry/provision');

const app = express();
app.use(express.json());
app.use('/api/registry', provisionRouter);

describe('moltbot provision with the local gateway retired', () => {
  const saved = {};
  const ENV = ['AGENT_PROVISIONER_DOCKER', 'AGENT_PROVISIONER_K8S'];
  const provision = () => request(app).post('/api/registry/pods/pod-1/agents/openclaw/provision').send({});

  beforeEach(() => {
    ENV.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; });
    jest.clearAllMocks();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'user-1', members: ['user-1'] }),
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    ENV.forEach((k) => {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    });
  });

  it('refuses in docker mode before any identity or token work', async () => {
    process.env.AGENT_PROVISIONER_DOCKER = '1';
    const res = await provision();
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('local_gateway_retired');
    expect(AgentIdentityService.getOrCreateAgentUser).not.toHaveBeenCalled();
  });

  it('leaves k8s mode to the driver step', async () => {
    process.env.AGENT_PROVISIONER_DOCKER = '1';
    process.env.AGENT_PROVISIONER_K8S = '1';
    await provision();
    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalled();
  });

  it('leaves a gateway an operator runs alone, with docker provisioning off', async () => {
    await provision();
    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalled();
  });
});
