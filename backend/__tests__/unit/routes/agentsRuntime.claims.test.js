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
const mockMessageExists = jest.fn();
jest.mock('../../../services/messageClaimService', () => ({
  claim: (...a) => mockClaim(...a),
  release: (...a) => mockRelease(...a),
  messageExists: (...a) => mockMessageExists(...a),
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
    mockMessageExists.mockResolvedValue(true);
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
    // Membership is answered before the message is: an uninstalled caller must
    // not be able to tell a real message from a missing one by the shape of
    // the refusal (403 either way).
    expect(mockMessageExists).not.toHaveBeenCalled();
  });

  test('a message absent from this pod → 404, and no lease is minted', async () => {
    // Measured before the fix: /messages/999999999999/claim answered
    // `claimed: true` for an id with no row anywhere, and the row it created
    // was un-renewable and never pruned.
    mockMessageExists.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/agents/runtime/messages/999999999999/claim')
      .send({ podId: 'p1' });
    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ claimed: false, reason: 'message_not_found' });
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockTypingStart).not.toHaveBeenCalled();
  });

  test('a non-numeric id is the same 404 — the route never guesses an id is a message', async () => {
    mockMessageExists.mockResolvedValue(false);
    const res = await request(app)
      .post('/api/agents/runtime/messages/TASK-110/claim')
      .send({ podId: 'p1' });
    expect(res.status).toBe(404);
    expect(mockMessageExists).toHaveBeenCalledWith('TASK-110', 'p1');
    expect(mockClaim).not.toHaveBeenCalled();
  });

  test('existence is asked with the id AND the pod, before the CAS', async () => {
    const res = await request(app).post('/api/agents/runtime/messages/52907/claim').send({ podId: 'p1' });
    expect(res.status).toBe(200);
    expect(mockMessageExists).toHaveBeenCalledWith('52907', 'p1');
    // Order matters: the check is worthless if the lease is minted first and
    // the 404 is decided afterwards.
    expect(mockMessageExists.mock.invocationCallOrder[0])
      .toBeLessThan(mockClaim.mock.invocationCallOrder[0]);
  });

  test('a comment id is passed through unchanged — the route has no shape logic of its own', async () => {
    // The wake for a post-thread comment carries a Mongo ObjectId. The
    // namespace split lives in messageExists, so a second copy here could only
    // drift from it, and this pins that the route is not where the split is
    // decided (connector-ops 71952).
    mockMessageExists.mockResolvedValue(true);
    const res = await request(app)
      .post('/api/agents/runtime/messages/507f1f77bcf86cd799439011/claim')
      .send({ podId: 'p1' });
    expect(res.status).toBe(200);
    expect(mockMessageExists).toHaveBeenCalledWith('507f1f77bcf86cd799439011', 'p1');
    expect(mockClaim).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '507f1f77bcf86cd799439011',
      podId: 'p1',
    }));
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

  test('a refusal release is NAMED and handed on: handoff service gets the resolved class', async () => {
    // Corrected TASK-099 ruling (71194/71195/71210): a refusal on a human wake
    // is a handoff, exactly like a decline — a per-seat upstream failure must
    // not make the human's message disappear. Whether a handoff is actually
    // queued is the handoff service's own `senderIsHuman` filter, so the route
    // routes both outcomes there and keeps no second definition of "human".
    const res = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'upstream-refused', status: 429 });

    expect(res.status).toBe(200);
    expect(mockDeclineRelease).toHaveBeenCalledWith(expect.objectContaining({
      messageId: '52907',
      agentName: 'ux-lead',
      instanceId: 'default',
      outcome: 'refused',
      reason: 'upstream-refused',
      status: 429,
    }));
    expect(mockRelease).not.toHaveBeenCalled();
  });

  test('the other refusal classes need no status', async () => {
    const res = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'cascade-cap' });

    expect(res.status).toBe(200);
    expect(mockDeclineRelease.mock.calls[0][0]).toMatchObject({
      outcome: 'refused', reason: 'cascade-cap',
    });
    expect(mockDeclineRelease.mock.calls[0][0].status).toBeUndefined();
  });

  test('an uncountable reason is refused at the door, not stored', async () => {
    // Free text belongs in the seat log. The kernel's record is the enum, and
    // a 400 here is what keeps "how many upstream refusals" a query. Two
    // probes, because they fail different weak validators: the first is what
    // the CLI sent before the enum existed (a class with its status baked in),
    // the second is a well-formed name that is simply not a class — a shape
    // check (`/^[a-z-]+$/`) accepts it, and only the enum rejects it.
    const statusBakedIn = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'upstream-refused-429' });
    expect(statusBakedIn.status).toBe(400);

    const shapely = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'rate-limited' });
    expect(shapely.status).toBe(400);

    expect(mockRelease).not.toHaveBeenCalled();
    expect(mockDeclineRelease).not.toHaveBeenCalled();
  });

  test('a refusal with no reason is refused at the door', async () => {
    const res = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused' });

    expect(res.status).toBe(400);
    expect(mockDeclineRelease).not.toHaveBeenCalled();
  });

  test('a status rides only with upstream-refused, and only as an HTTP code', async () => {
    const withCap = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'cascade-cap', status: 429 });
    expect(withCap.status).toBe(400);

    const asString = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'upstream-refused', status: '429' });
    expect(asString.status).toBe(400);

    const notAnErrorCode = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'refused', reason: 'upstream-refused', status: 200 });
    expect(notAnErrorCode.status).toBe(400);

    expect(mockDeclineRelease).not.toHaveBeenCalled();
  });

  test('a reason with any other outcome is refused, not forwarded', async () => {
    // "required iff refused" cuts both ways: the field is what makes a refusal
    // explicable, and on a completion it would be a record with no reader.
    const res = await request(app)
      .delete('/api/agents/runtime/messages/52907/claim')
      .send({ outcome: 'completed', reason: 'upstream-refused' });

    expect(res.status).toBe(400);
    expect(mockRelease).not.toHaveBeenCalled();
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
