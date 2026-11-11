// The moltbot runtime retired under ADR-021 Part B. A moltbot provision used to
// mint tokens for a gateway nothing runs and record the install as provisioned.
// It now refuses first, in every mode.
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

describe('moltbot provision with the runtime retired', () => {
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

  // The runtime is retired in every mode: no gateway runs in Helm or compose.
  it.each([
    ['docker mode', { AGENT_PROVISIONER_DOCKER: '1' }],
    ['k8s mode', { AGENT_PROVISIONER_DOCKER: '1', AGENT_PROVISIONER_K8S: '1' }],
    ['docker provisioning off', {}],
  ])('refuses in %s before any identity or token work', async (_mode, env) => {
    Object.assign(process.env, env);
    const res = await provision();
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('runtime_retired');
    expect(AgentIdentityService.getOrCreateAgentUser).not.toHaveBeenCalled();
  });

  it.each(['internal', 'native', 'claude-code', 'webhook'])('leaves the %s runtime alone', async (runtime) => {
    AgentIdentityService.getAgentTypeConfig.mockReturnValueOnce({ runtime });
    const res = await provision();
    expect(res.body.code).not.toBe('runtime_retired');
    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalled();
  });
});
