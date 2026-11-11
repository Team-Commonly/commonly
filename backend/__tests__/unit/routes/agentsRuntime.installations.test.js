/** The runtime can verify the server-owned adapter binding before it spawns. */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const mockInstallation = {
  podId: 'pod-1',
  instanceId: 'writer',
  status: 'active',
  config: { runtime: { runtimeType: 'webhook', adapter: 'opencode', model: 'openai/gpt-5.4' } },
};

let mockAuthorizedPodIds = ['pod-1'];
let mockInstallations = null;
let mockPods = [{ _id: 'pod-1', name: 'Connector room', type: 'team' }];
let mockAgentUser = null;

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = mockAgentUser || { _id: 'agent-1', username: 'writer' };
  req.agentInstallation = mockInstallation;
  req.agentInstallations = mockInstallations || [mockInstallation];
  req.agentAuthorizedPodIds = mockAuthorizedPodIds;
  next();
});
jest.mock('../../../middleware/auth', () => (_req, _res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (_req, _res, next) => next(),
}));
// Honours the select list, so a field the route forgets to select reads as absent.
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(() => ({
    select: (fields) => ({
      lean: async () => mockPods.map((pod) => Object.fromEntries(
        Object.entries(pod).filter(([key]) => fields.split(' ').includes(key)),
      )),
    }),
  })),
}));
jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/hostedRuntimeService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: ['agent-room', 'agent-dm'],
  buildAgentUsername: jest.fn((name) => name),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../../models/File', () => ({}));
jest.mock('../../../services/objectStore', () => ({
  getObjectStore: jest.fn(() => ({ capabilities: { maxObjectBytes: 1024 } })),
}));
jest.mock('../../../models/integrationPublicConfig', () => ({ toPublicIntegrationConfig: jest.fn() }));
jest.mock('../../../routes/registry/helpers', () => ({ isGlobalAdminUser: jest.fn() }));
jest.mock('../../../middleware/agentRateLimit', () => ({ agentRateLimitKeyGenerator: jest.fn(() => 'agent-test') }));
jest.mock('../../../middleware/ipRateLimit', () => ({ cloudflareIpRateLimitKeyGenerator: jest.fn(() => 'ip-test') }));
jest.mock('../../../utils/discordBotToken', () => ({ resolveDiscordBotToken: jest.fn() }));
jest.mock('../../../middleware/rateLimitObserver', () => ({ rateLimitObserver: jest.fn((_req, _res, next) => next()) }));

const express = require('express');
const request = require('supertest');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

