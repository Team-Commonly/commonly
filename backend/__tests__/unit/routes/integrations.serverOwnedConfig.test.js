// PATCH /api/integrations/:id — bridge attribution guard.
// config.linkedUserId is the identity every inbound live-relay message is
// AUTHORED as (pod row, socket payload, agent wake). The route derives it from
// the authenticated caller when liveRelay flips on and rejects any
// client-supplied value: without this, any caller passing canDeleteIntegration
// could name someone else as the bridge author (sprint-review on #1290).
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: req.header('x-test-user') || 'user-1' };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/integrationRateLimit', () => ({
  writeIntegrationsRateLimit: (_req, _res, next) => next(),
  listIntegrationsRateLimit: (_req, _res, next) => next(),
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/DiscordIntegration', () => function DiscordIntegration(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockResolvedValue(this);
});
jest.mock('../../../services/discordService', () => jest.fn());
jest.mock('../../../models/Integration', () => {
  function Integration(data) {
    Object.assign(this, data);
    this._id = this._id || 'integration-new';
    this.save = jest.fn().mockResolvedValue(this);
  }
  Integration.findById = jest.fn();
  Integration.findByIdAndUpdate = jest.fn();
  Integration.aggregate = jest.fn().mockResolvedValue([]);
  return Integration;
});

const Integration = require('../../../models/Integration');
const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const integrationRoutes = require('../../../routes/integrations');

const app = express();
app.use(express.json());
app.use('/api/integrations', integrationRoutes);

const integrationId = '64b64c1f7e5b8f0a12345674';

// The PATCH body reaches the write loop as `relay.next`, and every key of that
// object becomes a `config.<key>` update (integrations.ts:748-757). So what a
// caller may WRITE is decided by `stripServerOwnedConfig`, not by the loop: the
// loop persists every key it is given, and it is never given a server-owned one.
//
// Two mechanisms protect these keys and they are not interchangeable. A key with
// an explicit refusal in the route (`linkedUserId`, `botToken`) is refused with a
// 4xx; every other server-owned key is silently removed from the body, which is
// what makes `providerRevokedAt` unwritable — the mark the removal sequence
// treats as proof that a provider revoke TAKES, and whose forgery would let a
// row claim a revoke that never happened.
const telegramIntegration = () => ({
  _id: 'integration-1',
  type: 'telegram',
  podId: 'pod-1',
  createdBy: { toString: () => 'user-1' },
  config: {
    chatId: '42',
    chatType: 'private',
    toObject() { return { chatId: '42', chatType: 'private' }; },
  },
});

describe('PATCH /api/integrations/:id — server-owned config keys are not writable', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockResolvedValue({ _id: 'user-1', role: 'member' });
    Pod.findById.mockResolvedValue(null);
    Integration.findById.mockResolvedValue(telegramIntegration());
    Integration.findByIdAndUpdate.mockResolvedValue({ _id: 'integration-1' });
  });

  it('does not write a supplied mark, while writing the fields beside it', async () => {
    const res = await request(app)
      .patch(`/api/integrations/${integrationId}`)
      // `liveRelay` is NOT server-owned, so it is the acceptance control: it
      // proves the loop ran, which is what makes the mark's absence evidence
      // about the strip rather than about a request that never reached a write.
      // (`chatId` would have been the wrong control — it is on the list too.)
      .send({ config: { providerRevokedAt: '2026-09-30T00:00:00.000Z', liveRelay: false } });

    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    // The write happened, so the absence below is the strip and not a refusal.
    expect(update['config.liveRelay']).toBe(false);
    expect(Object.keys(update)).not.toContain('config.providerRevokedAt');
    expect(Object.values(update)).not.toContain('2026-09-30T00:00:00.000Z');
  });

  it('refuses a supplied linkedUserId outright — the other mechanism', async () => {
    const res = await request(app)
      .patch(`/api/integrations/${integrationId}`)
      .send({ config: { providerRevokedAt: '2026-09-30T00:00:00.000Z', linkedUserId: 'VICTIM-USER-ID' } });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/linkedUserId is derived from the authenticated caller/);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });
});
