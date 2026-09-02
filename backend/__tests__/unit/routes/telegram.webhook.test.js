const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration');
jest.mock('../../../models/Pod');
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/integrationSummaryService', () => ({ createSummary: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../services/telegramBridgeService', () => ({
  relayTelegramMessageToPod: jest.fn(),
}));
jest.mock('../../../models/WebhookDelivery', () => ({
  create: jest.fn(),
  deleteOne: jest.fn(),
}));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const IntegrationSummaryService = require('../../../services/integrationSummaryService');
const AgentEventService = require('../../../services/agentEventService');
const telegramService = require('../../../services/telegramService');
const registry = require('../../../integrations');
const bridge = require('../../../services/telegramBridgeService');

const telegramRoutes = require('../../../routes/webhooks/telegram');

const app = express();
app.use(express.json());
app.use('/api/webhooks/telegram', telegramRoutes);

describe('Telegram webhook routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    delete process.env.TELEGRAM_SECRET_TOKEN;
    // Verification is fail-closed now; the pre-existing tests exercise
    // handlers, not auth, so they run with the explicit dev override.
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    const WebhookDelivery = require('../../../models/WebhookDelivery');
    WebhookDelivery.create.mockResolvedValue({});
    WebhookDelivery.deleteOne.mockResolvedValue({});
  });

  it('handles /commonly-enable and links chat', async () => {
    const integration = {
      _id: 'integration-1',
      podId: 'pod-1',
      config: { connectCode: 'abc123', connectCodeExpiresAt: new Date(Date.now() + 60000) },
    };

    Integration.findOne = jest.fn()
      .mockResolvedValueOnce(integration) // connectCode lookup
      .mockResolvedValueOnce(null); // chatId claim lookup
    Integration.findByIdAndUpdate = jest.fn().mockResolvedValue({});
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ name: 'Test Pod' }),
    });

    const res = await request(app)
      .post('/api/webhooks/telegram')
      .send({
        message: {
          text: '/commonly-enable abc123',
          chat: { id: 42, title: 'Test Chat', type: 'group' },
          from: { id: 7, first_name: 'Sam' },
        },
      });

    expect(res.status).toBe(200);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      integration._id,
      expect.objectContaining({
        status: 'connected',
        // The bridge's attribution gate reads config.chatType off the same row
        // config.chatId names — the "no legacy-shaped rows" argument rests on
        // these two keys traveling in ONE $set. Pin the co-location, not just
        // the status flip: splitting or dropping chatType must go red here.
        $set: expect.objectContaining({
          'config.chatId': '42',
          'config.chatType': 'group',
        }),
      }),
    );
    expect(telegramService.sendMessage).toHaveBeenCalledWith(
      'bot-token',
      '42',
      expect.stringContaining('Connected'),
    );
  });

  it('posts integration summary on /summary', async () => {
    const integration = {
      _id: 'integration-1',
      podId: 'pod-1',
      type: 'telegram',
      config: { chatId: '42', messageBuffer: [{ content: 'hello' }] },
    };

    Integration.findOne = jest.fn().mockResolvedValue(integration);
    Integration.findById = jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        ...integration,
        config: { ...integration.config, messageBuffer: [{ content: 'hello' }] },
      }),
    });
    Integration.findByIdAndUpdate = jest.fn().mockResolvedValue({});
    IntegrationSummaryService.createSummary.mockResolvedValue({
      content: 'summary',
      messageCount: 1,
    });

    AgentEventService.enqueue.mockResolvedValue({ _id: 'event-1' });

    const res = await request(app)
      .post('/api/webhooks/telegram')
      .send({
        message: {
          text: '/summary',
          chat: { id: 42, title: 'Test Chat', type: 'group' },
          from: { id: 7, first_name: 'Sam' },
        },
      });

    expect(res.status).toBe(200);
    expect(IntegrationSummaryService.createSummary).toHaveBeenCalled();
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'commonly-bot',
        podId: integration.podId,
        type: 'integration.summary',
      }),
    );
    expect(telegramService.sendMessage).toHaveBeenCalledWith(
      'bot-token',
      '42',
      expect.stringContaining('Queued Telegram summary'),
    );
  });

  it('buffers non-command messages via provider', async () => {
    const integration = {
      _id: 'integration-1',
      type: 'telegram',
      config: { chatId: '42' },
    };
    Integration.findOne.mockResolvedValue(integration);
    const events = jest.fn((req, res) => res.sendStatus(200));
    registry.get.mockReturnValue({
      getWebhookHandlers: () => ({ events }),
    });

    const res = await request(app)
      .post('/api/webhooks/telegram')
      .send({
        message: {
          text: 'hello',
          chat: { id: 42, title: 'Test Chat', type: 'group' },
          from: { id: 7, first_name: 'Sam' },
        },
      });

    expect(res.status).toBe(200);
    expect(events).toHaveBeenCalled();
  });
  describe('live relay ack', () => {
    const liveIntegration = {
      _id: 'integration-1',
      type: 'telegram',
      podId: 'pod-1',
      config: {
        chatId: '42', chatType: 'private', liveRelay: true, linkedUserId: 'user-1', 
      },
    };

    const post = () => request(app)
      .post('/api/webhooks/telegram')
      .send({
        message: {
          text: 'hello',
          message_id: 555,
          chat: { id: 42, title: 'Test Chat', type: 'group' },
          from: { id: 7, first_name: 'Sam' },
        },
      });

    it('relays through the bridge instead of the buffer', async () => {
      Integration.findOne.mockResolvedValue(liveIntegration);
      bridge.relayTelegramMessageToPod.mockResolvedValue({ relayed: true });
      const events = jest.fn((req, res) => res.sendStatus(200));
      registry.get.mockReturnValue({ getWebhookHandlers: () => ({ events }) });

      const res = await post();

      expect(res.status).toBe(200);
      expect(bridge.relayTelegramMessageToPod).toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    });

    // The bridge swallows its own post-write failures, so anything that throws
    // out of it failed BEFORE the pod row existed. There is nothing to
    // duplicate and Telegram's redelivery is the only repair — the route must
    // NOT ack. A blanket catch + sendStatus(200) here drops those silently.
    it('does not ack when the relay throws, so Telegram redelivers', async () => {
      Integration.findOne.mockResolvedValue(liveIntegration);
      bridge.relayTelegramMessageToPod.mockRejectedValue(new Error('pg down'));
      const events = jest.fn((req, res) => res.sendStatus(200));
      registry.get.mockReturnValue({ getWebhookHandlers: () => ({ events }) });

      const res = await post();

      expect(res.status).toBe(500);
      expect(bridge.relayTelegramMessageToPod).toHaveBeenCalled();
      expect(events).not.toHaveBeenCalled();
    });
  });
});

