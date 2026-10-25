/** The runtime can verify the server-owned adapter binding before it spawns. */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

let mockOperatorAllowed = true;
jest.mock('../../../services/operatorOnlyPodPolicy', () => ({ operatorOnlyPodAllowed: jest.fn(async () => mockOperatorAllowed) }));

const mockInstallation = {
  podId: 'pod-1',
  instanceId: 'writer',
  status: 'active',
  config: { runtime: { runtimeType: 'webhook', adapter: 'opencode', model: 'openai/gpt-5.4' } },
};

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { _id: 'agent-1', username: 'writer' };
  req.agentInstallation = mockInstallation;
  req.agentInstallations = [mockInstallation];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (_req, _res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (_req, _res, next) => next(),
}));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(() => ({
    select: () => ({ lean: async () => [{ _id: 'pod-1', name: 'Connector room', type: 'team' }] }),
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

describe('GET /pods/:podId/operator-only', () => {
  test('projects authenticated identity or refuses without private details', async () => {
    mockOperatorAllowed = true;
    const ok = await request(app).get('/api/agents/runtime/pods/pod-1/operator-only');
    expect(ok.status).toBe(200);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect(ok.body).toEqual({ allowed: true, podId: 'pod-1', instanceId: 'writer' });
    mockOperatorAllowed = false;
    const denied = await request(app).get('/api/agents/runtime/pods/pod-1/operator-only');
    expect(denied.status).toBe(403);
  });
  test('database failure refuses instead of authorizing', async () => {
    require('../../../services/operatorOnlyPodPolicy').operatorOnlyPodAllowed.mockRejectedValueOnce(Error('DB unavailable'));
    const result = await request(app).get('/api/agents/runtime/pods/pod-1/operator-only');
    expect(result.status).toBe(503);
    expect(result.body).not.toHaveProperty('allowed');
  });
});
