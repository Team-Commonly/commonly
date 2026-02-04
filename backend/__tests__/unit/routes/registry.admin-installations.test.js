const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'admin-1' };
  req.userId = 'admin-1';
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    countDocuments: jest.fn(),
    find: jest.fn(),
    findById: jest.fn(),
  },
}));

jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/AgentProfile', () => ({
  deleteOne: jest.fn(),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: jest.fn((agentName) => agentName),
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  removeAgentFromPod: jest.fn(),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const AgentIdentityService = require('../../../services/agentIdentityService');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const buildLeanChain = (result) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(result),
  }),
});

describe('admin agent installations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('lists installations across pods', async () => {
    AgentInstallation.countDocuments.mockResolvedValue(1);

    const installation = {
      _id: 'install-1',
      agentName: 'openclaw',
      instanceId: 'default',
      displayName: 'Cuz',
      version: '1.0.0',
      status: 'active',
      podId: 'pod-1',
      installedBy: 'user-1',
      runtimeTokens: [{ _id: 'token-1', label: 'Local dev' }],
      usage: { lastUsedAt: new Date('2026-02-01T00:00:00Z') },
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-02-01T00:00:00Z'),
    };

    AgentInstallation.find.mockReturnValue({
      sort: jest.fn().mockReturnValue({
        skip: jest.fn().mockReturnValue({
          limit: jest.fn().mockResolvedValue([installation]),
        }),
      }),
    });

    Pod.find.mockReturnValue(buildLeanChain([
      { _id: 'pod-1', name: 'Alpha', createdBy: 'user-2' },
    ]));

    User.find.mockReturnValue(buildLeanChain([
      { _id: 'user-1', username: 'installer', email: 'inst@test.com', role: 'admin' },
      { _id: 'user-2', username: 'owner', email: 'owner@test.com', role: 'admin' },
    ]));

    const res = await request(app)
      .get('/api/registry/admin/installations?status=all');

    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.installations).toHaveLength(1);
    expect(res.body.installations[0].pod.name).toBe('Alpha');
    expect(res.body.installations[0].installedBy.username).toBe('installer');
  });

  it('revokes a runtime token for an installation', async () => {
    const installation = {
      _id: 'install-2',
      runtimeTokens: [{ _id: 'token-1' }, { _id: 'token-2' }],
      save: jest.fn().mockResolvedValue(true),
    };

    AgentInstallation.findById.mockResolvedValue(installation);

    const res = await request(app)
      .delete('/api/registry/admin/installations/install-2/runtime-tokens/token-1');

    expect(res.status).toBe(200);
    expect(installation.runtimeTokens).toHaveLength(1);
    expect(installation.save).toHaveBeenCalled();
  });

  it('uninstalls an installation', async () => {
    const installation = {
      _id: 'install-3',
      agentName: 'openclaw',
      instanceId: 'default',
      podId: 'pod-1',
      status: 'active',
      save: jest.fn().mockResolvedValue(true),
    };

    AgentInstallation.findById.mockResolvedValue(installation);
    AgentProfile.deleteOne.mockResolvedValue(true);
    AgentIdentityService.removeAgentFromPod.mockResolvedValue(true);

    const res = await request(app)
      .delete('/api/registry/admin/installations/install-3');

    expect(res.status).toBe(200);
    expect(installation.status).toBe('uninstalled');
    expect(installation.save).toHaveBeenCalled();
    expect(AgentProfile.deleteOne).toHaveBeenCalled();
    expect(AgentIdentityService.removeAgentFromPod).toHaveBeenCalled();
  });
});
