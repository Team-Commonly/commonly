/**
 * ADR-026 D6 at the route boundary.
 *
 * The service can refuse an ack in two ways that both surface as `null`:
 * the event is gone (idempotent success) or the caller's delivery was
 * superseded / its nonce was missing under Phase B. A route that answers
 * `200 { success: true }` to all three tells a driver it acked when it did
 * not — the event then rolls into the requeue with nobody informed, which is
 * the silent-failure shape D6 exists to remove.
 */
const express = require('express');
const request = require('supertest');

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, _res, next) => {
  req.agentUser = { botMetadata: { agentName: 'pixel', instanceId: 'default' } };
  next();
});

const mockAcknowledge = jest.fn();
const mockIsSuperseded = jest.fn();
const mockIsRequired = jest.fn();
const mockUserFindById = jest.fn();
jest.mock('../../../services/agentEventService', () => ({
  acknowledge: (...a) => mockAcknowledge(...a),
  isSupersededDelivery: (...a) => mockIsSuperseded(...a),
  isDeliveryNonceRequired: (...a) => mockIsRequired(...a),
}));

jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: (agentName, instanceId) => (instanceId === 'default' ? agentName : `${agentName}-${instanceId}`),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/messageClaimService', () => ({}));
jest.mock('../../../services/agentTypingService', () => ({}));
jest.mock('../../../services/dmService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: (...a) => mockUserFindById(...a) }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', require('../../../routes/agentsRuntime'));

const ACK = '/api/agents/runtime/events/evt-1/ack';
const BOT_ACK = '/api/agents/runtime/bot/events/evt-1/ack';

describe('POST /events/:id/ack — delivery nonce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsRequired.mockReturnValue(false);
    mockIsSuperseded.mockResolvedValue(false);
    mockAcknowledge.mockResolvedValue({ _id: 'evt-1', status: 'acked' });
  });

  test('passes the deliveryId and declared consumer through', async () => {
    const res = await request(app)
      .post(ACK)
      .set('x-commonly-client', 'cli')
      .send({ deliveryId: 'abc123', result: { outcome: 'posted' } });

    expect(res.status).toBe(200);
    expect(mockAcknowledge).toHaveBeenCalledWith('evt-1', 'pixel', 'default', { outcome: 'posted' }, 'abc123', 'cli');
  });

  test('the bot-token ack path also forwards its declared consumer', async () => {
    mockUserFindById.mockReturnValue({
      lean: () => Promise.resolve({
        isBot: true,
        username: 'pixel',
        botMetadata: { agentName: 'pixel', instanceId: 'default' },
      }),
    });

    const res = await request(app)
      .post(BOT_ACK)
      .set('x-commonly-client', 'cli')
      .send({ deliveryId: 'abc123' });

    expect(res.status).toBe(200);
    expect(mockAcknowledge).toHaveBeenCalledWith('evt-1', 'pixel', 'default', null, 'abc123', 'cli');
  });

  test('a superseded delivery gets 409, not a cheerful 200', async () => {
    mockAcknowledge.mockResolvedValue(null);
    mockIsSuperseded.mockResolvedValue(true);

    const res = await request(app).post(ACK).send({ deliveryId: 'stale' });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('stale_delivery');
  });

  test('a vanished event is still idempotent success — not every null is a refusal', async () => {
    mockAcknowledge.mockResolvedValue(null);
    mockIsSuperseded.mockResolvedValue(false);

    const res = await request(app).post(ACK).send({ deliveryId: 'whatever' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('Phase A: a nonce-less ack is accepted, and the service is told so', async () => {
    const res = await request(app).post(ACK).send({ result: { outcome: 'acknowledged' } });

    expect(res.status).toBe(200);
    expect(mockAcknowledge).toHaveBeenCalledWith(...[
      'evt-1',
      'pixel',
      'default',
      { outcome: 'acknowledged' },
      null,
      'unknown',
    ]);
    expect(mockIsRequired).toHaveBeenCalledWith('unknown');
  });

  test('Phase B: a nonce-less ack is refused loudly, before the service is called', async () => {
    mockIsRequired.mockReturnValue(true);

    const res = await request(app)
      .post(ACK)
      .set('x-commonly-client', 'cli')
      .send({ result: { outcome: 'acknowledged' } });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('delivery_id_required');
    expect(mockIsRequired).toHaveBeenCalledWith('cli');
    // The silent-success bug this pins: acknowledge() returning null under the
    // flag looks exactly like "already gone", so the refusal has to happen
    // where the caller can still be told about it.
    expect(mockAcknowledge).not.toHaveBeenCalled();
  });

  test('Phase B: a nonce-bearing ack is unaffected', async () => {
    mockIsRequired.mockReturnValue(true);

    const res = await request(app).post(ACK).send({ deliveryId: 'abc123' });

    expect(res.status).toBe(200);
    expect(mockAcknowledge).toHaveBeenCalled();
  });
});
