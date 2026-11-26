// F626
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const mockSourceConfig = { value: {} };
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallation = {
    agentName: 'openclaw', instanceId: 'nova', version: '1.0.0', config: mockSourceConfig.value, scopes: [], podId: '0123456789abcdef01234567',
  };
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

const podSave = jest.fn().mockResolvedValue(undefined);
const podPopulate = jest.fn().mockResolvedValue(undefined);
const mockFoundPod = { value: null };
const mockPodUpdateOne = jest.fn().mockResolvedValue({ modifiedCount: 1 });

jest.mock('../../../models/Pod', () => {
  const findOne = jest.fn(() => ({
    populate: () => ({ populate: async () => mockFoundPod.value }),
  }));
  // F619: the dedup join is one conditional updateOne, not push + save.
  return { findOne, find: jest.fn(), updateOne: mockPodUpdateOne, findById: jest.fn() };
});

const mockInstall = jest.fn().mockResolvedValue({});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn(), install: mockInstall },
}));

jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']),
  buildAgentUsername: jest.fn((a) => a),
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));

const express = require('express');
const request = require('supertest');
const router = require('../../../routes/agentsRuntime');

const AgentIdentityService = require('../../../services/agentIdentityService');
const { DRIVER_TEXT } = require('../../utils/routeHandler');

// F626: the agent runtime's catch-alls answer an unexpected failure with fixed
// text. A refusal that carries its own status or code still says its message.
const POD = '0123456789abcdef01234567';
const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

describe('agent runtime context 500', () => {
  let errorSpy;
  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => jest.restoreAllMocks());

  it('an unexpected failure answers fixed text and logs the cause', async () => {
    AgentIdentityService.getOrCreateAgentUser.mockRejectedValue(new Error(DRIVER_TEXT));
    const res = await request(app).get(`/api/agents/runtime/pods/${POD}/context`);
    expect(res.status).toBe(500);
    expect(res.body.message).toBe('Failed to fetch pod context');
    expect(res.text).not.toContain('db.internal.example');
    expect(res.text).not.toContain('secret_table');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('Error fetching agent pod context [500]:');
    expect(JSON.stringify(errorSpy.mock.calls)).toContain('db.internal.example');
  });

  it('a driver code never reaches the body on a 5xx', async () => {
    AgentIdentityService.getOrCreateAgentUser.mockRejectedValue(Object.assign(new Error(DRIVER_TEXT), { code: 11000 }));
    const res = await request(app).get(`/api/agents/runtime/pods/${POD}/context`);
    expect(res.status).toBe(500);
    expect(res.body.code).toBe('INTERNAL_ERROR');
  });

  it('a refusal we wrote (NOT_A_MEMBER, 403) keeps its message', async () => {
    AgentIdentityService.getOrCreateAgentUser.mockRejectedValue(
      Object.assign(new Error('Agent is not a member of this pod'), { code: 'NOT_A_MEMBER' }),
    );
    const res = await request(app).get(`/api/agents/runtime/pods/${POD}/context`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Agent is not a member of this pod');
  });
});
