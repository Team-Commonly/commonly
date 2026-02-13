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
    findOne: jest.fn(),
  },
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  findOne: jest.fn(),
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

describe('registry get installed pod agent', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the latest persisted installation payload for an instance', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });

    AgentInstallation.findOne.mockResolvedValue({
      agentName: 'openclaw',
      instanceId: 'x-curator',
      displayName: 'X Curator',
      version: '1.0.0',
      status: 'active',
      scopes: ['integration:read', 'integration:messages:read'],
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
    });
    AgentRegistry.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue({ iconUrl: 'https://example.com/icon.png' }),
      }),
    });
    AgentProfile.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        name: 'X Curator',
        purpose: 'Curates social updates',
        isDefault: false,
        modelPreferences: { preferred: 'gemini-2.5-pro' },
        instructions: 'Keep it concise',
        persona: { tone: 'friendly' },
        toolPolicy: { allowed: ['commonly'] },
        contextPolicy: { includeMemory: true },
      }),
    });
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });

    const res = await request(app)
      .get('/api/registry/pods/pod-1/agents/openclaw?instanceId=x-curator');

    expect(res.status).toBe(200);
    expect(res.body.agent).toMatchObject({
      name: 'openclaw',
      instanceId: 'x-curator',
      iconUrl: 'https://example.com/icon.png',
      config: {
        heartbeat: { enabled: true, everyMinutes: 60 },
        autonomy: { autoJoinAgentOwnedPods: true },
        errorRouting: { ownerDm: true },
        heartbeatChecklist: '- Check updates',
        skillSync: {
          mode: 'all', allPods: true, podIds: [], skillNames: [],
        },
      },
      profile: {
        displayName: 'X Curator',
        instructions: 'Keep it concise',
      },
    });
  });
});
