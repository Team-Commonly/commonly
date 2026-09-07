// Real Mongo CAS, receipts and ledger; provider transport, PG storage and
// downstream event transport are isolated. Both bridges call the real verb.
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn(async () => ({ id: 'pod' })) }));
jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn() }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn(async () => ({})) }));
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn(async () => ({})) }));
jest.mock('../../../services/attentionItemService', () => ({ resolve: jest.fn(async () => {}), recordDecision: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../services/slackApi', () => jest.fn());
jest.mock('../../../services/connectorSecrets', () => ({ get: jest.fn(async () => 'token') }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));
jest.mock('../../../services/threadRootResolver', () => ({ resolveThreadRoot: jest.fn(async () => 600) }));

const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');
const Decision = require('../../../models/DecisionRequest');
const Integration = require('../../../models/Integration');
const Verdict = require('../../../models/ChannelVerdict');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const PGMessage = require('../../../models/pg/Message');
const telegramSend = require('../../../services/telegramService');
const SlackApi = require('../../../services/slackApi');
const decisions = require('../../../services/decisionRequestService');
const { enqueue } = require('../../../services/agentEventService');
const { deliverMessageToAgents } = require('../../../services/messageAgentDeliveryService');
const telegram = require('../../../services/telegramBridgeService');
const slack = require('../../../services/slackBridgeService');

const podId = String(new mongoose.Types.ObjectId());
const otherPodId = String(new mongoose.Types.ObjectId());
const ownerId = String(new mongoose.Types.ObjectId());
const newOwnerId = String(new mongoose.Types.ObjectId());
const agentId = String(new mongoose.Types.ObjectId());
const chain = (value) => ({ select: () => ({ lean: async () => value }) });
let messages;
let slackSend;
let choose;

beforeAll(async () => { await setupMongoDb(); await Verdict.syncIndexes(); });
afterAll(() => closeMongoDb());
beforeEach(() => {
  jest.clearAllMocks();
  messages = [];
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  Pod.findById.mockImplementation(() => chain({ name: 'Launch', type: 'team', members: [ownerId, newOwnerId] }));
  User.findById.mockImplementation(() => chain({ username: 'sam', isBot: false }));
  PGMessage.create.mockImplementation(async (pid, uid, content, _type, replyTo, _payload, root) => {
    const message = { id: String(900 + messages.length), podId: pid, userId: uid, content, replyTo, thread_root_id: root || replyTo };
    messages.push(message);
    return message;
  });
  PGMessage.findById.mockImplementation(async (id) => messages.find((message) => message.id === String(id)));
  telegramSend.sendMessage.mockResolvedValue({ success: true, messageId: 42 });
  slackSend = jest.fn(async () => ({ ok: true, ts: '42.001' }));
  SlackApi.mockImplementation(() => ({ postMessage: slackSend }));
  choose = jest.spyOn(decisions, 'chooseDecision');
});
afterEach(async () => { jest.restoreAllMocks(); await clearMongoDb(); });

describe.each(['telegram', 'slack'])('%s decision reply', (provider) => {
  let binding;
  let decision;
  const externalId = provider === 'telegram' ? '42' : '42.001';
  const send = (integration, card) => (provider === 'telegram' ? telegram.relayAgentMessageToTelegram : slack.relayAgentMessageToSlack)({
    integration, podId, agentUsername: 'kai', displayName: 'Kai', podMessageId: card.messageId,
    content: '[DECISION] ordinary', card,
  });
  const receive = async (text = '2', quote = externalId, overrides = {}, id = binding._id) => {
    const integration = await Integration.findById(id).lean();
    if (provider === 'telegram') return telegram.relayTelegramMessageToPod({
      integration, telegramMessage: { text, ...(quote ? { reply_to_message_id: Number(quote) } : {}), ...overrides },
    });
    return slack.relaySlackMessageToPod({
      integration, event: { text, user: 'U1', ...(quote ? { thread_ts: quote } : {}), ...overrides },
    });
  };
  const confirmation = () => provider === 'telegram'
    ? telegramSend.sendMessage.mock.calls.at(-1)[2] : slackSend.mock.calls.at(-1)[1];
  const receipts = async () => (await Integration.findById(binding._id).lean()).config.cards;
  const ledger = async () => Verdict.find({ integrationId: binding._id }).lean();
  const assertOpen = async () => {
    expect((await Decision.findById(decision._id)).status).toBe('pending');
    expect((await receipts())[0].closedAt).toBeUndefined();
    expect(await ledger()).toEqual([expect.objectContaining({ verdict: 'interrupt', reason: 'card' })]);
    expect((await ledger())[0].reachedHumanAt).toBeUndefined();
    expect((await ledger())[0].ruledVia).toBeUndefined();
  };
  beforeEach(async () => {
    decision = await Decision.create({
      podId, agentUserId: agentId, agentName: 'kai', decisionClass: 'implementation',
      title: 'Release?', question: 'When?', options: [{ label: 'Later' }, { label: 'Now' }], messageId: '700',
    });
    binding = await Integration.create({
      podId: otherPodId, scope: 'user', type: provider, createdBy: ownerId, isActive: true, status: 'connected',
      config: {
        linkedUserId: ownerId, chatType: provider === 'telegram' ? 'private' : 'im', liveRelay: true,
        chatId: 'chat', teamId: 'T1', slackUserId: 'U1', botTokenRef: 'ref',
        gates: { [podId]: { enabled: true, since: new Date() } },
      },
    });
    await send(await Integration.findById(binding._id).lean(), decision.toObject());
    expect((await receipts())).toHaveLength(1);
    telegramSend.sendMessage.mockClear();
    slackSend.mockClear();
  });

  test('200: one threaded ruling, one typed wake, one closed receipt and reached ledger', async () => {
    await receive();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(choose).toHaveBeenCalledWith({ decisionId: String(decision._id), callerUserId: ownerId, value: 'Now' });
    expect(messages).toEqual([expect.objectContaining({ podId, userId: ownerId, content: 'Now', replyTo: '700', thread_root_id: '700' })]);
    expect(messages.filter((m) => m.thread_root_id == null)).toHaveLength(0);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'decision.ruled' }));
    expect((await receipts())[0].closedAt).toEqual(expect.any(Date));
    expect(await ledger()).toEqual([expect.objectContaining({ reachedHumanAt: expect.any(Date), ruledVia: provider })]);
    expect(String((await ledger())[0].event.decisionId)).toBe(String(decision._id));
    expect(confirmation()).toBe('✓ Ruled: Now');
    if (provider === 'telegram') expect(telegramSend.sendMessage.mock.calls[0][3]).toEqual({ replyToMessageId: externalId, plainText: true });
    else expect(slackSend.mock.calls[0][3]).toBe(externalId);
  });

  test('free text is trimmed and capped, with no ordinary duplicate', async () => {
    await receive(`  ${'x'.repeat(2100)}  `);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('x'.repeat(2000));
    expect(choose.mock.calls[0][0].value).toBe('x'.repeat(2000));
  });

  test('out-of-range calls no verb and writes nothing', async () => {
    await receive('7');
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    await assertOpen();
    expect(confirmation()).toBe('Pick 1–2, or write your ruling.');
  });

  test('403 from verb closes nothing and never falls through', async () => {
    choose.mockResolvedValueOnce({ status: 403, body: { error: 'Only human pod members can rule' } });
    await receive();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(0);
    await assertOpen();
    expect(confirmation()).toContain("You're no longer in Launch");
  });

  test('membership guard is first, including for an already-ruled card', async () => {
    Pod.findById.mockImplementation(() => chain({ name: 'Launch', members: [] }));
    await receive();
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    await assertOpen();
    expect(confirmation()).toContain("You're no longer in Launch");
    await Decision.updateOne({ _id: decision._id }, { $set: { status: 'ruled', ruling: { value: 'secret', byUsername: 'someone' } } });
    await receive();
    expect(messages).toHaveLength(0);
    expect(confirmation()).not.toContain('secret');
  });

  test('409-ruled: loser text goes under ask, not winner; standing ruling and ledger stay unchanged', async () => {
    await receive();
    const original = await ledger();
    await receive('1');
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ podId, replyTo: '700', thread_root_id: '700' });
    expect(messages[1].content).toContain('1');
    expect(choose).toHaveBeenCalledTimes(1);
    expect((await Decision.findById(decision._id)).ruling.value).toBe('Now');
    expect(await ledger()).toEqual(original);
    expect(confirmation()).toContain('Already ruled');
  });

  test.each([
    [undefined, ''],
    [null, ''],
    [-1, ' just now'],
    [0, ' just now'],
    [59, ' just now'],
    [60, ' 1m ago'],
    [3599, ' 59m ago'],
    [3600, ' 1h ago'],
    [86399, ' 23h ago'],
    [86400, ' 1d ago'],
    [172800, ' 2d ago'],
  ])('standing ruling age %s seconds renders "%s" without changing settlement', async (ageSeconds, relative) => {
    const now = Date.now();
    jest.spyOn(Date, 'now').mockReturnValue(now);
    const at = ageSeconds == null ? ageSeconds : new Date(now - ageSeconds * 1000);
    await Decision.updateOne({ _id: decision._id }, {
      $set: { status: 'ruled', ruling: { value: 'Later', byUsername: 'sam', ...(at === undefined ? {} : { at }) } },
    });
    const original = (await Decision.findById(decision._id).lean()).ruling;
    const originalLedger = await ledger();
    await receive('1');
    const link = `https://commonly.me/v2/pods/${podId}?message=700`;
    expect(confirmation()).toBe(`Already ruled${relative} by sam: Later.`
      + ` To change it, the agent asks again — say so in the workspace: ${link}`);
    expect(choose).not.toHaveBeenCalled();
    expect((await Decision.findById(decision._id).lean()).ruling).toEqual(original);
    expect(await ledger()).toEqual(originalLedger);
    expect((await receipts())[0].closedAt).toEqual(expect.any(Date));
    expect(messages).toEqual([expect.objectContaining({ podId, replyTo: '700', thread_root_id: '700' })]);
  });

  test('409-lock: no write; after injected clock expires the lease, same reply rules', async () => {
    const now = Date.now();
    await Decision.updateOne({ _id: decision._id }, { $set: { rulingLock: { token: 'other-tab', expiresAt: new Date(now + 120000) } } });
    await receive();
    await assertOpen();
    expect(messages).toHaveLength(0);
    expect(confirmation()).toContain('Someone is ruling');
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    jest.setSystemTime(now + 120001);
    try { await receive(); } finally { jest.useRealTimers(); }
    expect(messages).toHaveLength(1);
    expect((await receipts())[0].closedAt).toEqual(expect.any(Date));
  });

  test('409-ruled returned by the verb after our pending read takes the late threaded path', async () => {
    const realChoose = choose.getMockImplementation();
    choose.mockImplementationOnce(async (args) => {
      await realChoose({ ...args, value: 'winner' });
      return realChoose(args);
    });
    await receive('1');
    expect(messages).toHaveLength(2);
    expect(messages[0].content).toBe('winner');
    expect(messages[1].replyTo).toBe('700');
    expect(messages[1].content).toContain('1');
    expect((await receipts())[0].closedAt).toEqual(expect.any(Date));
    expect((await ledger())[0].reachedHumanAt).toBeUndefined();
    expect((await ledger())[0].ruledVia).toBeUndefined();
    expect(confirmation()).toContain('Already ruled');
  });

  test('503: no message and released lock, retry gives exactly one ruling', async () => {
    PGMessage.create.mockRejectedValueOnce(new Error('PG unavailable'));
    await receive();
    await assertOpen();
    expect(messages).toHaveLength(0);
    expect((await Decision.findById(decision._id)).rulingLock?.token).toBeUndefined();
    expect(confirmation()).toContain('nothing was saved');
    await receive();
    expect(messages).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  test('thrown finalize conflict: exactly one reply/wake, no close or ledger stamp', async () => {
    const update = Decision.findOneAndUpdate.bind(Decision);
    jest.spyOn(Decision, 'findOneAndUpdate').mockImplementation((filter, change, options) => (
      change.$set?.status === 'ruled' ? Promise.resolve(null) : update(filter, change, options)
    ));
    await receive();
    await assertOpen();
    expect(messages).toHaveLength(1);
    expect(messages[0].replyTo).toBe('700');
    expect(deliverMessageToAgents).toHaveBeenCalledTimes(1);
    expect(enqueue).not.toHaveBeenCalled();
    expect(confirmation()).toContain("reached the workspace, but the card didn't close");
  });

  test('confirmation send failure cannot retry the verb or roll back settlement', async () => {
    if (provider === 'telegram') telegramSend.sendMessage.mockRejectedValueOnce(new Error('transport failed'));
    else slackSend.mockRejectedValueOnce(new Error('transport failed'));
    await receive();
    expect(choose).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect((await Decision.findById(decision._id)).status).toBe('ruled');
    expect((await receipts())[0].closedAt).toEqual(expect.any(Date));
    expect((await ledger())[0].ruledVia).toBe(provider);
    expect(provider === 'telegram' ? telegramSend.sendMessage : slackSend).toHaveBeenCalledTimes(1);
  });

  test('reply to confirmation or another chat card is ordinary, never a bare-number ruling', async () => {
    await receive('2', '999');
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ podId: otherPodId, replyTo: null, thread_root_id: null });
    await assertOpen();
  });

  test('current linked owner, not an identity cached at send time, rules', async () => {
    await Integration.updateOne({ _id: binding._id }, { $set: { 'config.linkedUserId': newOwnerId } });
    await receive();
    expect(choose.mock.calls[0][0].callerUserId).toBe(newOwnerId);
    expect(messages[0].userId).toBe(newOwnerId);
  });

  test('one fork on two bindings keeps only the winner reached and routes a marked sibling as late', async () => {
    const sibling = await Integration.create({
      podId: otherPodId, scope: 'user', type: provider, createdBy: newOwnerId, isActive: true, status: 'connected',
      config: { ...binding.toObject({ flattenMaps: true }).config, linkedUserId: newOwnerId, chatId: 'second-chat', cards: [] },
    });
    await send(await Integration.findById(sibling._id).lean(), decision.toObject());
    await receive('2');
    // PR 3's fan-out may mark this receipt before the losing webhook arrives.
    await Integration.updateOne({ _id: sibling._id }, { $set: { 'config.cards.0.closedAt': new Date() } });
    await receive('1', externalId, {}, sibling._id);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({ replyTo: '700', userId: newOwnerId, podId });
    const rows = await Verdict.find({ 'event.podMessageId': '700' }).lean();
    expect(rows).toHaveLength(2);
    expect(rows.filter((r) => r.reachedHumanAt)).toHaveLength(1);
    expect(rows.every((r) => r.ruledVia === provider)).toBe(true);
    expect(confirmation()).toContain('Already ruled');
  });

  test('long prose without quote is ordinary chat even with one pending card', async () => {
    await receive('ship this tomorrow', null);
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(1);
    expect(messages[0].replyTo).toBeNull();
    await assertOpen();
  });

  test('card replies do not depend on an active pod; unmatched chat still needs one (64265)', async () => {
    await Integration.updateOne({ _id: binding._id }, { $unset: { podId: 1 } });
    await receive('hello', null);
    expect(messages).toHaveLength(0);
    expect(confirmation()).toContain('no active pod');
    await receive('2');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ podId, replyTo: '700' });
    expect(confirmation()).toBe('✓ Ruled: Now');
  });

  test('leaving active pod blocks ordinary chat but not a card in another member pod (64265)', async () => {
    Pod.findById.mockImplementation((id) => chain({ name: 'Launch', members: String(id) === podId ? [ownerId] : [] }));
    await receive('hello', null);
    expect(messages).toHaveLength(0);
    await receive('2');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ podId, replyTo: '700' });
  });

  test('missing or explicitly closed pending receipt never falls through or closes the decision', async () => {
    await Integration.updateOne({ _id: binding._id }, { $set: { 'config.cards.0.closedAt': new Date() } });
    await receive();
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    expect((await Decision.findById(decision._id)).status).toBe('pending');
    await Decision.deleteOne({ _id: decision._id });
    await receive();
    expect(messages).toHaveLength(0);
    expect(confirmation()).toContain('no longer available');
  });

  test('bare number ignores ghost entries whose row has already ruled', async () => {
    await Decision.create({ ...decision.toObject(), _id: new mongoose.Types.ObjectId(), messageId: '701', status: 'ruled' });
    await Integration.updateOne({ _id: binding._id }, { $push: { 'config.cards': { podMessageId: '701', externalMessageId: '43', sentAt: new Date() } } });
    await receive('2', null);
    expect(choose).toHaveBeenCalledTimes(1);
    expect(messages).toHaveLength(1);
    expect(messages[0].replyTo).toBe('700');
  });

  test('two pending cards disambiguate; zero pending cards use ordinary chat', async () => {
    await Decision.create({ ...decision.toObject(), _id: new mongoose.Types.ObjectId(), messageId: '701' });
    await Integration.updateOne({ _id: binding._id }, { $push: { 'config.cards': { podMessageId: '701', externalMessageId: '43', sentAt: new Date() } } });
    await receive('2', null);
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    expect(confirmation()).toBe('Which one? Reply to the card you mean.');
    await Decision.updateMany({}, { $set: { status: 'ruled' } });
    await receive('2', null);
    expect(messages).toHaveLength(1);
    expect(messages[0].replyTo).toBeNull();
  });

  test('150 ordinary relays cannot evict the card or duplicate its ledger', async () => {
    const integration = await Integration.findById(binding._id).lean();
    for (let i = 0; i < 150; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await (provider === 'telegram' ? telegram.relayAgentMessageToTelegram : slack.relayAgentMessageToSlack)({
        integration, podId, agentUsername: 'kai', displayName: 'Kai', content: '[DECISION] chat', podMessageId: String(1000 + i),
      });
    }
    const saved = await Integration.findById(binding._id).lean();
    expect(saved.config.relayMap).toHaveLength(100);
    expect(saved.config.relayMap.some((entry) => entry.podMessageId === '700')).toBe(false);
    expect(saved.config.cards).toHaveLength(1);
    expect(await ledger()).toHaveLength(1);
    await receive();
    expect(messages).toHaveLength(1);
    expect(messages[0].replyTo).toBe('700');
  });

  test('concurrent replies enter the real CAS together and only one settles', async () => {
    let release;
    let entered;
    const inWrite = new Promise((resolve) => { entered = resolve; });
    const continueWrite = new Promise((resolve) => { release = resolve; });
    const create = PGMessage.create.getMockImplementation();
    PGMessage.create.mockImplementationOnce(async (...args) => { entered(); await continueWrite; return create(...args); });
    const first = receive('2');
    await inWrite;
    try {
      await receive('1');
      expect(confirmation()).toContain('Someone is ruling');
      expect(messages).toHaveLength(0);
    } finally { release(); await first; }
    expect(choose).toHaveBeenCalledTimes(2);
    expect(messages).toHaveLength(1);
    expect(enqueue).toHaveBeenCalledTimes(1);
    expect((await Decision.findById(decision._id)).ruling.value).toBe('Now');
  });

  test('provider identity guard refuses before decision lookup', async () => {
    const lookup = jest.spyOn(Decision, 'findOne');
    if (provider === 'telegram') await Integration.updateOne({ _id: binding._id }, { $set: { 'config.chatType': 'group' } });
    await receive('2', externalId, provider === 'slack' ? { user: 'other-user' } : {});
    expect(lookup).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    await assertOpen();
  });

  test('admin-pause remains ahead of card lookup', async () => {
    const lookup = jest.spyOn(Decision, 'findOne');
    await Integration.updateOne({ _id: binding._id }, { $set: { 'config.adminPause': { reason: 'paused', at: new Date(), adminId: ownerId } } });
    await receive();
    expect(lookup).not.toHaveBeenCalled();
    expect(choose).not.toHaveBeenCalled();
    expect(messages).toHaveLength(0);
    await assertOpen();
  });

  if (provider === 'telegram') {
    test('a group update is refused even if the stored binding claims private', async () => {
      const lookup = jest.spyOn(Decision, 'findOne');
      await receive('2', externalId, { chat: { type: 'group' } });
      expect(lookup).not.toHaveBeenCalled();
      expect(choose).not.toHaveBeenCalled();
      expect(messages).toHaveLength(0);
      await assertOpen();
    });
  }
});
