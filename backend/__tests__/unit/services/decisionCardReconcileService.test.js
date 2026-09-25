jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../services/slackApi', () => jest.fn());
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn(async () => 'slack-token') }));

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const Integration = require('../../../models/Integration');
const DecisionRequest = require('../../../models/DecisionRequest');
const Pod = require('../../../models/Pod');
const telegramSend = require('../../../services/telegramService');
const SlackApi = require('../../../services/slackApi');
const Verdict = require('../../../models/ChannelVerdict');
const {
  fanoutDecisionClosure, sweepDecisionCards, CLOSED_CARD_RETENTION_MS,
} = require('../../../services/decisionCardReconcileService');

const podId = new mongoose.Types.ObjectId();
const ownerId = new mongoose.Types.ObjectId();
const siblingId = new mongoose.Types.ObjectId();
const memberId = new mongoose.Types.ObjectId();
const cardId = 'decision-message-1';

const chain = (value) => ({ select: () => ({ lean: async () => value }) });

beforeAll(async () => { await setupMongoDb(); });
afterAll(() => closeMongoDb());
beforeEach(async () => {
  await clearMongoDb();
  jest.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'telegram-token';
  Pod.findById.mockImplementation(() => chain({ createdBy: ownerId, members: [ownerId, memberId] }));
  telegramSend.sendMessage.mockResolvedValue({ success: true, messageId: 19 });
  SlackApi.mockImplementation(() => ({ postMessage: jest.fn(async () => ({ ok: true, ts: '2.1' })) }));
});
afterEach(() => { jest.restoreAllMocks(); });

