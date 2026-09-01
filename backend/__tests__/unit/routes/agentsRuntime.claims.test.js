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

const mockDeclineRelease = jest.fn();
jest.mock('../../../services/messageClaimHandoffService', () => ({
  release: (...a) => mockDeclineRelease(...a),
}));

const mockTypingStart = jest.fn();
const mockTypingStop = jest.fn();
jest.mock('../../../services/agentTypingService', () => ({
  emitAgentTypingStart: (...a) => mockTypingStart(...a),
  emitAgentTypingStop: (...a) => mockTypingStop(...a),
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
    mockDeclineRelease.mockResolvedValue({ released: true, podId: 'p1', handoff: { queued: true } });
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

  test('a declared decline is handed to one remaining human-wake seat', async () => {
    const res = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'declined' });

    expect(res.status).toBe(200);
    expect(mockDeclineRelease).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '52907', agentName: 'ux-lead', instanceId: 'default', outcome: 'declined',
    }));
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('rejects an invented release outcome', async () => {
    const res = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'retry-everyone' });

    expect(res.status).toBe(400);
    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockDeclineRelease).not.toHaveBeenCalled();
  });

  // ── ADR-018 D7: the claim IS the visibility signal ─────────────────────────

  test('a won claim fires the typing indicator for the life of the lease', async () => {
    const expiresAt = new Date(Date.now() + 90_000).toISOString();
    mockClaim.mockResolvedValue({ claimed: true, expiresAt });
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({ podId: 'p1' });
    expect(res.status).toBe(200);
    expect(mockTypingStart).toHaveBeenCalledTimes(1);
    const [agent, timeoutMs] = mockTypingStart.mock.calls[0];
    expect(agent).toMatchObject({ podId: 'p1', agentName: 'ux-lead' });
    expect(agent.displayName).toBeTruthy();
    // Lease-derived window: ~90s, not the service's 30s default.
    expect(timeoutMs).toBeGreaterThan(80_000);
    expect(timeoutMs).toBeLessThanOrEqual(90_000);
  });

  test('a LOST claim fires nothing — the holder is the one typing, not us', async () => {
    mockClaim.mockResolvedValue({ claimed: false, claimedBy: 'nova' });
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({ podId: 'p1' });
    expect(res.status).toBe(200);
    expect(mockTypingStart).not.toHaveBeenCalled();
  });

  test('a typing-indicator failure never fails the claim itself', async () => {
    mockClaim.mockResolvedValue({ claimed: true, expiresAt: new Date().toISOString() });
    mockTypingStart.mockImplementation(() => { throw new Error('socket down'); });
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({ podId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.body.claimed).toBe(true);
  });

  test('release clears the indicator using the pod the claim row carried', async () => {
    mockRelease.mockResolvedValue({ released: true, podId: 'p1' });
    const res = await request(app).delete('/api/agents/runtime/messages/52907/claim');
    expect(res.status).toBe(200);
    expect(mockTypingStop).toHaveBeenCalledWith(
      expect.objectContaining({ podId: 'p1', agentName: 'ux-lead' }),
    );
  });

  test('a release miss (lease already re-won) clears nothing', async () => {
    mockRelease.mockResolvedValue({ released: false });
    const res = await request(app).delete('/api/agents/runtime/messages/52907/claim');
    expect(res.status).toBe(200);
    expect(mockTypingStop).not.toHaveBeenCalled();
  });
});
