/** The runtime can verify the server-owned adapter binding before it spawns. */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const mockInstallation = {
  podId: 'pod-1',
  instanceId: 'writer',
  status: 'active',
  config: { runtime: { runtimeType: 'webhook', adapter: 'opencode', model: 'openai/gpt-5.4' } },
};

let mockAuthorizedPodIds = ['pod-1'];
let mockPods = [{ _id: 'pod-1', name: 'Connector room', type: 'team' }];

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { _id: 'agent-1', username: 'writer' };
  req.agentInstallation = mockInstallation;
  req.agentInstallations = [mockInstallation];
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