describe('decision card closure fan-out', () => {
  test('stamps every receipt and sends workspace confirmation only to eligible siblings', async () => {
    const origin = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: ownerId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(ownerId), chatType: 'private', chatId: 'origin',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '11', sentAt: new Date() }],
      },
    });
    const sibling = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'private', chatId: 'sibling',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '12', sentAt: new Date() }],
      },
    });
    await Verdict.create([
      {
        integrationId: origin._id, podId, provider: 'telegram',
        event: { kind: 'decision_request', podMessageId: cardId },
        verdict: 'interrupt', reason: 'card',
      },
      {
        integrationId: sibling._id, podId, provider: 'telegram',
        event: { kind: 'decision_request', podMessageId: cardId },
        verdict: 'interrupt', reason: 'card',
      },
    ]);

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'Now', byUsername: 'Sam' } },
      { via: 'workspace', integrationId: origin._id },
    );

    expect(telegramSend.sendMessage).toHaveBeenCalledWith(
      'telegram-token', 'sibling', '✓ Ruled by Sam: Now',
      { replyToMessageId: '12', plainText: true },
    );
    expect((await Integration.findById(origin._id)).config.cards[0].closedAt).toEqual(expect.any(Date));
    expect((await Integration.findById(sibling._id)).config.cards[0].closedAt).toEqual(expect.any(Date));
    expect(await Verdict.find({ 'event.podMessageId': cardId })).toEqual([
      expect.objectContaining({ ruledVia: 'workspace', reachedHumanAt: undefined }),
      expect.objectContaining({ ruledVia: 'workspace', reachedHumanAt: undefined }),
    ]);
  });

  test('carries a channel origin through every fork ledger row', async () => {
    const origin = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: ownerId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(ownerId), chatType: 'private', chatId: 'origin',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '16', sentAt: new Date() }],
      },
    });
    const sibling = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'private', chatId: 'sibling',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '17', sentAt: new Date() }],
      },
    });
    await Verdict.create([
      {
        integrationId: origin._id, podId, provider: 'telegram',
        event: { kind: 'decision_request', podMessageId: cardId },
        verdict: 'interrupt', reason: 'card',
      },
      {
        integrationId: sibling._id, podId, provider: 'telegram',
        event: { kind: 'decision_request', podMessageId: cardId },
        verdict: 'interrupt', reason: 'card',
      },
    ]);

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'Now', byUsername: 'Sam' } },
      { via: 'telegram', integrationId: origin._id },
    );

    expect(await Verdict.find({ 'event.podMessageId': cardId })).toEqual([
      expect.objectContaining({ ruledVia: 'telegram', reachedHumanAt: undefined }),
      expect.objectContaining({ ruledVia: 'telegram', reachedHumanAt: undefined }),
    ]);
  });

  test('targets the sibling Slack card thread rather than the first receipt', async () => {
    const origin = await Integration.create({
      podId, scope: 'user', type: 'slack', createdBy: ownerId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(ownerId), chatType: 'im', chatId: 'origin', teamId: 'T1',
        botTokenRef: 'origin-ref', gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, externalMessageId: '1.1', sentAt: new Date() }],
      },
    });
    const siblingSend = jest.fn(async () => ({ ok: true, ts: '2.2' }));
    SlackApi.mockImplementation(() => ({ postMessage: siblingSend }));
    const sibling = await Integration.create({
      podId, scope: 'user', type: 'slack', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'im', chatId: 'sibling', teamId: 'T1',
        botTokenRef: 'sibling-ref', gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, externalMessageId: '2.2', sentAt: new Date() }],
      },
    });

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'A < B', byUsername: 'Sam' } },
      { via: 'workspace', integrationId: origin._id },
    );

    expect(siblingSend).toHaveBeenCalledWith('sibling', '✓ Ruled by Sam: A &lt; B', undefined, '2.2');
    expect((await Integration.findById(sibling._id)).config.cards[0].closedAt).toEqual(expect.any(Date));
  });

  test('a permanent Telegram failure on the closing line names the reason on the connector', async () => {
    // The sibling of the Slack test below, and the reason it exists: the two
    // branches' classification lines are textually identical, so a mutation
    // aimed at one of them silently exercises the other unless each has its own
    // witness.
    const origin = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: ownerId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(ownerId), chatType: 'private', chatId: 'origin-telegram',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '1.1', sentAt: new Date() }],
      },
    });
    const gone = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'private', chatId: 'gone-telegram',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '2.2', sentAt: new Date() }],
      },
    });
    telegramSend.sendMessage.mockResolvedValue({
      success: false,
      errorCode: 403,
      description: 'Forbidden: bot was blocked by the user',
    });

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'A', byUsername: 'Sam' } },
      { via: 'workspace', integrationId: origin._id },
    );

    // Detached delivery again: poll rather than race the background write.
    const deadline = Date.now() + 3000;
    let stored = await Integration.findById(gone._id);
    while (stored.status !== 'error' && Date.now() < deadline) {
      /* eslint-disable no-await-in-loop -- polling a detached write, bounded below */
      await new Promise((resolve) => setTimeout(resolve, 25));
      stored = await Integration.findById(gone._id);
      /* eslint-enable no-await-in-loop */
    }

    expect(stored.status).toBe('error');
    expect(stored.errorMessage).toBe('Telegram stopped delivering: the bot was blocked or removed from this chat.');
    expect(stored.config.chatId).toBeUndefined();
    expect((await Integration.findById(origin._id)).status).toBe('connected');
  });

  test('a permanent Slack delivery failure names the reason on the connector and unsets its channel', async () => {
    const origin = await Integration.create({
      podId, scope: 'user', type: 'slack', createdBy: ownerId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(ownerId), chatType: 'im', chatId: 'origin', teamId: 'T1',
        botTokenRef: 'origin-ref', gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, externalMessageId: '1.1', sentAt: new Date() }],
      },
    });
    const gone = await Integration.create({
      podId, scope: 'user', type: 'slack', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'im', chatId: 'gone', teamId: 'T1',
        botTokenRef: 'gone-ref', gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, externalMessageId: '4.4', sentAt: new Date() }],
      },
    });
    // `channel_not_found` is permanent: the bot cannot reach this channel again
    // until someone re-authorizes, which the unset below is what re-allows.
    const goneSend = jest.fn(async () => ({ ok: false, error: 'channel_not_found' }));
    SlackApi.mockImplementation(() => ({ postMessage: goneSend }));

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'A', byUsername: 'Sam' } },
      { via: 'workspace', integrationId: origin._id },
    );

    // One send, so the flip below cannot be a row that was merely swept up. The
    // closure id passed above is skipped by the fan-out, so `gone` is the only
    // receipt holder that receives text.
    expect(goneSend).toHaveBeenCalledTimes(1);

    // Delivery is deliberately detached (`void Promise.allSettled`), so the flip
    // lands after the call returns. Poll for it rather than assert into a race.
    const deadline = Date.now() + 3000;
    let stored = await Integration.findById(gone._id);
    while (stored.status !== 'error' && Date.now() < deadline) {
      /* eslint-disable no-await-in-loop -- polling a detached write, bounded below */
      await new Promise((resolve) => setTimeout(resolve, 25));
      stored = await Integration.findById(gone._id);
      /* eslint-enable no-await-in-loop */
    }

    expect(stored.status).toBe('error');
    expect(stored.errorMessage).toBe('Slack stopped delivering: this channel no longer exists.');
    expect(stored.config.chatId).toBeUndefined();
    expect((await Integration.findById(origin._id)).status).toBe('connected');
  });

  test('rechecks mute and gate at ruling time but still closes their receipts', async () => {
    const held = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'private', chatId: 'held',
        relayMutedUntil: new Date(Date.now() + 60000),
        gates: { [String(podId)]: { enabled: false, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '13', sentAt: new Date() }],
      },
    });

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'Later', byUsername: 'Sam' } },
      { via: 'workspace' },
    );

    expect(telegramSend.sendMessage).not.toHaveBeenCalled();
    expect((await Integration.findById(held._id)).config.cards[0].closedAt).toEqual(expect.any(Date));
  });

  test('does not authorize a closing line from createdBy when linkedUserId is absent', async () => {
    const missingLink = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, chatType: 'private', chatId: 'wrong-recipient',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '15', sentAt: new Date() }],
      },
    });

    await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'Now', byUsername: 'Sam' } },
      { via: 'workspace' },
    );

    expect(telegramSend.sendMessage).not.toHaveBeenCalled();
    expect((await Integration.findById(missingLink._id)).config.cards[0].closedAt).toEqual(expect.any(Date));
  });

  test('returns after durable closure while a sibling provider send is still pending', async () => {
    let releaseSend;
    const pendingSend = new Promise((resolve) => { releaseSend = resolve; });
    telegramSend.sendMessage.mockReturnValueOnce(pendingSend);
    const sibling = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: memberId, isActive: true, status: 'connected',
      config: {
        liveRelay: true, linkedUserId: String(memberId), chatType: 'private', chatId: 'sibling',
        gates: { [String(podId)]: { enabled: true, since: new Date() } },
        cards: [{ podMessageId: cardId, tgMessageId: '14', sentAt: new Date() }],
      },
    });

    const returned = await fanoutDecisionClosure(
      { _id: new mongoose.Types.ObjectId(), podId, messageId: cardId, ruling: { value: 'Now', byUsername: 'Sam' } },
      { via: 'workspace' },
    );

    expect(returned).toBeUndefined();
    expect((await Integration.findById(sibling._id)).config.cards[0].closedAt).toEqual(expect.any(Date));
    expect(telegramSend.sendMessage).toHaveBeenCalled();
    releaseSend({ success: true, messageId: 20 });
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('decision card receipt sweep', () => {
  test('stamps ruled and missing rows, leaves pending and prunes only finished old rows', async () => {
    const now = new Date('2026-09-07T00:00:00.000Z');
    const old = new Date(now.getTime() - CLOSED_CARD_RETENTION_MS - 1);
    const ruled = await DecisionRequest.create({
      podId, agentUserId: ownerId, agentName: 'kai', decisionClass: 'implementation',
      title: 'T', question: 'Q', options: [{ label: 'A' }, { label: 'B' }], messageId: 'ruled-row', status: 'ruled',
      ruling: { value: 'A', byUserId: ownerId, byUsername: 'Sam', at: now, messageId: 'reply' },
    });
    await DecisionRequest.create({
      podId, agentUserId: ownerId, agentName: 'kai', decisionClass: 'implementation',
      title: 'T', question: 'Q', options: [{ label: 'A' }, { label: 'B' }], messageId: 'pending-row', status: 'pending',
    });
    await DecisionRequest.create({
      podId, agentUserId: ownerId, agentName: 'kai', decisionClass: 'implementation',
      title: 'T', question: 'Q', options: [{ label: 'A' }, { label: 'B' }], messageId: 'pending-marked', status: 'pending',
    });
    const integration = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: ownerId, isActive: false, status: 'disconnected',
      config: {
        cards: [
          { podMessageId: 'ruled-row', sentAt: now },
          { podMessageId: 'missing-row', sentAt: now },
          { podMessageId: 'pending-row', sentAt: now },
          { podMessageId: 'old-ruled', sentAt: old, closedAt: old },
          { podMessageId: 'pending-marked', sentAt: old, closedAt: old },
        ],
      },
    });

    const result = await sweepDecisionCards(now);
    const cards = (await Integration.findById(integration._id)).config.cards;
    expect(result.stamped).toBe(2);
    expect(result.removed).toBe(1);
    expect(cards.find((card) => card.podMessageId === 'ruled-row').closedAt).toEqual(now);
    expect(cards.find((card) => card.podMessageId === 'missing-row').closedAt).toEqual(now);
    expect(cards.find((card) => card.podMessageId === 'pending-row').closedAt).toBeUndefined();
    expect(cards.find((card) => card.podMessageId === 'old-ruled')).toBeUndefined();
    expect(cards.find((card) => card.podMessageId === 'pending-marked').closedAt).toEqual(old);
    expect(String(ruled._id)).toBeTruthy();
  });

  test('does not treat a failed row lookup as a missing decision', async () => {
    const integration = await Integration.create({
      podId, scope: 'user', type: 'telegram', createdBy: ownerId, isActive: false, status: 'disconnected',
      config: { cards: [{ podMessageId: 'unreadable', sentAt: new Date() }] },
    });
    const original = DecisionRequest.find;
    DecisionRequest.find = jest.fn(() => ({ select: () => ({ lean: async () => { throw new Error('db down'); } }) }));
    try {
      expect(await sweepDecisionCards()).toEqual({ stamped: 0, removed: 0 });
    } finally {
      DecisionRequest.find = original;
    }
    expect((await Integration.findById(integration._id)).config.cards[0].closedAt).toBeUndefined();
  });
});
