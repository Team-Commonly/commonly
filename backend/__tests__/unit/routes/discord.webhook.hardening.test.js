const request = require('supertest');
const express = require('express');
const nacl = require('tweetnacl');

jest.mock('../../../models/DiscordIntegration', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/discordService', () => jest.fn().mockImplementation(() => ({
  handleWebhook: jest.fn().mockResolvedValue(undefined),
})));
jest.mock('../../../models/WebhookDelivery', () => ({ create: jest.fn(), deleteOne: jest.fn() }));

const DiscordIntegration = require('../../../models/DiscordIntegration');
const DiscordService = require('../../../services/discordService');
const deliveries = require('../../../models/WebhookDelivery');
const routes = require('../../../routes/webhooks/discord');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/discord', routes);

const keyPair = nacl.sign.keyPair();
const PUBLIC_KEY = Buffer.from(keyPair.publicKey).toString('hex');

// Discord's own signing: Ed25519 over timestamp + raw body. Every accepted
// request in this file goes through it; there is no unverified path (D137 A9).
const signed = (body, secretKey = keyPair.secretKey) => {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = Buffer.from(nacl.sign.detached(
    Buffer.from(`${timestamp}${JSON.stringify(body)}`),
    secretKey,
  )).toString('hex');
  return request(app)
    .post('/api/webhooks/discord?webhook_id=webhook-1')
    .set('X-Signature-Timestamp', timestamp)
    .set('X-Signature-Ed25519', signature)
    .send(body);
};

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
    process.env.DISCORD_PUBLIC_KEY = PUBLIC_KEY;
    DiscordIntegration.findOne.mockResolvedValue({ integrationId: 'integration-1' });
    deliveries.create.mockResolvedValue({});
    deliveries.deleteOne.mockResolvedValue({});
  });

  test('rejects unsigned events', async () => {
    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send(event());

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('rejects a signature from another key', async () => {
    const response = await signed(event(), nacl.sign.keyPair().secretKey);

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('rejects a signature over a different body', async () => {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = Buffer.from(nacl.sign.detached(
      Buffer.from(`${timestamp}${JSON.stringify(event({ content: 'original' }))}`),
      keyPair.secretKey,
    )).toString('hex');

    const response = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .set('X-Signature-Timestamp', timestamp)
      .set('X-Signature-Ed25519', signature)
      .send(event({ content: 'tampered' }));

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('rejects every request while DISCORD_PUBLIC_KEY is unset', async () => {
    delete process.env.DISCORD_PUBLIC_KEY;
    const response = await signed(event());

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  // The removed bypass flag must not reopen the route if an old env still sets it.
  test('ignores DISCORD_WEBHOOK_ALLOW_UNVERIFIED', async () => {
    process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    const unsigned = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send(event());
    const ping = await request(app)
      .post('/api/webhooks/discord?webhook_id=webhook-1')
      .send({ type: 1, id: 'ping-1' });

    expect(unsigned.status).toBe(401);
    expect(ping.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
    delete process.env.DISCORD_WEBHOOK_ALLOW_UNVERIFIED;
  });

  test('accepts a valid Ed25519 signature and claims the event before dispatch', async () => {
    const response = await signed(event({ id: 'event-signed' }));

    expect(response.status).toBe(200);
    expect(deliveries.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'discord', deliveryId: 'webhook-1:event-signed',
    }));
    expect(DiscordService).toHaveBeenCalledWith('integration-1');
  });

  test('answers a signed PING with PONG and claims nothing', async () => {
    const response = await signed({ type: 1, id: 'ping-1' });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ type: 1 });
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('acknowledges duplicate events without dispatch', async () => {
    deliveries.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));

    const response = await signed(event());

    expect(response.status).toBe(200);
    expect(DiscordService).not.toHaveBeenCalled();
  });

  test('returns 503 when the delivery claim store is unavailable', async () => {
    deliveries.create.mockRejectedValueOnce(new Error('mongo unavailable'));

    const response = await signed(event({ id: 'event-unavailable' }));

    expect(response.status).toBe(503);
    expect(DiscordService).not.toHaveBeenCalled();
  });

  test('does not expose unused unauthenticated Discord routes', async () => {
    await request(app).get('/api/webhooks/discord/channels/integration-1').expect(404);
    await request(app).post('/api/webhooks/discord/invite').send({ clientId: 'client-1' }).expect(404);
    await request(app).post('/api/webhooks/discord/test/integration-1').expect(404);
  });
});
