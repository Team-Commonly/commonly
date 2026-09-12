const crypto = require('crypto');
const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/WebhookDelivery', () => ({ create: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../../../services/slackBridgeService', () => ({ relaySlackMessageToPod: jest.fn() }));

const deliveries = require('../../../models/WebhookDelivery');
const Integration = require('../../../models/Integration');
const slackRoutes = require('../../../routes/webhooks/slack');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/slack', slackRoutes);

const signingSecret = 'slack-signing-secret';
const eventBody = {
  event_id: 'Ev1',
  team_id: 'T1',
  event: {
    type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello',
  },
};
const signatureHeaders = (body, timestamp = Math.floor(Date.now() / 1000)) => {
  const raw = JSON.stringify(body);
  const signature = `v0=${crypto.createHmac('sha256', signingSecret).update(`v0:${timestamp}:${raw}`).digest('hex')}`;
  return { 'X-Slack-Request-Timestamp': String(timestamp), 'X-Slack-Signature': signature };
};

describe('installable Slack webhook signature and acknowledgement', () => {
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = signingSecret;
    jest.clearAllMocks();
    deliveries.create.mockResolvedValue({});
    deliveries.deleteOne.mockResolvedValue({});
  });
  afterAll(() => delete process.env.SLACK_SIGNING_SECRET);

  test('rejects invalid signatures before receipt creation', async () => {
    const response = await request(app).post('/api/webhooks/slack/events').send(eventBody);
    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('rejects signatures outside the five-minute freshness window', async () => {
    const staleTimestamp = Math.floor((Date.now() - (5 * 60_000 + 1)) / 1000);
    const response = await request(app)
      .post('/api/webhooks/slack/events')
      .set(signatureHeaders(eventBody, staleTimestamp))
      .send(eventBody);

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('rejects when the signing secret is missing', async () => {
    delete process.env.SLACK_SIGNING_SECRET;
    const response = await request(app)
      .post('/api/webhooks/slack/events')
      .set(signatureHeaders(eventBody))
      .send(eventBody);

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('drops non-DM events before they create a receipt or resolve a connector', async () => {
    const body = { ...eventBody, event: { ...eventBody.event, channel_type: 'channel' } };
    const response = await request(app).post('/api/webhooks/slack/events').set(signatureHeaders(body)).send(body);
    expect(response.status).toBe(200);
    expect(deliveries.create).not.toHaveBeenCalled();
    expect(Integration.findOne).not.toHaveBeenCalled();
  });

  test('acknowledges a claimed DM event and resolves only its bound team/channel', async () => {
    Integration.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    const response = await request(app).post('/api/webhooks/slack/events').set(signatureHeaders(eventBody)).send(eventBody);
    expect(response.status).toBe(200);
    await new Promise((resolve) => setImmediate(resolve));
    expect(deliveries.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'slack', deliveryId: 'T1:Ev1',
    }));
    expect(Integration.findOne).toHaveBeenCalledWith(expect.objectContaining({
      type: 'slack', 'config.teamId': 'T1', 'config.chatId': 'D1', 'config.chatType': 'im', isActive: true,
    }));
  });

  test('acks a paused connector event, records its receipt, and relays again after resume', async () => {
    const duplicate = Object.assign(new Error('duplicate'), { code: 11000 });
    deliveries.create
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(duplicate)
      .mockResolvedValueOnce({});
    const pausedIntegration = {
      _id: 'integration-paused', type: 'slack', isActive: true, status: 'connected',
      config: {
        teamId: 'T1', chatId: 'D1', chatType: 'im', liveRelay: true,
        adminPause: { reason: 'Safety review', at: new Date(), adminId: 'admin-1' },
      },
    };
    const resumedIntegration = { ...pausedIntegration, config: { ...pausedIntegration.config } };
    delete resumedIntegration.config.adminPause;
    let paused = true;
    Integration.findOne.mockImplementation((query) => ({
      lean: jest.fn().mockResolvedValue(
        query['config.adminPause']?.$exists === false && paused ? null : resumedIntegration,
      ),
    }));
    const bridge = require('../../../services/slackBridgeService');
    bridge.relaySlackMessageToPod.mockResolvedValue({ relayed: true });

    const first = await request(app).post('/api/webhooks/slack/events').set(signatureHeaders(eventBody)).send(eventBody);
    await new Promise((resolve) => setImmediate(resolve));
    const second = await request(app).post('/api/webhooks/slack/events').set(signatureHeaders(eventBody)).send(eventBody);
    paused = false; // admin resume clears config.adminPause on the projection.
    const resumedBody = { ...eventBody, event_id: 'Ev2' };
    const resumed = await request(app).post('/api/webhooks/slack/events').set(signatureHeaders(resumedBody)).send(resumedBody);
    await new Promise((resolve) => setImmediate(resolve));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(resumed.status).toBe(200);
    expect(Integration.findOne).toHaveBeenCalledWith(expect.objectContaining({
      'config.adminPause': { $exists: false },
    }));
    expect(bridge.relaySlackMessageToPod).toHaveBeenCalledTimes(1);
    expect(bridge.relaySlackMessageToPod).toHaveBeenCalledWith(expect.objectContaining({
      integration: resumedIntegration,
    }));
  });
});
