/**
 * #795 — agent history pagination must be truthful.
 *
 * The live route accepted `before` and `offset` but silently ignored both,
 * returning a plausible newest page to callers that had asked for older
 * history. These tests mount the real router so the query contract, cursor
 * wiring, and page-boundary response are checked together.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallations = [{ podId: 'pod-1', status: 'active' }];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((a) => a),
}));
jest.mock('../../../services/agentMessageService', () => ({
  getRecentMessages: jest.fn(),
}));
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
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));

const express = require('express');
const request = require('supertest');
const AgentMessageService = require('../../../services/agentMessageService');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

const cursor = '2026-08-01T00:00:00.000Z';

describe('GET /pods/:podId/messages pagination contract (#795)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('passes before through and proves another page with one extra row', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValue([
      { id: 'proof-row', createdAt: '2026-07-31T20:00:00.000Z' },
      { id: 'page-oldest', createdAt: '2026-07-31T21:00:00.000Z' },
      { id: 'page-newest', createdAt: '2026-07-31T22:00:00.000Z' },
    ]);

    const res = await request(app)
      .get(`/api/agents/runtime/pods/pod-1/messages?limit=2&before=${encodeURIComponent(cursor)}`);

    expect(res.status).toBe(200);
    expect(AgentMessageService.getRecentMessages)
      // Fifth argument is the thread scope (TASK-052) — undefined for a pod read.
      .toHaveBeenCalledWith('pod-1', 3, 'bot-1', Date.parse(cursor), undefined);
    expect(res.body).toEqual({
      messages: [
        { id: 'page-oldest', createdAt: '2026-07-31T21:00:00.000Z' },
        { id: 'page-newest', createdAt: '2026-07-31T22:00:00.000Z' },
      ],
      hasMore: true,
    });
  });

  test('reports end-of-history when the extra row is absent', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValue([
      { id: 'oldest', createdAt: '2026-07-31T21:00:00.000Z' },
      { id: 'newest', createdAt: '2026-07-31T22:00:00.000Z' },
    ]);

    const res = await request(app)
      .get('/api/agents/runtime/pods/pod-1/messages?limit=2');

    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.messages.map((message) => message.id)).toEqual(['oldest', 'newest']);
  });

  test('keeps the documented 50-message clamp while fetching a proof row', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/agents/runtime/pods/pod-1/messages?limit=200');

    expect(res.status).toBe(200);
    expect(AgentMessageService.getRecentMessages.mock.calls[0][1]).toBe(51);
  });

  test('rejects unsupported query parameters instead of silently dropping them', async () => {
    const res = await request(app)
      .get('/api/agents/runtime/pods/pod-1/messages?offset=10');

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'unsupported_query_parameters',
      unsupportedQueryParams: ['offset'],
    }));
    expect(res.body.message).toContain('Supported parameters: limit, before');
    expect(AgentMessageService.getRecentMessages).not.toHaveBeenCalled();
  });

  test('rejects an operator-shaped cursor instead of passing a query object through', async () => {
    const res = await request(app)
      .get('/api/agents/runtime/pods/pod-1/messages?before%5B%24gt%5D=2026-08-01');

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'invalid_query_parameter',
      parameter: 'before',
    }));
    expect(AgentMessageService.getRecentMessages).not.toHaveBeenCalled();
  });

  test.each([
    ['before', 'not-a-timestamp'],
    ['before', '{"$gt":""}'],
    ['limit', '2.5'],
  ])('rejects malformed %s instead of answering a different query', async (parameter, value) => {
    const res = await request(app)
      .get(`/api/agents/runtime/pods/pod-1/messages?${parameter}=${encodeURIComponent(value)}`);

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'invalid_query_parameter',
      parameter,
    }));
    expect(AgentMessageService.getRecentMessages).not.toHaveBeenCalled();
  });
});