describe('bridge command surface (/mode /status /mute /help)', () => {
  const linked = () => ({
    _id: 'integration-1',
    podId: 'pod-1',
    type: 'telegram',
    config: { chatId: '42', chatType: 'private', liveRelay: true, relayAllAgentMessages: true },
  });

  const post = (text) => request(app)
    .post('/api/webhooks/telegram')
    .send({ message: { text, message_id: 900, chat: { id: 42, type: 'private' }, from: { id: 7, first_name: 'Sam' } } });

  beforeEach(() => {
    Integration.findOne = jest.fn().mockResolvedValue(linked());
    Integration.findByIdAndUpdate = jest.fn().mockResolvedValue({});
  });

  it('/mode with no arg reports the current mode without writing', async () => {
    const res = await post('/mode');
    expect(res.status).toBe(200);
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(telegramService.sendMessage).toHaveBeenCalledWith(
      'bot-token', '42', expect.stringContaining('mirror'),
    );
  });

  it('/mode attention writes relayAllAgentMessages=false', async () => {
    const res = await post('/mode attention');
    expect(res.status).toBe(200);
    expect(Integration.findByIdAndUpdate).toHaveBeenCalledWith(
      'integration-1',
      { $set: { 'config.relayAllAgentMessages': false } },
    );
  });

  it('/mute writes a future relayMutedUntil and caps at 24h', async () => {
    const res = await post('/mute 99999');
    expect(res.status).toBe(200);
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    const until = new Date(update.$set['config.relayMutedUntil']).getTime();
    expect(until).toBeLessThanOrEqual(Date.now() + 24 * 60 * 60_000 + 5000);
    expect(until).toBeGreaterThan(Date.now());
  });

  it('/help answers without an integration lookup dependency', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    const res = await post('/help');
    expect(res.status).toBe(200);
    expect(telegramService.sendMessage).toHaveBeenCalledWith(
      'bot-token', '42', expect.stringContaining('/mode'),
    );
  });

  it('commands never fall through to the live relay', async () => {
    const bridge = require('../../../services/telegramBridgeService');
    await post('/status');
    expect(bridge.relayTelegramMessageToPod).not.toHaveBeenCalled();
  });

  describe('hardening: fail-closed verification + update_id dedup', () => {
    const WebhookDelivery = require('../../../models/WebhookDelivery');

    beforeEach(() => {
      // Env leaks between tests in this file (the reject-test deletes the
      // override, the secret-test sets a secret) — pin the default state.
      process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED = 'true';
      delete process.env.TELEGRAM_SECRET_TOKEN;
      WebhookDelivery.create.mockResolvedValue({});
      WebhookDelivery.deleteOne.mockResolvedValue({});
    });

    const liveUpdate = (updateId) => ({
      update_id: updateId,
      message: {
        text: 'hello from telegram',
        chat: { id: 42, title: 'Test Chat', type: 'group' },
        from: { id: 7, first_name: 'Sam' },
      },
    });

    it('rejects when TELEGRAM_SECRET_TOKEN is unset and no explicit override', async () => {
      delete process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED;
      const res = await request(app)
        .post('/api/webhooks/telegram')
        .send(liveUpdate(1));
      expect(res.status).toBe(401);
      expect(WebhookDelivery.create).not.toHaveBeenCalled();
    });

    it('still accepts a correct secret header when the secret is set', async () => {
      delete process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED;
      process.env.TELEGRAM_SECRET_TOKEN = 's3cret';
      Integration.findOne = jest.fn().mockResolvedValue(null);
      const res = await request(app)
        .post('/api/webhooks/telegram')
        .set('x-telegram-bot-api-secret-token', 's3cret')
        .send(liveUpdate(2));
      expect(res.status).toBe(200);
    });

    it('acks a duplicate update_id without processing it', async () => {
      const dup = new Error('dup');
      dup.code = 11000;
      WebhookDelivery.create.mockRejectedValueOnce(dup);
      Integration.findOne = jest.fn();
      const res = await request(app)
        .post('/api/webhooks/telegram')
        .send(liveUpdate(3));
      expect(res.status).toBe(200);
      expect(Integration.findOne).not.toHaveBeenCalled();
      expect(bridge.relayTelegramMessageToPod).not.toHaveBeenCalled();
    });

    it('releases the claim when processing throws, so redelivery retries', async () => {
      const integration = {
        _id: 'integration-1',
        type: 'telegram',
        podId: 'pod-1',
        config: { chatId: '42', liveRelay: true },
      };
      Integration.findOne = jest.fn().mockResolvedValue(integration);
      bridge.relayTelegramMessageToPod.mockRejectedValueOnce(new Error('pod write failed'));
      const res = await request(app)
        .post('/api/webhooks/telegram')
        .send(liveUpdate(4));
      expect(res.status).toBe(500);
      expect(WebhookDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'telegram', deliveryId: '4' }),
      );
      expect(WebhookDelivery.deleteOne).toHaveBeenCalledWith(
        { provider: 'telegram', deliveryId: '4' },
      );
    });

    // The real buffer handler is async and can reject (it awaits a Mongo
    // write). A synchronous mock here would let an un-awaited
    // `return events(req, res)` pass — the rejection must reach the catch so
    // the claim is released and Telegram's redelivery is a retry, not a
    // duplicate-acked drop.
    it('releases the claim when the async buffer handler rejects', async () => {
      const integration = {
        _id: 'integration-1',
        type: 'telegram',
        config: { chatId: '42' },
      };
      Integration.findOne = jest.fn().mockResolvedValue(integration);
      const events = jest.fn(async () => {
        throw new Error('provider write failed');
      });
      registry.get.mockReturnValue({ getWebhookHandlers: () => ({ events }) });
      const res = await request(app)
        .post('/api/webhooks/telegram')
        .send(liveUpdate(6));
      expect(res.status).toBe(500);
      expect(events).toHaveBeenCalled();
      expect(WebhookDelivery.deleteOne).toHaveBeenCalledWith(
        { provider: 'telegram', deliveryId: '6' },
      );
    });

    // Updates with no update_id must bypass the claim entirely: without the
    // guard they would all claim the literal key 'undefined' — the first one
    // takes it and every later un-id'd update is acked and dropped.
    it('processes every update that carries no update_id', async () => {
      const integration = {
        _id: 'integration-1',
        type: 'telegram',
        podId: 'pod-1',
        config: { chatId: '42', liveRelay: true },
      };
      Integration.findOne = jest.fn().mockResolvedValue(integration);
      bridge.relayTelegramMessageToPod.mockResolvedValue({});
      const noIdUpdate = liveUpdate(undefined);
      delete noIdUpdate.update_id;

      const first = await request(app).post('/api/webhooks/telegram').send(noIdUpdate);
      const second = await request(app).post('/api/webhooks/telegram').send(noIdUpdate);

      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(bridge.relayTelegramMessageToPod).toHaveBeenCalledTimes(2);
      expect(WebhookDelivery.create).not.toHaveBeenCalled();
    });

    it('a dedup-store outage does not take the bridge down', async () => {
      WebhookDelivery.create.mockRejectedValueOnce(new Error('mongo down'));
      const integration = {
        _id: 'integration-1',
        type: 'telegram',
        podId: 'pod-1',
        config: { chatId: '42', liveRelay: true },
      };
      Integration.findOne = jest.fn().mockResolvedValue(integration);
      bridge.relayTelegramMessageToPod.mockResolvedValueOnce({});
      const res = await request(app)
        .post('/api/webhooks/telegram')
        .send(liveUpdate(5));
      expect(res.status).toBe(200);
      expect(bridge.relayTelegramMessageToPod).toHaveBeenCalled();
    });
  });
});
