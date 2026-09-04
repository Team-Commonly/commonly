// @ts-nocheck

const mongoose = require('mongoose');

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const {
  install,
} = require('../../../services/installable/installableInstallationService');
const {
  dispatch,
  eventHandlers,
} = require('../../../services/installable/eventHandlers');
const telegramSend = require('../../../services/telegramService');
const { TELEGRAM_CONNECTOR, SLACK_CONNECTOR } = require('../../../scripts/seed-builtin-connectors');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const freshId = () => new mongoose.Types.ObjectId().toString();

describe('installable event dispatcher', () => {
  let originalTelegramHandler;
  let originalSlackHandler;

  beforeAll(async () => {
    await setupMongoDb();
    await InstallableInstallation.syncIndexes();
  });

  afterAll(async () => {
    await closeMongoDb();
  });

  beforeEach(async () => {
    await clearMongoDb();
    await Installable.create({
      ...TELEGRAM_CONNECTOR,
      stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
    });
    await Installable.create({
      ...SLACK_CONNECTOR,
      stats: { totalInstalls: 0, activeInstalls: 0, forkCount: 0 },
    });
    originalTelegramHandler = eventHandlers['telegram.relay'];
    originalSlackHandler = eventHandlers['slack.relay'];
  });

  afterEach(() => {
    eventHandlers['telegram.relay'] = originalTelegramHandler;
    eventHandlers['slack.relay'] = originalSlackHandler;
  });

  it('selects only the event pod connector before invoking its handler', async () => {
    const podA = freshId();
    const podB = freshId();
    await install({ installableId: 'telegram', installedBy: freshId(), podId: podA });
    await install({ installableId: 'telegram', installedBy: freshId(), podId: podB });
    const relay = jest.fn().mockResolvedValue(undefined);
    eventHandlers['telegram.relay'] = relay;

    await dispatch('chat.message', {
      podId: podA,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: '[ESCALATE] needs review',
      podMessageId: 'message-a',
    });

    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay).toHaveBeenCalledWith(expect.objectContaining({
      podId: podA,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: '[ESCALATE] needs review',
      podMessageId: 'message-a',
      integration: expect.objectContaining({ podId: expect.anything() }),
    }));
    expect(String(relay.mock.calls[0][0].integration.podId)).toBe(podA);
  });

  it('relays each same-pod connector to its own selected Telegram chat', async () => {
    const podId = freshId();
    const first = await install({ installableId: 'telegram', installedBy: freshId(), podId });
    const second = await install({ installableId: 'telegram', installedBy: freshId(), podId });
    await Integration.updateOne(
      { _id: first.integration._id },
      { $set: { 'config.chatId': 'chat-a', 'config.chatType': 'private' } },
    );
    await Integration.updateOne(
      { _id: second.integration._id },
      { $set: { 'config.chatId': 'chat-b', 'config.chatType': 'private' } },
    );
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    const sendMessage = jest.spyOn(telegramSend, 'sendMessage')
      .mockResolvedValueOnce({ messageId: 1 })
      .mockResolvedValueOnce({ messageId: 2 });

    try {
      await dispatch('chat.message', {
        podId,
        agentUsername: 'kai',
        displayName: 'Kai',
        content: 'Both subscriptions should receive this',
        podMessageId: 'message-fanout',
      });

      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(new Set(sendMessage.mock.calls.map((call) => call[1]))).toEqual(
        new Set(['chat-a', 'chat-b']),
      );
    } finally {
      sendMessage.mockRestore();
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it('does not invoke a handler when the event pod has no installation', async () => {
    const relay = jest.fn().mockResolvedValue(undefined);
    eventHandlers['telegram.relay'] = relay;

    await dispatch('chat.message', {
      podId: freshId(),
      agentUsername: 'kai',
      displayName: 'Kai',
      content: 'No connector',
      podMessageId: 'message-none',
    });

    expect(relay).not.toHaveBeenCalled();
  });

  it('continues to dispatch an existing direct Telegram integration', async () => {
    const podId = freshId();
    await Integration.create({
      podId,
      type: 'telegram',
      status: 'pending',
      createdBy: freshId(),
      isActive: true,
      config: { liveRelay: true, chatId: 'chat-1', chatType: 'private' },
    });
    const relay = jest.fn().mockResolvedValue(undefined);
    eventHandlers['telegram.relay'] = relay;

    await dispatch('chat.message', {
      podId,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: 'Legacy connector still works',
      podMessageId: 'message-legacy',
    });

    expect(relay).toHaveBeenCalledTimes(1);
    expect(relay.mock.calls[0][0].podId).toBe(podId);
  });

  it('selects installed Slack and Telegram rows independently for one pod', async () => {
    const podId = freshId();
    await install({ installableId: 'telegram', installedBy: freshId(), podId });
    await install({ installableId: 'slack', installedBy: freshId(), podId });
    const telegramRelay = jest.fn().mockResolvedValue(undefined);
    const slackRelay = jest.fn().mockResolvedValue(undefined);
    eventHandlers['telegram.relay'] = telegramRelay;
    eventHandlers['slack.relay'] = slackRelay;

    await dispatch('chat.message', {
      podId,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: 'One message, two subscriptions',
      podMessageId: 'message-mixed',
    });

    expect(telegramRelay).toHaveBeenCalledTimes(1);
    expect(slackRelay).toHaveBeenCalledTimes(1);
    expect(String(slackRelay.mock.calls[0][0].integration.podId)).toBe(podId);
  });

  it('contains an individual handler failure', async () => {
    const podId = freshId();
    await install({ installableId: 'telegram', installedBy: freshId(), podId });
    eventHandlers['telegram.relay'] = jest.fn().mockRejectedValue(new Error('provider unavailable'));

    await expect(dispatch('chat.message', {
      podId,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: 'Will not fail the post',
      podMessageId: 'message-fail',
    })).resolves.toBeUndefined();
  });
});