describe('GET /installations runtime adapter projection', () => {
  test('returns only the server-owned adapter binding needed by the CLI', async () => {
    const response = await request(app).get('/api/agents/runtime/installations');

    expect(response.status).toBe(200);
    expect(response.body.installations).toEqual([expect.objectContaining({
      podId: 'pod-1',
      instanceId: 'writer',
      runtimeAdapter: 'opencode',
      type: 'installation',
    })]);
    expect(response.body.installations[0]).not.toHaveProperty('model');
    expect(response.body.installations[0]).not.toHaveProperty('config');
  });

  // D247: the listener reads the row Settings reads, the oldest active one that
  // declares a seat, so it never runs a sibling row's model Settings doesn't show.
  test('names the Settings source installation, or null when none declares a seat', async () => {
    const config = mockInstallation.config;
    try {
      mockInstallation.config = { runtime: { runtimeType: 'webhook', adapter: 'codex' } };
      const declared = await request(app).get('/api/agents/runtime/installations');
      expect(declared.body.runtimeSourcePodId).toBe('pod-1');
      mockInstallation.config = { environment: {} };
      const silent = await request(app).get('/api/agents/runtime/installations');
      expect(silent.body.runtimeSourcePodId).toBeNull();
    } finally {
      mockInstallation.config = config;
    }
  });

  // An auto-joined row (installedBy the agent itself) copies the source's
  // config but is never what Settings reads, even when it is the oldest.
  test('the source skips a row the agent installed itself', async () => {
    mockInstallations = [
      { _id: 'a1', podId: 'pod-auto', instanceId: 'writer', status: 'active', installedBy: 'agent-1',
        config: { runtime: { runtimeType: 'webhook', adapter: 'codex' }, environment: { model: 'auto-model' } } },
      { _id: 'b2', podId: 'pod-1', instanceId: 'writer', status: 'active', installedBy: 'owner-1',
        config: { runtime: { runtimeType: 'webhook', adapter: 'codex' } } },
    ];
    try {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.runtimeSourcePodId).toBe('pod-1');
    } finally {
      mockInstallations = null;
    }
  });

  // D247: a listener seat (`agent run`, no daemon) reads its saved model and
  // effort here before each turn, so a Settings change reaches its next spawn.
  test('projects the saved model and effort controls, and nothing else from the environment', async () => {
    const config = mockInstallation.config;
    mockInstallation.config = { runtime: { runtimeType: 'webhook', adapter: 'codex', model: 'legacy-model' },
      environment: { model: 'gpt-6-sol', effort: 'xhigh', provider: { id: 'p', keyFile: '/secret' } } };
    try {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.installations[0].runtimeControls).toEqual({ model: 'gpt-6-sol', effort: 'xhigh' });
      mockInstallation.config = { runtime: { runtimeType: 'webhook', model: 'legacy-model' },
        environment: { effort: 'bad\nvalue' } };
      const legacy = await request(app).get('/api/agents/runtime/installations');
      expect(legacy.body.installations[0].runtimeControls).toEqual({ model: 'legacy-model' });
    } finally {
      mockInstallation.config = config;
    }
  });

  test.each(['pi', 'codex'])('adapter-shaped legacy runtimeType %s projects the resolved binding', async (runtimeType) => {
    const config = mockInstallation.config;
    mockInstallation.config = { runtime: { runtimeType, host: 'byo' } };
    try {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.status).toBe(200);
      expect(response.body.installations[0].runtimeAdapter).toBe(runtimeType);
    } finally {
      mockInstallation.config = config;
    }
  });

  test('known runtime kinds do not masquerade as a local adapter binding', async () => {
    const config = mockInstallation.config;
    mockInstallation.config = { runtime: { runtimeType: 'webhook', host: 'byo' } };
    try {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.status).toBe(200);
      expect(response.body.installations[0].runtimeAdapter).toBeNull();
    } finally {
      mockInstallation.config = config;
    }
  });
});

// A `workspace`-trust CLI seat runs a turn with its start directory readable only
// when every room it answers in is private (TASK-294), and this list is where it
// learns that.
describe('GET /installations pod visibility', () => {
  const withPods = async (pods, authorized, run) => {
    const [savedPods, savedAuthorized] = [mockPods, mockAuthorizedPodIds];
    mockPods = pods;
    mockAuthorizedPodIds = authorized;
    try {
      await run();
    } finally {
      mockPods = savedPods;
      mockAuthorizedPodIds = savedAuthorized;
    }
  };

  test('a pod with no stored visibility is reported private, as the effective booleans', async () => {
    await withPods([{ _id: 'pod-1', name: 'Room', type: 'team' }], ['pod-1'], async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.status).toBe(200);
      expect(response.body.installations[0]).toMatchObject({ publicRead: false, communityListed: false });
    });
  });

  // An open pod an agent created admits any agent through self-install, listed
  // or not, so the CLI needs the join policy as well as the visibility.
  test('the join policy is reported, and a pod with none stored reads as open', async () => {
    await withPods([
      { _id: 'pod-1', name: 'Private', type: 'team', joinPolicy: 'invite-only' },
      { _id: 'pod-2', name: 'Open', type: 'team', joinPolicy: 'open' },
      { _id: 'pod-3', name: 'Legacy', type: 'team' },
    ], ['pod-1', 'pod-2', 'pod-3'], async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      const policy = Object.fromEntries(response.body.installations
        .map((entry) => [entry.podId, entry.joinPolicy]));
      expect(policy).toEqual({ 'pod-1': 'invite-only', 'pod-2': 'open', 'pod-3': 'open' });
    });
  });

  test('a publicly readable or listed pod is reported as such', async () => {
    await withPods([{
      _id: 'pod-1', name: 'Room', type: 'team', publicRead: true, communityListed: true,
    }], ['pod-1'], async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.installations[0]).toMatchObject({ publicRead: true, communityListed: true });
    });
  });

  test('a pod that no longer exists carries neither field, so the CLI cannot read it as private', async () => {
    await withPods([], ['pod-1'], async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.installations[0]).not.toHaveProperty('publicRead');
      expect(response.body.installations[0]).not.toHaveProperty('communityListed');
      expect(response.body.installations[0]).not.toHaveProperty('joinPolicy');
    });
  });

  test('DM pods the seat answers in carry the same fields', async () => {
    await withPods([
      { _id: 'pod-1', name: 'Room', type: 'team' },
      { _id: 'dm-1', name: 'DM', type: 'agent-room', publicRead: false, communityListed: false },
    ], ['pod-1', 'dm-1'], async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      const dm = response.body.installations.find((entry) => entry.podId === 'dm-1');
      expect(dm).toMatchObject({ type: 'dm', publicRead: false, communityListed: false });
    });
  });
});

