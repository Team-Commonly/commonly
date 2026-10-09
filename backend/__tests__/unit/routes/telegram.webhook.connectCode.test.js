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
// The counter's VALUE is the contract for TASK-157 (a typo must spend no try),
// so count the calls while keeping the real budget implementation behind them.
jest.mock('../../../services/telegramConnectCode', () => {
  const actual = jest.requireActual('../../../services/telegramConnectCode');
  return {
    ...actual,
    registerEnableAttempt: jest.fn(actual.registerEnableAttempt),
    // TASK-159: the route must ask this module for the shape. Wrapping the real
    // implementation keeps the behaviour while recording the call, so a local
    // regex reappearing in the route reddens instead of drifting silently.
    isConnectCodeShape: jest.fn(actual.isConnectCodeShape),
  };
});

const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
const WebhookDelivery = require('../../../models/WebhookDelivery');
const telegramService = require('../../../services/telegramService');
const {
  registerEnableAttempt, resetEnableAttempts, ENABLE_ATTEMPT_LIMIT, isConnectCodeShape,
} = require('../../../services/telegramConnectCode');
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
// A well-formed code that no row carries: the shape gate (TASK-157) admits it,
// so it reaches the lookup and spends an attempt, and still refuses.
const wrongCode = (n) => n.toString(16).padStart(32, '0');

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

  it('refuses a code with no expiry', async () => {
    Integration.findOne = jest.fn()
      .mockResolvedValueOnce({ _id: 'i1', podId: 'p1', config: { connectCode: 'a'.repeat(32) } });
    await enable('a'.repeat(32));
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    expect(telegramService.sendMessage.mock.calls[0][2]).toMatch(/expired/i);
  });

  it('refuses an expired code', async () => {
    Integration.findOne = jest.fn().mockResolvedValueOnce({
      _id: 'i1', podId: 'p1', config: { connectCode: 'e'.repeat(32), connectCodeExpiresAt: new Date(Date.now() - 1) },
    });
    await enable('e'.repeat(32));
    expect(Integration.findByIdAndUpdate).not.toHaveBeenCalled();
    // TASK-157 follow-up (vera 74617): `findByIdAndUpdate` not called is
    // satisfied by ANY refusal, so on its own this arm cannot tell an expiry
    // refusal from a shape refusal. Assert the expiry copy, like its sibling
    // `refuses a code with no expiry` does.
    expect(telegramService.sendMessage.mock.calls[0][2]).toMatch(/invalid or expired/i);
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
    // Well-formed guesses: only those are metered, which is the point of the
    // shape gate (TASK-157) — a malformed one is refused without an attempt.
    for (let i = 0; i < ENABLE_ATTEMPT_LIMIT; i += 1) {
      await enable(wrongCode(i)); // eslint-disable-line no-await-in-loop
    }
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    await enable(wrongCode(99));
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
    await enable('dead beef dead beef dead beef dead beef');
    expect(Integration.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'config.connectCode': 'deadbeefdeadbeefdeadbeefdeadbeef' }),
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
      await enable(wrongCode(i)); // eslint-disable-line no-await-in-loop
    }
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    await enable(wrongCode(99));
    expect(Integration.findOne).toHaveBeenCalledTimes(ENABLE_ATTEMPT_LIMIT);
    expect(telegramService.sendMessage.mock.calls.at(-1)[2]).toMatch(/too many attempts/i);
  });

  // TASK-157. The counter's VALUE is asserted, not the fact that a refusal
  // happened: the point is which inputs cost one of the chat's five tries.
  it('spends exactly one attempt on a well-formed wrong code', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    await enable(wrongCode(7));
    expect(registerEnableAttempt).toHaveBeenCalledTimes(1);
    expect(registerEnableAttempt).toHaveBeenCalledWith('42');
    expect(Integration.findOne).toHaveBeenCalledTimes(1);
    expect(telegramService.sendMessage.mock.calls.at(-1)[2]).toMatch(/invalid or expired/i);
  });

  // TASK-159. Everything above pins the VALUES the shape gate produces; this
  // pins WHERE the answer comes from. Without it, re-adding a local
  // `CONNECT_CODE_SHAPE` to the route keeps every arm green while the two
  // definitions drift apart — the failure this row exists to close.
  it('asks the service for the shape instead of matching its own copy', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    await enable(SPACED_CODE.toUpperCase());
    // Normalised before the predicate: lowercased, groups joined (vera 74615).
    expect(isConnectCodeShape).toHaveBeenCalledWith(JOINED_CODE);
  });

  // vera 74641: the arm above pins WHERE the answer comes from, not that the
  // answer is USED. A belt-and-braces drift -- ask the service and then also
  // apply a local regex -- would keep every arm green. Admitting a malformed
  // code through the service must therefore let the lookup proceed: if the
  // route re-checks the code itself, this refuses instead and reddens.
  it('lets the service answer decide, rather than re-checking the code itself', async () => {
    Integration.findOne = jest.fn().mockResolvedValue(null);
    isConnectCodeShape.mockReturnValueOnce(true);
    await enable('not-a-connect-code');
    expect(registerEnableAttempt).toHaveBeenCalledTimes(1);
    expect(Integration.findOne).toHaveBeenCalledTimes(1);
  });

  it.each(['1964', 'abc123', `${JOINED_CODE}a`, JOINED_CODE.slice(0, 31)])(
    'spends no attempt on the malformed code %s',
    async (input) => {
      Integration.findOne = jest.fn().mockResolvedValue(null);
      await enable(input);
      expect(registerEnableAttempt).not.toHaveBeenCalled();
      expect(Integration.findOne).not.toHaveBeenCalled();
      expect(telegramService.sendMessage.mock.calls[0][2])
        .toMatch(/doesn't look like a connect code/i);
    },
  );

  it('binds a capitalised, spaced code', async () => {
    const integration = { _id: 'i1', podId: 'p1', config: { ...freshCode(), connectCode: JOINED_CODE } };
    Integration.findOne = jest.fn().mockResolvedValueOnce(integration).mockResolvedValueOnce(null);
    await enable(SPACED_CODE.toUpperCase());
    expect(Integration.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ 'config.connectCode': JOINED_CODE }),
    );
    expect(Integration.findByIdAndUpdate).toHaveBeenCalled();
  });
});
