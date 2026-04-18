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
      instanceId: 'default',
      displayName: 'Commonly Bot',
      status: 'active',
      runtimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };
    const agentUser = {
      agentRuntimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };

    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Local dev' });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect(agentUser.agentRuntimeTokens.length).toBe(1);
    expect(installation.runtimeTokens.length).toBe(1);
    expect(installation.save).toHaveBeenCalled();
    expect(agentUser.save).toHaveBeenCalled();
  });

  it('returns {existing:true} (no token) when agent user already has runtime tokens', async () => {
    // Documents the regressive default behavior: detach preserves the
    // agent User row's hashed token (ADR-001 identity-continuity), so a
    // re-attach hits this branch and the CLI gets nothing usable back.
    // The fix is the next test (force:true).
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1', createdBy: 'user-1', members: ['user-1'],
      }),
    });
    const installation = {
      agentName: 'commonly-bot',
      podId: 'pod-1',
      instanceId: 'default',
      displayName: 'Commonly Bot',
      status: 'active',
      runtimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };
    const agentUser = {
      agentRuntimeTokens: [{ tokenHash: 'stale', label: 'old', createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
    };
    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Re-attach' });

    expect(res.status).toBe(200);
    expect(res.body.existing).toBe(true);
    expect(res.body.token).toBeUndefined();
  });

  it('with force:true, clears existing tokens and mints a fresh one (detach + reattach race fix)', async () => {
    // ADR-005 detach + reattach: CLI deletes its local token file, but the
    // server-side hashed copy on the agent User row persists. Without
    // force:true, the next runtime-tokens POST returns {existing:true}
    // with no usable raw token. With force:true, the array is cleared
    // and a new token is minted, mirroring reprovision.ts/provision.ts.
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1', createdBy: 'user-1', members: ['user-1'],
      }),
    });
    const installation = {
      agentName: 'commonly-bot',
      podId: 'pod-1',
      instanceId: 'default',
      displayName: 'Commonly Bot',
      status: 'active',
      runtimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };
    const agentUser = {
      agentRuntimeTokens: [{ tokenHash: 'stale', label: 'old', createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
    };
    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Re-attach', force: true });

    expect(res.status).toBe(200);
    expect(res.body.token).toMatch(/^cm_agent_/);
    expect(res.body.existing).toBe(false);
    // The stale token is gone; only the fresh one remains.
    expect(agentUser.agentRuntimeTokens.length).toBe(1);
    expect(agentUser.agentRuntimeTokens[0].label).toBe('Re-attach');
  });

  it('lists shared runtime tokens from agent user', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'commonly-bot',
      podId: 'pod-1',
      instanceId: 'default',
      status: 'active',
    });
    User.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({
          agentRuntimeTokens: [
            {
              _id: 'token-1',
              label: 'Local dev',
              createdAt: new Date('2026-01-01T00:00:00Z'),
              lastUsedAt: null,
            },
          ],
        }),
      }),
    });

    const res = await request(app)
      .get('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens');

    expect(res.status).toBe(200);
    expect(res.body.tokens).toHaveLength(1);
    expect(res.body.tokens[0].label).toBe('Local dev');
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
    expect(res.body.scopeMode).toBe('scoped');
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
    expect(res.body.scopeMode).toBe('scoped');
  });

  it('returns full-access mode when user token has no explicit scopes', async () => {
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
        apiTokenScopes: [],
      }),
    });

    const res = await request(app)
      .get('/api/registry/pods/pod-1/agents/clawd-bot/user-token');

    expect(res.status).toBe(200);
    expect(res.body.hasToken).toBe(true);
    expect(res.body.scopes).toEqual([]);
    expect(res.body.scopeMode).toBe('all');
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
