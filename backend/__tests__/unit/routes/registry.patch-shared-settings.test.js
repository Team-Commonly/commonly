const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {},
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  updateMany: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry shared agent settings', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('propagates installation config/scopes to same instance across accessible pods', async () => {
    const primaryInstall = {
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'x-curator',
      status: 'active',
      scopes: ['integration:read'],
      config: new Map(Object.entries({
        heartbeat: { enabled: true, everyMinutes: 5 },
        autonomy: { autoJoinAgentOwnedPods: true },
      })),
      save: jest.fn().mockResolvedValue(true),
    };
    const secondaryInstall = {
      agentName: 'openclaw',
      podId: 'pod-2',
      instanceId: 'x-curator',
      status: 'active',
      scopes: ['integration:read'],
      config: new Map(Object.entries({
        heartbeat: { enabled: true, everyMinutes: 20 },
        autonomy: { autoJoinAgentOwnedPods: false },
      })),
      save: jest.fn().mockResolvedValue(true),
    };

    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'pod-1', createdBy: 'user-1', members: ['user-1'] },
          { _id: 'pod-2', createdBy: 'user-1', members: ['user-1'] },
        ]),
      }),
    });
    AgentInstallation.findOne.mockResolvedValue(primaryInstall);
    AgentInstallation.find.mockResolvedValue([primaryInstall, secondaryInstall]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({
        instanceId: 'x-curator',
        scopes: ['integration:read', 'integration:messages:read'],
        config: {
          heartbeat: { enabled: true, everyMinutes: 60 },
          autonomy: { autoJoinAgentOwnedPods: true },
          errorRouting: { ownerDm: true },
          heartbeatChecklist: '- Check latest activity',
        },
      });

    expect(res.status).toBe(200);
    expect(primaryInstall.save).toHaveBeenCalledTimes(1);
    expect(secondaryInstall.save).toHaveBeenCalledTimes(1);
    expect(primaryInstall.scopes).toEqual(['integration:read', 'integration:messages:read']);
    expect(secondaryInstall.scopes).toEqual(['integration:read', 'integration:messages:read']);
    expect(primaryInstall.config.get('heartbeat')).toEqual({ enabled: true, everyMinutes: 60 });
    expect(secondaryInstall.config.get('heartbeat')).toEqual({ enabled: true, everyMinutes: 60 });
    expect(primaryInstall.config.get('errorRouting')).toEqual({ ownerDm: true });
    expect(secondaryInstall.config.get('errorRouting')).toEqual({ ownerDm: true });
    expect(primaryInstall.config.get('heartbeatChecklist')).toBe('- Check latest activity');
    expect(secondaryInstall.config.get('heartbeatChecklist')).toBe('- Check latest activity');
    expect(res.body.updatedPods).toBe(2);
  });

  it('applies profile updates across the same instance pods', async () => {
    const primaryInstall = {
      agentName: 'openclaw',
      podId: 'pod-1',
      instanceId: 'x-curator',
      status: 'active',
      save: jest.fn().mockResolvedValue(true),
    };
    const secondaryInstall = {
      agentName: 'openclaw',
      podId: 'pod-2',
      instanceId: 'x-curator',
      status: 'active',
      save: jest.fn().mockResolvedValue(true),
    };

    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { _id: 'pod-1', createdBy: 'user-1', members: ['user-1'] },
          { _id: 'pod-2', createdBy: 'user-1', members: ['user-1'] },
        ]),
      }),
    });
    AgentInstallation.findOne.mockResolvedValue(primaryInstall);
    AgentInstallation.find.mockResolvedValue([primaryInstall, secondaryInstall]);

    const res = await request(app)
      .patch('/api/registry/pods/pod-1/agents/openclaw')
      .send({
        instanceId: 'x-curator',
        modelPreferences: { preferred: 'gemini-2.5-flash' },
        instructions: 'Keep reports concise.',
      });

    expect(res.status).toBe(200);
    expect(AgentProfile.updateMany).toHaveBeenCalledWith(
      {
        agentId: 'openclaw:x-curator',
        podId: { $in: ['pod-1', 'pod-2'] },
      },
      expect.objectContaining({
        modelPreferences: { preferred: 'gemini-2.5-flash' },
        instructions: 'Keep reports concise.',
      }),
    );
  });
});
