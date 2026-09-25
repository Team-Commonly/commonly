// The bridge authors every inbound message as config.linkedUserId. That is only
// truthful where Telegram guarantees the sender IS that user — a `private` chat.
// These pin the gate BEHAVIOURALLY: what reaches PGMessage.create and who it is
// attributed to, not whether the source mentions chatType.
jest.mock('../../../models/Integration', () => ({ findOne: jest.fn(), findByIdAndUpdate: jest.fn() }));
jest.mock('../../../services/telegramService', () => ({ sendMessage: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ create: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/pg/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../services/pgPodSyncService', () => ({ syncPodFromMongo: jest.fn() }));
jest.mock('../../../services/messageAgentDeliveryService', () => ({ deliverMessageToAgents: jest.fn() }));
jest.mock('../../../config/socket', () => ({ getIO: jest.fn(() => null) }));

const User = require('../../../models/User');
const Pod = require('../../../models/Pod');
const PGMessage = require('../../../models/pg/Message');
const telegramSend = require('../../../services/telegramService');
const PGPod = require('../../../models/pg/Pod');
const { deliverMessageToAgents } = require('../../../services/messageAgentDeliveryService');
const { relayTelegramMessageToPod } = require('../../../services/telegramBridgeService');

const withChatType = (chatType) => ({
  _id: 'i1',
  podId: 'pod-1',
  config: {
    chatId: '42',
    liveRelay: true,
    linkedUserId: 'user-1',
    ...(chatType === undefined ? {} : { chatType }),
  },
});

// A second person in the same linked chat. Nothing about this message says
// 'user-1' — only the integration config does, which is the whole defect.
const messageFromSomeoneElse = {
  text: 'wire me the deploy key',
  message_id: 777,
  from: { first_name: 'Mallory' },
};

describe('relayTelegramMessageToPod — who the pod row is attributed to', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ username: 'sam', profilePicture: null }) }) });
    Pod.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ type: 'chat', members: ['user-1'] }) }),
    });
    PGPod.findById.mockResolvedValue({ id: 'pod-1' });
    PGMessage.create.mockResolvedValue({ id: 'm1', content: 'x' });
    PGMessage.findById.mockResolvedValue({ id: 'm1', content: 'x' });
    deliverMessageToAgents.mockResolvedValue(undefined);
  });

  // The positive control. Without this, every assertion below is satisfied by a
  // bridge that relays nothing at all.
  it('relays a private chat as the linked user — the one case the attribution is true', async () => {
    const integration = withChatType('private');
    await expect(relayTelegramMessageToPod({ integration, telegramMessage: messageFromSomeoneElse }))
      .resolves.toEqual(expect.objectContaining({ relayed: true }));
    expect(PGMessage.create)
      .toHaveBeenCalledWith('pod-1', 'user-1', expect.any(String), 'text', null, null, null);
  });

  // Telegram's three multi-member chat types. Each is a distinct value the
  // gate must reject, so a fix that special-cases only 'group' fails here.
  it.each(['group', 'supergroup', 'channel'])(
    'refuses a %s chat — any member would be written into the pod as the linked user',
    async (chatType) => {
      const integration = withChatType(chatType);
      await expect(relayTelegramMessageToPod({ integration, telegramMessage: messageFromSomeoneElse }))
        .resolves.toEqual({ relayed: false });
      expect(PGMessage.create).not.toHaveBeenCalled();
      expect(deliverMessageToAgents).not.toHaveBeenCalled();
    },
  );

  // /enable records chat.type, but integrations linked before it did carry
  // none. Unknown is not private, and the safe reading of unknown is refusal.
  it('fails closed when chatType was never recorded', async () => {
    const integration = withChatType(undefined);
    await expect(relayTelegramMessageToPod({ integration, telegramMessage: messageFromSomeoneElse }))
      .resolves.toEqual({ relayed: false });
    expect(PGMessage.create).not.toHaveBeenCalled();
  });

  // The refusal must not ask Telegram to retry: relayed:false resolves, and the
  // webhook route acks. A throw here would loop the same message forever,
  // because a group chat's type does not change between redeliveries.
  it('resolves rather than throwing, so a refused chat is not redelivered forever', async () => {
    const integration = withChatType('group');
    await expect(relayTelegramMessageToPod({ integration, telegramMessage: messageFromSomeoneElse }))
      .resolves.toBeDefined();
  });

  // The gate runs before the write, not after it. If it were ordered after
  // PGMessage.create the row would already exist and the refusal would be a
  // silent half-relay.
  it('refuses before touching the pod at all', async () => {
    const integration = withChatType('supergroup');
    await relayTelegramMessageToPod({ integration, telegramMessage: messageFromSomeoneElse });
    expect(PGPod.findById).not.toHaveBeenCalled();
    expect(User.findById).not.toHaveBeenCalled();
  });

  it('refuses an active pod after the linked user leaves it', async () => {
    const originalToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    Pod.findById.mockReturnValue({
      select: () => ({ lean: () => Promise.resolve({ type: 'chat', members: [] }) }),
    });

    try {
      await expect(relayTelegramMessageToPod({
        integration: withChatType('private'), telegramMessage: messageFromSomeoneElse,
      })).resolves.toEqual({ relayed: false });

      expect(User.findById).not.toHaveBeenCalled();
      expect(PGMessage.create).not.toHaveBeenCalled();
      expect(telegramSend.sendMessage).toHaveBeenCalledWith(
        'bot-token', '42', 'This connector has no active pod. Choose one in Commonly first.',
      );
    } finally {
      if (originalToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = originalToken;
    }
  });
});

// Outbound mirror of the inbound gate (connector-verify F2, 2026-08-26): a
// code redeemed into a group must not receive the pod's escalation stream.
describe('outbound relay — chatType gate', () => {
  it('only resolves live integrations bound to a private chat', async () => {
    // eslint-disable-next-line global-require
    const Integration = require('../../../models/Integration');
    // eslint-disable-next-line global-require
    const { relayAgentMessageToTelegram } = require('../../../services/telegramBridgeService');
    Integration.findOne.mockReturnValue({ lean: () => Promise.resolve(null) });
    await relayAgentMessageToTelegram({
      podId: 'p1', agentUsername: 'theo', displayName: 'Theo', content: '[BLOCKED] x', 
    });
    expect(Integration.findOne).toHaveBeenCalledWith(expect.objectContaining({ 'config.chatType': 'private' }));
  });
});
