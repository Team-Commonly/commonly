// /commonly-enable hardening: expired/legacy codes are refused, attempts are
// rate-limited per chat, and a live-relay integration cannot be bound from a
// group (the relay authors inbound as the linked user and streams outbound).
const request = require('supertest');
const express = require('express');

jest.mock('../../../models/Integration');
jest.mock('../../../models/Pod');
jest.mock('../../../models/Summary', () => ({ findOne: jest.fn() }));
jest.mock('../../../services/integrationSummaryService', () => ({ createSummary: jest.fn() }));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../services/telegramBridgeService', () => ({ relayTelegramMessageToPod: jest.fn() }));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const telegramService = require('../../../services/telegramService');
const { resetEnableAttempts, ENABLE_ATTEMPT_LIMIT } = require('../../../services/telegramConnectCode');
const telegramRoutes = require('../../../routes/webhooks/telegram');

const app = express();
app.use(express.json());
app.use('/api/webhooks/telegram', telegramRoutes);

const enable = (code, chat = { id: 42, type: 'private', first_name: 'Sam' }) => request(app)
  .post('/api/webhooks/telegram')
  .send({ message: { text: `/commonly-enable ${code}`, chat, from: { id: 7 } } });

const freshCode = () => ({
  connectCode: 'c'.repeat(32),
  connectCodeExpiresAt: new Date(Date.now() + 60000),
});

describe('/commonly-enable hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetEnableAttempts();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    delete process.env.TELEGRAM_SECRET_TOKEN;
    Integration.findByIdAndUpdate = jest.fn().mockResolvedValue({});
    Pod.findById.mockReturnValue({ lean: jest.fn().mockResolvedValue({ name: 'Test Pod' }) });
  });

  it('refuses a legacy code with no expiry', async () => {
    Integration.findOne = jest.fn()
      .mockResolvedValueOnce({ _id: 'i1', podId: 'p1', config: { connectCode: 'abc123' } });
    await enable('abc123');
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(telegramService.sendMessage.mock.calls[0][2]).toMatch(/expired/i);
  });

  it('refuses an expired code', async () => {
    Integration.findOne = jest.fn().mockResolvedValueOnce({
      _id: 'i1', podId: 'p1', config: { connectCode: 'x', connectCodeExpiresAt: new Date(Date.now() - 1) },
    });
    await enable('x');
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
  });

  it('binds a fresh code and clears both code fields', async () => {
    Integration.findOne = jest.fn()
      .mockResolvedValueOnce({ _id: 'i1', podId: 'p1', config: freshCode() })
      .mockResolvedValueOnce(null);
    await enable('c'.repeat(32));
    const [, update] = Integration.findByIdAndUpdate.mock.calls[0];
    expect(update.$unset).toEqual({ 'config.connectCode': '', 'config.connectCodeExpiresAt': '' });
    expect(update.$set['config.chatType']).toBe('private');
  });

  it('rate-limits attempts per chat and stops looking codes up', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT; i += 1) await enable(`guess${i}`); // eslint-disable-line no-await-in-loop
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    await enable('one-more');
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    expect(telegramService.sendMessage.mock.calls.at(-1)[2]).toMatch(/too many attempts/i);
  });

  it('refuses to bind a live-relay integration from a group chat', async () => {
    Integration.findOne = jest.fn()
      .mockResolvedValueOnce({ _id: 'i1', podId: 'p1', config: { ...freshCode(), liveRelay: true } })
      .mockResolvedValueOnce(null);
    await enable('c'.repeat(32), { id: -100, type: 'supergroup', title: 'Crew' });
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(telegramService.sendMessage.mock.calls[0][2]).toMatch(/private chat/i);
  });

  it('still binds a legacy (buffer) integration from a group', async () => {
    Integration.findOne = jest.fn()
      .mockResolvedValueOnce({ _id: 'i1', podId: 'p1', config: freshCode() })
      .mockResolvedValueOnce(null);
    await enable('c'.repeat(32), { id: -100, type: 'group', title: 'Crew' });
    expect(Integration.findByIdAndUpdate).toHaveBeenCalled();
  });
});
