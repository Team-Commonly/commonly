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
jest.mock('../../../models/AgentEvent', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));

// User.find is called inside the GET /pods/:podId/agents handler to resolve
// botMetadata.displayName for each install. Without a mock the handler waits
// on the real Mongoose model (no DB connection in this unit test) and times
// out at 10s.
jest.mock('../../../models/User', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  }),
}));

// dmService.canViewPod is required at runtime via require(); the handler's
// first call is `await DMService.canViewPod(userId, pod)`. The real
// implementation reads `Pod.countDocuments` which isn't on our jest mock —
// stub the whole service so the test exercises the route, not auth fan-out.
jest.mock('../../../services/dmService', () => ({
  canViewPod: jest.fn().mockResolvedValue(true),
}));

// AgentIdentityService surface used by helpers.ts. Two import shapes are
// consumed: (a) the named export `buildAgentUsername` (used by the route
// handler to compose user lookup keys) and (b) `.default` (used by
// `sanitizeRuntimeConfig` to call `getAgentTypeConfig` for the runtime
// fallback). Mock both — without `.default`, the helper crashes the route
// with "Cannot read properties of undefined (reading 'getAgentTypeConfig')"
// and the test sees a 500 instead of 200.
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId) => `${agentName}-${instanceId}`),
  default: {
    getAgentTypeConfig: jest.fn().mockReturnValue(null),
  },
}));

// `helpers.ts` reads PRESET_DEFINITIONS at module load to build a presetId
// → category map. The real preset file is heavyweight (2900+ lines and
// pulls in skill-bundle code). Stub it with an empty list — the test
// fixture doesn't set `config.presetId` anyway, so category resolution
// stays null either way.
jest.mock('../../../routes/registry/presets', () => ({
  PRESET_DEFINITIONS: [],
  DEFAULT_BRANCH: 'main',
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
      presetId: null,
      customizations: null,
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
