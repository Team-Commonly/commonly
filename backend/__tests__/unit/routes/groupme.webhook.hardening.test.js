const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration', () => ({ findById: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/WebhookDelivery', () => ({ create: jest.fn(), deleteOne: jest.fn() }));

const Integration = require('../../../models/Integration');
const registry = require('../../../integrations');
const deliveries = require('../../../models/WebhookDelivery');
const routes = require('../../../routes/webhooks/groupme');

const app = express();
app.use(express.json());
app.use('/api/webhooks/groupme', routes);

const integration = {
  _id: 'integration-1',
  type: 'groupme',
  config: { botId: 'bot-1', groupId: 'group-1' },
};

const payload = (overrides = {}) => ({
  group_id: 'group-1',
  id: 'message-1',
  sender_type: 'user',
  user_id: 'user-1',
  text: 'hello',
  ...overrides,
});

describe('GroupMe webhook hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED;
    delete process.env.GROUPME_BOT_ID;
    Integration.findById.mockResolvedValue(integration);
    deliveries.create.mockResolvedValue({});
    deliveries.deleteOne.mockResolvedValue({});
    registry.get.mockReturnValue({
      getWebhookHandlers: () => ({ events: jest.fn((_req, res) => res.sendStatus(200)) }),
    });
  });

  test('accepts the docs-shaped callback with the configured group identity', async () => {
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload());

    expect(response.status).toBe(200);
    expect(deliveries.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'groupme', deliveryId: 'group-1:message-1',
    }));
  });

  test('rejects a callback for another group', async () => {
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload({ group_id: 'other-group' }));

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('claims a provider message id before dispatch', async () => {
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload());

    expect(response.status).toBe(200);
    expect(deliveries.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'groupme', deliveryId: 'group-1:message-1',
    }));
    expect(registry.get).toHaveBeenCalledWith('groupme', integration);
  });

  test('rejects callbacks without the configured group identity', async () => {
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload({ group_id: undefined }));

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
  });

  test('rejects callbacks to an integration with no configured group, flag or not', async () => {
    process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    Integration.findById.mockResolvedValue({ ...integration, config: { botId: 'bot-1' } });
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload());

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
    delete process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED;
  });

  // Neither side has a group id, so '' !== '' cannot reject: only the
  // empty-identity check stands between this callback and a dispatch.
  test('rejects a callback with no group id to an integration with no configured group, flag or not', async () => {
    process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    Integration.findById.mockResolvedValue({ ...integration, config: { botId: 'bot-1' } });
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload({ group_id: undefined }));

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
    delete process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED;
  });

  // The removed bypass flag must not reopen the route if an old env still sets it.
  test('ignores GROUPME_WEBHOOK_ALLOW_UNVERIFIED', async () => {
    process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload({ group_id: undefined }));

    expect(response.status).toBe(401);
    expect(deliveries.create).not.toHaveBeenCalled();
    delete process.env.GROUPME_WEBHOOK_ALLOW_UNVERIFIED;
  });

  test('returns 503 when the delivery claim store is unavailable', async () => {
    deliveries.create.mockRejectedValueOnce(new Error('mongo unavailable'));
    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload());

    expect(response.status).toBe(503);
    expect(registry.get).not.toHaveBeenCalled();
  });

  test('acknowledges duplicate provider message ids without dispatch', async () => {
    deliveries.create.mockRejectedValueOnce(Object.assign(new Error('duplicate'), { code: 11000 }));

    const response = await request(app)
      .post('/api/webhooks/groupme/integration-1')
      .send(payload());

    expect(response.status).toBe(200);
    expect(registry.get).not.toHaveBeenCalled();
  });

});
