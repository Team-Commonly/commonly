// Gate test: provisioning a cloud (hosted) runtime requires admin OR the
// cloudAgents entitlement. Exercises the early-return 403 path on the provision
// route before any runtime provisioning work runs.
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
  getAgentTypeConfig: jest.fn((name) => (
    String(name).toLowerCase() === 'openclaw' ? { runtime: 'moltbot' } : null
  )),
  isCloudRuntime: jest.fn(({ runtimeType, host } = {}) => {
    const rt = String(runtimeType || '').toLowerCase();
    const h = String(host || '').toLowerCase();
    if (h === 'byo') return false;
    if (rt === 'webhook' || rt === 'claude-code') return false;
    if (['moltbot', 'internal', 'native', 'managed-agents'].includes(rt)) return true;
    if (rt === 'codex') return true;
    return false;
  }),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));

jest.mock('../../../routes/registry/helpers', () => ({
  getUserId: jest.fn((req) => req.userId),
  isGlobalAdminUser: jest.fn().mockResolvedValue(false),
  resolveInstallation: jest.fn().mockResolvedValue({
    installation: {
      status: 'active',
      config: { runtime: {} },
      runtimeTokens: [],
    },
    instanceId: 'default',
  }),
  resolveRuntimeInstanceId: jest.fn().mockReturnValue('default'),
  // Remaining helpers are only reached after the gate; stub as no-ops.
  normalizeConfigMap: jest.fn((c) => c),
  normalizeRuntimeAuthProfiles: jest.fn(),
  normalizeSkillEnvEntries: jest.fn(),
  buildOpenClawIntegrationChannels: jest.fn(),
  userHasPodAccess: jest.fn(),
  resolveGatewayForRequest: jest.fn(),
  resolveGatewayForInstallation: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const { isGlobalAdminUser } = require('../../../routes/registry/helpers');
const provisionRouter = require('../../../routes/registry/provision');

const buildLeanChain = (result) => ({ lean: jest.fn().mockResolvedValue(result) });
const buildSelectLeanChain = (result) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
});

const app = express();
app.use(express.json());
app.use('/api/registry', provisionRouter);

describe('registry provision — cloud-agent entitlement gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue(buildLeanChain({
      _id: 'pod-1', createdBy: 'user-1', members: ['user-1'],
    }));
    isGlobalAdminUser.mockResolvedValue(false);
  });

  it('403s a non-admin, non-entitled user provisioning a cloud (moltbot) agent', async () => {
    User.findById.mockReturnValue(buildSelectLeanChain({
      entitlements: { cloudAgents: false },
    }));

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/provision')
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('cloud_agents_not_entitled');
  });

  it('does not 403 an entitled user (gate passes, proceeds past the check)', async () => {
    User.findById.mockReturnValue(buildSelectLeanChain({
      entitlements: { cloudAgents: true },
    }));

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/openclaw/provision')
      .send({});

    // Past the gate the handler does real provisioning work against stubbed
    // deps, which may error — but it must NOT be the entitlement 403.
    expect(res.body.code).not.toBe('cloud_agents_not_entitled');
  });
});
