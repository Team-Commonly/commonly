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
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    find: jest.fn(),
  },
  AgentInstallation: {
    getInstalledAgents: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/AgentTemplate', () => ({
  find: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

describe('registry list pod agents config payload', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns persisted config fields used by agent settings UI', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });
    AgentInstallation.getInstalledAgents.mockResolvedValue([
      {
        agentName: 'openclaw',
        instanceId: 'x-curator',
        displayName: 'X Curator',
        version: '1.0.0',
        status: 'active',
        scopes: ['integration:read'],
        createdAt: new Date('2026-02-07T00:00:00.000Z'),
        usage: {},
        installedBy: 'user-1',
        config: new Map(Object.entries({
          heartbeat: { enabled: true, everyMinutes: 60 },
          autonomy: { autoJoinAgentOwnedPods: true },
          errorRouting: { ownerDm: true },
          heartbeatChecklist: '- Check updates',
          skillSync: {
            mode: 'all', allPods: true, podIds: [], skillNames: [],
          },
        })),
      },
    ]);
    AgentRegistry.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });

    const res = await request(app).get('/api/registry/pods/pod-1/agents');

    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0].config).toEqual({
      heartbeat: { enabled: true, everyMinutes: 60 },
      autonomy: { autoJoinAgentOwnedPods: true },
      errorRouting: { ownerDm: true },
      heartbeatChecklist: '- Check updates',
      skillSync: {
        mode: 'all', allPods: true, podIds: [], skillNames: [],
      },
    });
  });
});
