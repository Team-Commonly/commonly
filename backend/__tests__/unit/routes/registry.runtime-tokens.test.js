const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { _id: 'user-1' };
  next();
});

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
  },
}));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
  buildAgentUsername: jest.fn((agentType, instanceId = 'default') => (
    instanceId === 'default' ? agentType : `${agentType}-${instanceId}`
  )),
  resolveAgentType: jest.fn((agentName) => {
    if (agentName === 'clawd-bot') return 'openclaw';
    return agentName;
  }),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const AgentIdentityService = require('../../../services/agentIdentityService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('agent runtime tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('issues a runtime token for an installed agent', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    const installation = {
      agentName: 'commonly-bot',
      podId: 'pod-1',
      status: 'active',
      runtimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };

    AgentInstallation.findOne.mockResolvedValue(installation);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Local dev' });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect(installation.runtimeTokens.length).toBe(1);
    expect(installation.save).toHaveBeenCalled();
  });

  it('issues a user token for an installed agent', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'clawd-bot',
      podId: 'pod-1',
      status: 'active',
    });

    const agentUser = {
      _id: 'agent-1',
      apiTokenCreatedAt: new Date('2026-01-01T00:00:00Z'),
      generateApiToken: jest.fn().mockReturnValue('cm_token_123'),
      save: jest.fn().mockResolvedValue(true),
    };

    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/clawd-bot/user-token')
      .send({ scopes: ['agent:events:read', 'agent:messages:write', 'invalid:scope'] });

    expect(res.status).toBe(200);
    expect(res.body.token).toBe('cm_token_123');
    expect(res.body.scopes).toEqual(['agent:events:read', 'agent:messages:write']);
    expect(agentUser.generateApiToken).toHaveBeenCalled();
    expect(agentUser.save).toHaveBeenCalled();
  });

  it('returns user token metadata when present', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'clawd-bot',
      podId: 'pod-1',
      status: 'active',
    });

    User.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        username: 'clawd-bot',
        apiToken: 'cm_token_123',
        apiTokenCreatedAt: new Date('2026-01-01T00:00:00Z'),
        apiTokenScopes: ['agent:context:read'],
      }),
    });

    const res = await request(app)
      .get('/api/registry/pods/pod-1/agents/clawd-bot/user-token');

    expect(res.status).toBe(200);
    expect(res.body.hasToken).toBe(true);
    expect(res.body.scopes).toEqual(['agent:context:read']);
  });

  it('revokes user token for an installed agent', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'clawd-bot',
      podId: 'pod-1',
      status: 'active',
    });

    const agentUser = {
      revokeApiToken: jest.fn(),
      save: jest.fn().mockResolvedValue(true),
    };
    User.findOne.mockResolvedValue(agentUser);

    const res = await request(app)
      .delete('/api/registry/pods/pod-1/agents/clawd-bot/user-token');

    expect(res.status).toBe(200);
    expect(agentUser.revokeApiToken).toHaveBeenCalled();
    expect(agentUser.save).toHaveBeenCalled();
  });
});
