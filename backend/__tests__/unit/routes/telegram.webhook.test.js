const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration');
jest.mock('../../../models/Pod');
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/integrationSummaryService', () => ({ createSummary: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const Summary = require('../../../models/Summary');
const IntegrationSummaryService = require('../../../services/integrationSummaryService');
const AgentEventService = require('../../../services/agentEventService');
const telegramService = require('../../../services/telegramService');
const registry = require('../../../integrations');

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
});
