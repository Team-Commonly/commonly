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
  });

  it('handles /commonly-enable and links chat', async () => {
    const integration = {
      _id: 'integration-1',
      podId: 'pod-1',
      config: { connectCode: 'abc123' },
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
      config: { chatId: '42', chatType: 'private', liveRelay: true, linkedUserId: 'user-1' },
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
});
