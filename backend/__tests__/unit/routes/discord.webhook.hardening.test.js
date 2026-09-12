const request = require('supertest');
const express = require('express');
const nacl = require('tweetnacl');

jest.mock('../../../models/DiscordIntegration', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/discordService', () => jest.fn().mockImplementation(() => ({
  handleWebhook: jest.fn().mockResolvedValue(undefined),
})), { virtual: true });
jest.mock('../../../models/WebhookDelivery', () => ({ create: jest.fn(), deleteOne: jest.fn() }));

const DiscordIntegration = require('../../../models/DiscordIntegration');
const DiscordService = require('../../../services/discordService');
const deliveries = require('../../../models/WebhookDelivery');
const routes = require('../../../routes/webhooks/discord');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/discord', routes);

const event = (overrides = {}) => ({
  id: 'event-1',
  type: 2,
  content: 'hello',
  ...overrides,
});

describe('Discord webhook hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED;
    delete process.env.DISCORD_PUBLIC_KEY;
    DiscordIntegration.findOne.mockResolvedValue({ integrationId: 'integration-1' });
    deliveries.create.mockResolvedValue({});
    deliveries.deleteOne.mockResolvedValue({});
  });

  test('rejects unsigned events by default', async () => {
    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send(event());

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('claims a verified-by-escape-hatch event before dispatch', async () => {
    process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send(event());

    expect(response.status).toBe(200);
    expect(deliveries.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'discord', deliveryId: 'webhook-1:event-1',
    }));
    expect(DiscordService).toHaveBeenCalledWith('integration-1');
  });

  test('accepts a valid Ed25519 signature over the raw body', async () => {
    const keyPair = nacl.sign.keyPair();
    process.env.DISCORD_PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('hex');
    const body = event({ id: 'event-signed' });
    const rawBody = JSON.stringify(body);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(nacl.sign.detached(
      Buffer.from(`${timestamp}${rawBody}`),
      keyPair.secretKey,
    )).toString('hex');

    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .set('X-Signature-Timestamp', timestamp)
      .set('X-Signature-Ed25519', signature)
      .send(body);

    expect(response.status).toBe(200);
    expect(deliveries.create).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: 'webhook-1:event-signed',
    }));
  });

  test('acknowledges duplicate events without dispatch', async () => {
    process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    deliveries.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));

    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send(event());

    expect(response.status).toBe(200);
    expect(DiscordService).not.toHaveBeenCalled();
  });

  test('allows unsigned events only with the explicit escape hatch', async () => {
    process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send({ type: 1, id: 'ping-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: 1 });
    expect(deliveries.create).not.toHaveBeenCalled();
  });
});
