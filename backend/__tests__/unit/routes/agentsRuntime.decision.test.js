/** The MCP route is deliberately thin: token identity and pod scope, then the
 * same decision service used by every runtime. This pins its wire contract so
 * a body cannot forge the asking agent's provenance. */

const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { _id: 'agent-user-1' };
  req.agentInstallation = {
    podId: 'pod-1', agentName: 'release-agent', instanceId: 'seat-1',
    displayName: 'Release Agent', config: { mode: 'test' },
  };
  req.agentInstallations = [req.agentInstallation];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (req, _res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({ requireApiTokenScopes: () => (_req, _res, next) => next() }));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({ buildAgentUsername: jest.fn((name) => name) }));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/dmService', () => ({}));
jest.mock('../../../services/chatSummarizerService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { findOne: jest.fn(), find: jest.fn() } }));

const mockRequestDecision = jest.fn();
jest.mock('../../../services/decisionRequestService', () => ({
  requestDecision: (...args) => mockRequestDecision(...args),
  DecisionRequestError: class DecisionRequestError extends Error {
    constructor(message, status, code) { super(message); this.status = status; this.code = code; }
  },
}));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

describe('POST /api/agents/runtime/decisions', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRequestDecision.mockResolvedValue({ decisionId: 'd1', messageId: '700', threadRootId: '700', status: 'pending' });
  });

  test('uses the authenticated seat as provenance and forwards the declared fork', async () => {
    const response = await request(app).post('/api/agents/runtime/decisions').send({
      podId: 'pod-1', decisionClass: 'implementation', title: 'Choose release', question: 'Which train?',
      options: [{ label: 'Canary', recommended: true }, { label: 'Fast lane' }],
      threadRootId: '612', context: 'Green build.',
    });

    expect(response.status).toBe(201);
    expect(mockRequestDecision).toHaveBeenCalledWith(expect.objectContaining({
      podId: 'pod-1', agentUserId: 'agent-user-1', agentName: 'release-agent', instanceId: 'seat-1',
      displayName: 'Release Agent', decisionClass: 'implementation', title: 'Choose release', question: 'Which train?', threadRootId: '612',
    }));
    expect(mockRequestDecision.mock.calls[0][0]).not.toHaveProperty('action');
  });

  test('refuses structured action data instead of turning a human ruling into approval', async () => {
    const response = await request(app).post('/api/agents/runtime/decisions').send({
      podId: 'pod-1', decisionClass: 'implementation', title: 'Choose release', question: 'Which train?',
      options: [{ label: 'Canary' }, { label: 'Fast lane' }],
      actionType: 'deploy', params: { environment: 'production' },
    });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'unsupported_decision_fields' });
    expect(response.body.message).toContain('propose-action');
    expect(mockRequestDecision).not.toHaveBeenCalled();
  });

  test('rejects an unscoped pod before the decision service writes anything', async () => {
    const response = await request(app).post('/api/agents/runtime/decisions').send({
      podId: 'other-pod', decisionClass: 'strategy', title: 'Choose release', question: 'Which train?', options: [{ label: 'A' }, { label: 'B' }],
    });
    expect(response.status).toBe(403);
    expect(mockRequestDecision).not.toHaveBeenCalled();
  });
});
