const request = require('supertest');
const express = require('express');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(() => 't'), verify: jest.fn(), decode: jest.fn() }));

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
jest.mock('../../../models/AgentCredential', () => ({
  find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
}));
jest.mock('../../../models/Machine', () => ({
  find: jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) }),
}));

jest.mock('../../../models/AgentEvent', () => ({
  aggregate: jest.fn().mockResolvedValue([]),
}));

// User.find provides the portable principal that also labels chat authors.
jest.mock('../../../models/User', () => ({
  find: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    }),
  }),
  // isGlobalAdminUser: the viewer's role, for the webhookUrl reveal.
  findById: jest.fn().mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ role: 'user' }),
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
  resolveAgentDisplayLabel: jest.fn((user, fallback) => user.botMetadata?.displayName || user.username || fallback),
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
const User = require('../../../models/User');
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
          wakeOnMessage: { enabled: true, humanOnly: true },
          boardWake: { enabled: false },
          autonomy: { autoJoinAgentOwnedPods: true },
          errorRouting: { ownerDm: true },
          heartbeatChecklist: '- Check updates',
          skillSync: {
            mode: 'all', allPods: true, podIds: [], skillNames: [],
          },
          runtime: {
            runtimeType: 'webhook',
            webhookUrl: 'https://agent.example.test/events',
            webhookSecret: 'member-only-secret',
            authProfiles: {
              'openai:default': { type: 'api_key', provider: 'openai', key: 'member-api-key' },
            },
            skillEnv: { github: { GITHUB_TOKEN: 'member-github-token' } },
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
      environment: {},
      heartbeat: { enabled: true, everyMinutes: 60 },
      wakeOnMessage: { enabled: true, humanOnly: true },
      boardWake: { enabled: false },
      autonomy: { autoJoinAgentOwnedPods: true },
      errorRouting: { ownerDm: true },
      heartbeatChecklist: '- Check updates',
      skillSync: {
        mode: 'all', allPods: true, podIds: [], skillNames: [],
      },
    });
    expect(res.body.agents[0].runtime).toEqual(expect.objectContaining({
      runtimeType: 'webhook',
      webhookUrl: 'https://agent.example.test/events',
      authProviders: ['openai'],
      hasCustomAuthProfiles: true,
      hasCustomSkillEnv: true,
      skillEnvKeys: ['github'],
    }));
    expect(res.body.agents[0].runtime).not.toHaveProperty('webhookSecret');
  });

  // Cofounder's hardening ruling (2026-10-21): every pod member reads this
  // roster, and a push webhook's URL can carry a credential in its query
  // string, so only the installer and instance admins see it.
  describe('a push webhook URL is shown only to its installer and instance admins', () => {
    const SECRET_URL = 'https://agent.example.test/events?secret=s3cr3t';
    const seedWebhookAgent = (installedBy) => {
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', createdBy: 'someone-else', members: ['user-1', 'user-2'] }),
      });
      AgentInstallation.getInstalledAgents.mockResolvedValue([{
        agentName: 'webhook-bot',
        instanceId: 'default',
        displayName: 'Webhook Bot',
        status: 'active',
        scopes: [],
        usage: {},
        installedBy,
        config: new Map(Object.entries({ runtime: { runtimeType: 'webhook', webhookUrl: SECRET_URL } })),
      }]);
      AgentRegistry.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      AgentTemplate.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    };
    const viewerRole = (role) => User.findById.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ role }) }),
    });

    it('another member sees the runtime but never the URL', async () => {
      seedWebhookAgent('user-2');
      viewerRole('user');
      const res = await request(app).get('/api/registry/pods/pod-1/agents');
      expect(res.status).toBe(200);
      expect(res.body.agents[0].runtime).toEqual(expect.objectContaining({ runtimeType: 'webhook' }));
      expect(res.body.agents[0].runtime).not.toHaveProperty('webhookUrl');
      expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
    });

    it.each(['map', 'object'])('keeps push connection semantics independent of URL visibility (%s config)', async (shape) => {
      User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([{
        _id: 'bot-1', username: 'webhook-bot-default', botMetadata: {}, agentRuntimeTokens: [],
      }]) }) });
      viewerRole('user');
      const read = async (installer, url) => {
        seedWebhookAgent(installer);
        const [installation] = await AgentInstallation.getInstalledAgents();
        const config = { runtime: { runtimeType: 'webhook', ...(url && { webhookUrl: url }) } };
        installation.config = shape === 'map' ? new Map(Object.entries(config)) : config;
        const res = await request(app).get('/api/registry/pods/pod-1/agents');
        expect(res.status).toBe(200);
        return res.body.agents[0];
      };
      const installer = await read('user-1', SECRET_URL);
      const peer = await read('user-2', SECRET_URL);
      expect(installer.runtime.webhookUrl).toBe(SECRET_URL);
      expect(peer.runtime).not.toHaveProperty('webhookUrl');
      expect(installer).not.toHaveProperty('connection');
      expect(peer).not.toHaveProperty('connection');
      // A poll-based webhook still derives connection health: prove the
      // credential lookup was available, rather than taking its catch path.
      const polling = await read('user-2', null);
      expect(polling).toHaveProperty('connection.state');
      User.find.mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }) });
    });

    it('a caller that does not opt in gets no URL (the builder fails closed)', () => {
      // eslint-disable-next-line global-require
      const { buildAgentInstallationPayload } = require('../../../routes/registry/helpers');
      const payload = buildAgentInstallationPayload({
        agentName: 'webhook-bot', instanceId: 'default', status: 'active', scopes: [], usage: {},
        config: new Map(Object.entries({ runtime: { runtimeType: 'webhook', webhookUrl: SECRET_URL } })),
      });
      expect(payload.runtime).not.toHaveProperty('webhookUrl');
      expect(payload.runtime.runtimeType).toBe('webhook');
    });

    it('the installer sees the URL', async () => {
      seedWebhookAgent('user-1');
      const res = await request(app).get('/api/registry/pods/pod-1/agents');
      expect(res.body.agents[0].runtime.webhookUrl).toBe(SECRET_URL);
      expect(User.findById).not.toHaveBeenCalled();
    });

    it('an instance admin sees the URL', async () => {
      seedWebhookAgent('user-2');
      viewerRole('admin');
      const res = await request(app).get('/api/registry/pods/pod-1/agents');
      expect(res.body.agents[0].runtime.webhookUrl).toBe(SECRET_URL);
    });

    it('the single-agent route withholds it the same way', async () => {
      seedWebhookAgent('user-2');
      viewerRole('user');
      const [installation] = await AgentInstallation.getInstalledAgents();
      AgentInstallation.findOne = jest.fn().mockResolvedValue(installation);
      AgentRegistry.findOne = jest.fn().mockReturnValue({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) });
      AgentProfile.findOne = jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });
      const res = await request(app).get('/api/registry/pods/pod-1/agents/webhook-bot?instanceId=default');
      if (res.status === 200) {
        expect(res.body.agent.runtime).not.toHaveProperty('webhookUrl');
        expect(JSON.stringify(res.body)).not.toContain('s3cr3t');
      } else {
        throw new Error(`single-agent route answered ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
      }
    });
  });

  it('uses the chat principal label when scoped labels differ', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-1',
        createdBy: 'user-1',
        members: ['user-1'],
      }),
    });
    AgentInstallation.getInstalledAgents.mockResolvedValue([
      {
        agentName: 'cl-strategist',
        instanceId: 'strategist-fable',
        displayName: 'Strategist (Claude)',
        version: '1.0.0',
        status: 'active',
        scopes: [],
        usage: {},
      },
    ]);
    AgentRegistry.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          agentName: 'cl-strategist',
          instanceId: 'strategist-fable',
          name: 'Strategist (Claude)',
        },
      ]),
    });
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([]) }),
    });
    const selectUserFields = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          username: 'cl-strategist-strategist-fable',
          profilePicture: '/api/uploads/strategist-account.png',
          botMetadata: { displayName: 'Strategist (Fable)' },
        },
      ]),
    });
    User.find.mockReturnValue({ select: selectUserFields });

    const res = await request(app).get('/api/registry/pods/pod-1/agents');

    expect(res.status).toBe(200);
    expect(res.body.agents[0].displayName).toBe('Strategist (Fable)');
    expect(selectUserFields).toHaveBeenCalledWith(expect.stringContaining('profilePicture'));
    expect(res.body.agents[0].profilePicture).toBe('/api/uploads/strategist-account.png');
  });
});
