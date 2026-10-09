/**
 * TASK-141 — the legacy per-row Slack route takes no auth at all
 * (`POST /api/webhooks/slack/:integrationId`), so three properties are what stand
 * between a caller and Slack-attributed ingress:
 *
 *   1. it verifies with the INSTANCE secret only, so a secret planted on the row
 *      cannot admit events (the row's copy has had no writer since the key joined
 *      `SERVER_OWNED_CONFIG_KEYS`);
 *   2. an inactive row answers like an unknown id, with nothing buffered — the
 *      same rule `/events` applies by resolving only `isActive` rows;
 *   3. that 404 is about `isActive`, not about a harness that cannot reach a
 *      provider, which is why the third test is a live positive control.
 */
const crypto = require('crypto');
const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/WebhookDelivery', () => ({ create: jest.fn(), deleteOne: jest.fn() }));

const deliveries = require('../../../models/WebhookDelivery');
const Integration = require('../../../models/Integration');
const registry = require('../../../integrations');
const slackRoutes = require('../../../routes/webhooks/slack');

const app = express();
app.use(express.json({ verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use('/api/webhooks/slack', slackRoutes);

const INSTANCE_SECRET = 'instance-signing-secret';
const ROW_SECRET = 'row-planted-signing-secret';
const challengeBody = { type: 'url_verification', challenge: 'legacy-challenge' };
const eventBody = {
  event_id: 'Ev-legacy-1',
  team_id: 'T1',
  event: {
    type: 'message', channel_type: 'im', channel: 'D1', user: 'U1', text: 'hello',
  },
};

const signedWith = (secret, payload = challengeBody) => {
  const timestamp = Math.floor(Date.now() / 1000);
  const raw = JSON.stringify(payload);
  const digest = crypto.createHmac('sha256', secret).update(`v0:${timestamp}:${raw}`).digest('hex');
  return {
    'X-Slack-Request-Timestamp': String(timestamp),
    'X-Slack-Signature': `v0=${digest}`,
  };
};

const acceptingProvider = () => ({
  getWebhookHandlers: () => ({
    events: (_req, res) => res.sendStatus(200),
  }),
});

describe('legacy Slack route — who can admit an event (TASK-141)', () => {
  beforeEach(() => {
    process.env.SLACK_SIGNING_SECRET = INSTANCE_SECRET;
    jest.clearAllMocks();
    deliveries.create.mockResolvedValue({});
    deliveries.deleteOne.mockResolvedValue({});
  });

  afterAll(() => { delete process.env.SLACK_SIGNING_SECRET; });

  it('verifies with the instance secret, so a secret planted on the row is refused', async () => {
    Integration.findById.mockResolvedValue({
      _id: 'integration-planted',
      type: 'slack',
      isActive: true,
      config: { chatId: 'D1', signingSecret: ROW_SECRET },
    });

    const response = await request(app)
      .post('/api/webhooks/slack/integration-planted')
      .set(signedWith(ROW_SECRET))
      .send(challengeBody);

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('answers an inactive row like an unknown id and buffers nothing', async () => {
    Integration.findById.mockResolvedValue({
      _id: 'integration-inactive',
      type: 'slack',
      isActive: false,
      config: { chatId: 'D1' },
    });

    const response = await request(app)
      .post('/api/webhooks/slack/integration-inactive')
      .set(signedWith(INSTANCE_SECRET))
      .send(challengeBody);

    expect(response.status).toBe(404);
    expect(deliveries.create).not.toHaveBeenCalled();
    expect(registry.get).not.toHaveBeenCalled();
  });

  it('reaches the provider for an active row that carries no row-level secret', async () => {
    Integration.findById.mockResolvedValue({
      _id: 'integration-active',
      type: 'slack',
      isActive: true,
      config: { chatId: 'D1' },
    });
    registry.get.mockReturnValue(acceptingProvider());

    // A message event, not `url_verification`: the route answers a challenge
    // itself before it resolves a provider, so only a real event reaches the
    // handler whose own verification has to agree with the route's.
    const response = await request(app)
      .post('/api/webhooks/slack/integration-active')
      .set(signedWith(INSTANCE_SECRET, eventBody))
      .send(eventBody);

    expect(response.status).toBe(200);
    expect(registry.get).toHaveBeenCalledWith('slack', expect.objectContaining({ _id: 'integration-active' }));
  });

  it('answers an unknown id like an inactive one', async () => {
    Integration.findById.mockResolvedValue(null);

    const response = await request(app)
      .post('/api/webhooks/slack/does-not-exist')
      .set(signedWith(INSTANCE_SECRET))
      .send(challengeBody);

    expect(response.status).toBe(404);
    expect(deliveries.create).not.toHaveBeenCalled();
  });
});
