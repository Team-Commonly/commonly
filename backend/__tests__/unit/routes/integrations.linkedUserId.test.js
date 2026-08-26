// PATCH /api/integrations/:id — bridge attribution guard.
// config.linkedUserId is the identity every inbound live-relay message is
// AUTHORED as (pod row, socket payload, agent wake). The route derives it from
// the authenticated caller when liveRelay flips on and rejects any
// client-supplied value: without this, any caller passing canDeleteIntegration
// could name someone else as the bridge author (sprint-review on #1290).
const request = require('supertest');
const express = require('express');

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: 'user-1' };
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/DiscordIntegration', () => function DiscordIntegration(data) {
  Object.assign(this, data);
  this.save = jest.fn().mockResolvedValue(this);
});
jest.mock('../../../services/discordService', () => jest.fn());
jest.mock('../../../models/Integration', () => {
  function Integration(data) { Object.assign(this, data); }
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

describe('PATCH /api/integrations/:id — linkedUserId guard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // canDeleteIntegration: non-admin caller who created the integration.
    User.findById.mockResolvedValue({ _id: 'user-1', role: 'member' });
    Pod.findById.mockResolvedValue(null);
    Integration.findById.mockResolvedValue(telegramIntegration());
    Integration.findByIdAndUpdate.mockResolvedValue({ _id: 'integration-1' });
  });

  it('rejects a client-supplied linkedUserId naming someone else', async () => {
    const res = await request(app)
      .patch('/api/integrations/integration-1')
      .send({ config: { liveRelay: true, linkedUserId: 'VICTIM-USER-ID' } });

    expect(res.status).toBe(400);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('derives linkedUserId from the caller when liveRelay flips on', async () => {
    const res = await request(app)
      .patch('/api/integrations/integration-1')
      .send({ config: { liveRelay: true } });

    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update.config.liveRelay).toBe(true);
    expect(update.config.linkedUserId).toBe('user-1');
  });

  it('does not stamp linkedUserId when liveRelay is switched off', async () => {
    const res = await request(app)
      .patch('/api/integrations/integration-1')
      .send({ config: { liveRelay: false } });

    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update.config.liveRelay).toBe(false);
    expect(update.config.linkedUserId).toBeUndefined();
  });
});

// POST /api/integrations — the create path had none of the PATCH guards:
// config was spread verbatim (linkedUserId, connectCode, chatId all client-
// settable) and there was no pod-membership check (ADR-025 review, 2026-08-26).
describe('POST /api/integrations — create-path guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    Integration.prototype.save = jest.fn().mockResolvedValue(undefined);
    Pod.findById.mockResolvedValue({ _id: 'pod-1', type: 'private', members: ['user-1'] });
  });

  it('rejects a client-supplied linkedUserId naming someone else', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .send({ podId: 'pod-1', type: 'telegram', config: { liveRelay: true, linkedUserId: 'VICTIM-USER-ID' } });
    expect(res.status).toBe(400);
  });

  it('refuses non-members of the target pod', async () => {
    Pod.findById.mockResolvedValue({ _id: 'pod-1', type: 'private', members: ['someone-else'] });
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ role: 'member' }) }) });
    const res = await request(app)
      .post('/api/integrations')
      .send({ podId: 'pod-1', type: 'telegram', config: {} });
    expect(res.status).toBe(403);
  });

  it('mints a server-side 128-bit expiring code and strips client binding fields', async () => {
    const res = await request(app)
      .post('/api/integrations')
      .send({
        podId: 'pod-1',
        type: 'telegram',
        config: {
          connectCode: 'chosen', chatId: '999', chatType: 'private', liveRelay: true, 
        },
      });
    expect(res.status).toBe(201);
    const { config } = res.body.integration;
    expect(config.connectCode).toMatch(/^[0-9a-f]{32}$/);
    expect(new Date(config.connectCodeExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(config.chatId).toBeUndefined();
    expect(config.chatType).toBeUndefined();
    expect(config.linkedUserId).toBe('user-1');
  });
});

describe('PATCH /api/integrations/:id — live relay on a group chat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockResolvedValue({ _id: 'user-1', role: 'member' });
    Pod.findById.mockResolvedValue(null);
    Integration.findById.mockResolvedValue({
      ...telegramIntegration(),
      config: { chatId: '42', chatType: 'group', toObject() { return { chatId: '42', chatType: 'group' }; } },
    });
    Integration.findByIdAndUpdate.mockResolvedValue({ _id: 'integration-1' });
  });

  it('refuses to flip liveRelay on when the bound chat is not private', async () => {
    const res = await request(app)
      .patch('/api/integrations/integration-1')
      .send({ config: { liveRelay: true } });
    expect(res.status).toBe(400);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('ignores client-supplied chatId on PATCH', async () => {
    const res = await request(app)
      .patch('/api/integrations/integration-1')
      .send({ config: { chatId: '777', leadAgentUsername: 'theo' } });
    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update.config.chatId).toBe('42');
    expect(update.config.leadAgentUsername).toBe('theo');
  });
});
