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
// Stub the network, keep the behaviour: the bridge escapes through this module's
// escapeHtml, so a bare stub leaves it undefined and the send is swallowed.
jest.mock('../../../services/telegramService', () => ({
  ...jest.requireActual('../../../services/telegramService'),
  sendMessage: jest.fn(),
}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../services/telegramBridgeService', () => ({ relayTelegramMessageToPod: jest.fn() }));
jest.mock('../../../models/WebhookDelivery', () => ({
  create: jest.fn(),
  deleteOne: jest.fn(),
}));

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const WebhookDelivery = require('../../../models/WebhookDelivery');
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

// TASK-153: what the connectors page displays. `groupCode` in V2ConnectorsPage
// splits the 32 hex chars into fours, so the tokens after the command are ONE
// code — before the fix only the first group was read and every attempt failed.
const SPACED_CODE = '1964 774b a58c d1e2 f3a4 b5c6 d7e8 f9a0';
const JOINED_CODE = SPACED_CODE.replace(/\s+/g, '');

describe('/commonly-enable hardening', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetEnableAttempts();
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    delete process.env.TELEGRAM_SECRET_TOKEN;
    // Verification is fail-closed on main (hardening H1); these tests exercise
    // the enable handler, not auth, so they run with the explicit dev override
    // and a stubbed delivery-claim store, same as telegram.webhook.test.js.
    process.env.TELEGRAM_WEBHOOK_ALLOW_UNVERIFIED = 'true';
    WebhookDelivery.create.mockResolvedValue({});
    WebhookDelivery.deleteOne.mockResolvedValue({});
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

  it('binds from the spaced form the connectors page displays', async () => {
    const integration = { _id: 'i1', podId: 'p1', config: { ...freshCode(), connectCode: JOINED_CODE } };
    Integration.findOne = jest.fn().mockResolvedValueOnce(integration).mockResolvedValueOnce(null);
    await enable(SPACED_CODE);
    // The lookup is the contract: the whole displayed code, whitespace removed.
    expect(Integration.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'config.connectCode': JOINED_CODE }),
    );
    expect(Integration.findByIdAndUpdate).toHaveBeenCalled();
  });

  it('still refuses a spaced code that matches nothing', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    await enable('zzzz zzzz zzzz zzzz');
    expect(Integration.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'config.connectCode': 'zzzzzzzzzzzzzzzz' }),
    );
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(telegramService.sendMessage.mock.calls[0][2]).toMatch(/invalid or expired/i);
  });

  // Witnesses where the join sits, not just that it happens: joining must not
  // move the attempt counter, or one displayed command burns the whole budget.
  it('spends one attempt on a spaced command, not one per group', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    await enable(SPACED_CODE); // eight groups, one command
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT - 1; i += 1) {
      await enable(`guess${i}`); // eslint-disable-line no-await-in-loop
    }
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    await enable('one-more');
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    expect(telegramService.sendMessage.mock.calls.at(-1)[2]).toMatch(/too many attempts/i);
  });
});