// The MCP server's channel mode pushes a mention into a person's session only
// from senders it allows, and with no allowlist set that is the agent's owner.
// The token's own identity is the only one this can name.
describe('GET /installations owner', () => {
  const withState = async ({ user = null, installations = null }, run) => {
    [mockAgentUser, mockInstallations] = [user, installations];
    try {
      await run();
    } finally {
      [mockAgentUser, mockInstallations] = [null, null];
    }
  };
  const row = (podId, installedBy) => ({ _id: podId, podId, instanceId: 'writer', status: 'active', installedBy, config: {} });

  test('names the owner on record for a self-serve identity', async () => {
    await withState({
      user: { _id: 'agent-1', username: 'writer', botMetadata: { ownerUserId: 'owner-1' } },
      installations: [row('pod-1', 'someone-else')],
    }, async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.ownerUserId).toBe('owner-1');
    });
  });

  test('with no owner on record, names nobody even if one person installed every row', async () => {
    // A sole installer is not necessarily the person running the channel session,
    // so an unowned (legacy) identity defaults to nobody; the client must set an
    // explicit COMMONLY_MCP_CHANNEL_ALLOW.
    await withState({
      installations: [row('pod-1', 'owner-1'), row('pod-auto', 'agent-1'), row('pod-2', 'owner-1')],
    }, async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.ownerUserId).toBeNull();
    });
  });

  test('names nobody when installers disagree or a row has none', async () => {
    await withState({ installations: [row('pod-1', 'owner-1'), row('pod-2', 'owner-2')] }, async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.ownerUserId).toBeNull();
    });
    await withState({ installations: [row('pod-1', 'owner-1'), row('pod-2', undefined)] }, async () => {
      const response = await request(app).get('/api/agents/runtime/installations');
      expect(response.body.ownerUserId).toBeNull();
    });
  });
});

describe('GET /installations message wake', () => {
  test('names each pod\'s "Messages that wake it" choice', async () => {
    const row = (podId, wakeOnMessage) => ({
      _id: podId, podId, instanceId: 'writer', status: 'active', config: wakeOnMessage ? { wakeOnMessage } : {},
    });
    mockInstallations = [
      row('pod-1', null),
      row('pod-2', { enabled: true, humanOnly: true }),
      row('pod-3', { enabled: true }),
      row('pod-4', { enabled: 'true', humanOnly: true }),
    ];
    try {
      const response = await request(app).get('/api/agents/runtime/installations');
      const wake = Object.fromEntries(response.body.installations
        .filter((item) => item.type === 'installation')
        .map((item) => [item.podId, item.messageWake]));
      expect(wake).toEqual({ 'pod-1': 'mentions', 'pod-2': 'human', 'pod-3': 'all', 'pod-4': 'mentions' });
    } finally {
      mockInstallations = null;
    }
  });
});
