/**
 * ADR-018 claim routes — identity comes from the token, membership is
 * install-gated, and the route never invents authority.
 */
const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { botMetadata: { agentName: 'UX-Lead', instanceId: 'default' } };
  next();
});

const mockFindOne = jest.fn();
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: (...a) => mockFindOne(...a) },
}));

const mockClaim = jest.fn();
const mockRelease = jest.fn();
jest.mock('../../../services/messageClaimService', () => ({
  claim: (...a) => mockClaim(...a),
  release: (...a) => mockRelease(...a),
}));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

describe('claim routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockResolvedValue({ status: 'active' });
    mockClaim.mockResolvedValue({ claimed: true });
    mockRelease.mockResolvedValue({ released: true });
  });

  test('claims with token-derived identity, lowercased', async () => {
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({ podId: 'p1' });
    expect(res.status).toBe(200);
    expect(mockClaim).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '52907', podId: 'p1', agentName: 'ux-lead',
    }));
  });

  test('no active installation in the pod → 403, service never called', async () => {
    mockFindOne.mockResolvedValue(null);
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({ podId: 'p1' });
    expect(res.status).toBe(403);
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test('missing podId → 400', async () => {
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({});
    expect(res.status).toBe(400);
  });

  test('release passes identity, needs no pod (holder-only delete is the guard)', async () => {
    const res = await request(app).delete('/api/agents/runtime/messages/52907/claim');
    expect(res.status).toBe(200);
    expect(mockRelease).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'ux-lead' }));
  });
});
