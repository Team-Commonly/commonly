// These unit cases isolate runtime identity behavior. The deletion fence is
// exercised with real models in service/accountDeletion.test.js.
jest.mock('../../../services/accountDeletionState', () => ({ isAccountDeleting: jest.fn().mockResolvedValue(false) }));
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
    exists: jest.fn().mockResolvedValue(null),
    findOne: jest.fn(),
    find: jest.fn(() => ({
      collation: jest.fn(function collation() { return this; }),
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })),
    })),
    updateMany: jest.fn(() => ({
      collation: jest.fn(() => Promise.resolve({ modifiedCount: 0 })),
    })),
  },
}));
jest.mock('../../../models/AgentCredential', () => ({
  updateMany: jest.fn().mockResolvedValue({ modifiedCount: 0 }),
  updateOne: jest.fn().mockResolvedValue({ upsertedCount: 1 }),
  create: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  // isGlobalAdminUser reads the caller's role; these tests are about issuance.
  findById: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve({ role: 'user' }) }) })),
}));
// Ownership (sole installer) has its own suite: registry.runtimeTokenOwnership.
// Here the caller owns the identity, so the arms below test issuance itself.
jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ownsRuntimeIdentity: jest.fn().mockResolvedValue({ owned: true }),
  runtimeCredentialRefusal: {},
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
const AgentCredential = require('../../../models/AgentCredential');
const User = require('../../../models/User');
const AgentIdentityService = require('../../../services/agentIdentityService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('agent runtime tokens', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentInstallation.find.mockImplementation(() => ({
      collation: jest.fn(function collation() { return this; }),
      select: jest.fn(() => ({ lean: jest.fn().mockResolvedValue([]) })),
    }));
    AgentCredential.updateMany.mockResolvedValue({ modifiedCount: 0 });
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

  // An agent Commonly runs in-process
  // (native, or hosted on the native engine) holds no runtime token.
  const mintFor = async (agentName, config) => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'user-1', members: ['user-1'] }),
    });
    const installation = {
      agentName, podId: 'pod-1', instanceId: 'default', status: 'active', installedBy: 'user-1',
      config, runtimeTokens: [], save: jest.fn().mockResolvedValue(true),
    };
    const agentUser = { agentRuntimeTokens: [], botMetadata: { agentName }, save: jest.fn() };
    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentInstallation.exists.mockResolvedValueOnce({ _id: 'inst-1' });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);
    const res = await request(app)
      .post(`/api/registry/pods/pod-1/agents/${agentName}/runtime-tokens`)
      .send({ label: 'try it' });
    return { res, agentUser };
  };

  it.each([
    ['a hosted agent on the native engine', 'maya-agent', { runtime: { runtimeType: 'hosted' }, hosted: { engine: 'native', provisionedAt: new Date() } }],
    ['a plain native agent such as Scout', 'scout', { runtime: { runtimeType: 'native' } }],
  ])('refuses to mint for %s, with a 409 that says why', async (_label, agentName, config) => {
    const { res, agentUser } = await mintFor(agentName, config);
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('in_process_agent_no_token');
    expect(agentUser.agentRuntimeTokens).toHaveLength(0);
  });

  // A mint that passed the in-process check can still be
  // saving when a migration marks the identity in-process. The issuer
  // re-checks after its save and takes the token back.
  it('a mint whose identity went in-process while it was saving takes its token back and refuses', async () => {
    const User = require('../../../models/User');
    const AgentCredential = require('../../../models/AgentCredential');
    if (!User.updateMany) User.updateMany = jest.fn();
    User.updateMany.mockResolvedValue({ modifiedCount: 1 });
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'user-1', members: ['user-1'] }),
    });
    const installation = {
      agentName: 'maya-agent', podId: 'pod-1', instanceId: 'default', status: 'active', installedBy: 'user-1',
      config: { runtime: { runtimeType: 'hosted' } }, runtimeTokens: [], save: jest.fn().mockResolvedValue(true),
    };
    const agentUser = { agentRuntimeTokens: [], botMetadata: { agentName: 'maya-agent' }, save: jest.fn().mockResolvedValue(true) };
    AgentInstallation.findOne.mockResolvedValue(installation);
    // Not in-process at the check; in-process by the time the save landed.
    AgentInstallation.exists.mockResolvedValueOnce(null).mockResolvedValueOnce({ _id: 'inst-1' });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);

    const res = await request(app)
      .post('/api/registry/pods/pod-1/agents/maya-agent/runtime-tokens')
      .send({ label: 'racing a migration' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('in_process_agent_no_token');
    expect(res.body.token).toBeUndefined();
    const savedHash = agentUser.agentRuntimeTokens[0].tokenHash;
    expect(AgentCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: { $in: [savedHash] } }), expect.anything(),
    );
    expect(User.updateMany).toHaveBeenCalledWith(
      { 'agentRuntimeTokens.tokenHash': savedHash }, { $pull: { agentRuntimeTokens: { tokenHash: savedHash } } },
    );
  });

  it('matches every in-process shape in any spelling, and nothing else', async () => {
    await mintFor('scout', { runtime: { runtimeType: 'native' } });
    const [query] = AgentInstallation.exists.mock.calls[0];
    expect(query.status).toBe('active');
    const [, runtimeRule] = query.$and;
    const matches = (doc) => runtimeRule.$or.some((branch) => Object.entries(branch)
      .every(([field, cond]) => cond.$regex.test(doc[field] || '')));
    expect(matches({ 'config.runtime.runtimeType': ' Native ' })).toBe(true);
    expect(matches({ 'config.runtime.runtimeType': 'HOSTED', 'config.hosted.engine': 'native' })).toBe(true);
    expect(matches({ 'config.runtime.runtimeType': 'hosted' })).toBe(false); // Durable Object engine
    expect(matches({ 'config.runtime.runtimeType': 'webhook' })).toBe(false);
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
    expect(AgentCredential.updateMany).toHaveBeenCalledWith(
      { tokenHash: { $in: ['stale'] }, kind: 'runtime', status: 'active' },
      { $set: expect.objectContaining({ status: 'revoked', revokedAt: expect.any(Date) }) },
    );
    expect(AgentInstallation.updateMany).toHaveBeenCalledWith(
      { agentName: 'commonly-bot', instanceId: 'default' },
      { $set: { runtimeTokens: [] } },
    );
  });

  it('treats an installation-only token as existing and force rotation clears its copy', async () => {
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
      runtimeTokens: [{ tokenHash: 'legacy-installation', label: 'legacy', createdAt: new Date() }],
      save: jest.fn().mockResolvedValue(true),
    };
    const agentUser = {
      agentRuntimeTokens: [],
      save: jest.fn().mockResolvedValue(true),
    };
    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentInstallation.find.mockReturnValue({
      collation: jest.fn(function collation() { return this; }),
      select: jest.fn(() => ({
        lean: jest.fn().mockResolvedValue([{ runtimeTokens: installation.runtimeTokens }]),
      })),
    });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue(agentUser);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);

    const existing = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Re-attach' });
    expect(existing.status).toBe(200);
    expect(existing.body.existing).toBe(true);
    expect(existing.body.token).toBeUndefined();

    const rotated = await request(app)
      .post('/api/registry/pods/pod-1/agents/commonly-bot/runtime-tokens')
      .send({ label: 'Re-attach', force: true });
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).toMatch(/^cm_agent_/);
    expect(rotated.body.existing).toBe(false);
    expect(AgentCredential.updateMany).toHaveBeenCalledWith(
      { tokenHash: { $in: ['legacy-installation'] }, kind: 'runtime', status: 'active' },
      { $set: expect.objectContaining({ status: 'revoked', revokedAt: expect.any(Date) }) },
    );
    expect(installation.runtimeTokens).toHaveLength(1);
    expect(installation.runtimeTokens[0].tokenHash).not.toBe('legacy-installation');
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
      // apiToken is select:false, so the route asks for it explicitly.
      select: jest.fn().mockReturnThis(),
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
      // apiToken is select:false, so the route asks for it explicitly.
      select: jest.fn().mockReturnThis(),
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
