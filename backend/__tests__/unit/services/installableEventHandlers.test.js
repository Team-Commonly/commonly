// @ts-nocheck

// This suite does not exercise JWTs; keep testUtils loadable on Node 26.
jest.mock('jsonwebtoken', () => ({}));

const mongoose = require('mongoose');

const Installable = require('../../../models/Installable');
const InstallableInstallation = require('../../../models/InstallableInstallation');
const Integration = require('../../../models/Integration');
const Pod = require('../../../models/Pod');
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

const createPod = async (podId, ownerId, memberIds = []) => Pod.create({
  _id: podId,
  name: `Pod ${podId.slice(-4)}`,
  type: 'team',
  createdBy: ownerId,
  members: memberIds,
});

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
    const ownerA = freshId();
    const ownerB = freshId();
    await createPod(podA, ownerA);
    await createPod(podB, ownerB);
    await install({ installableId: 'telegram', installedBy: ownerA, podId: podA });
    await install({ installableId: 'telegram', installedBy: ownerB, podId: podB });
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
    const firstOwner = freshId();
    const secondOwner = freshId();
    await createPod(podId, firstOwner, [secondOwner]);
    const first = await install({ installableId: 'telegram', installedBy: firstOwner, podId });
    const second = await install({ installableId: 'telegram', installedBy: secondOwner, podId });
    await Integration.updateOne(
      { _id: first.integration._id },
      { $set: { 'config.chatId': 'chat-a', 'config.chatType': 'private' } },
    );
    await Integration.updateOne(
      { _id: second.integration._id },
      {
        $set: { 'config.chatId': 'chat-b', 'config.chatType': 'private' },
        // User scope is allowed to omit its active inbound pod. Outbound must
        // still fan out from the event pod through an enabled gate.
        $unset: { podId: 1 },
      },
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

  it('selects a user connector only for an enabled gate whose owner remains a member', async () => {
    const ownerId = freshId();
    const otherOwnerId = freshId();
    const firstPodId = freshId();
    const secondPodId = freshId();
    await createPod(firstPodId, ownerId);
    await createPod(secondPodId, otherOwnerId, [ownerId]);
    const installed = await install({ installableId: 'telegram', installedBy: ownerId, podId: firstPodId });
    const relay = jest.fn().mockResolvedValue(undefined);
    eventHandlers['telegram.relay'] = relay;

    // Membership alone is deliberately not a subscription: a user joining a
    // pod must opt into that pod's gate before anything reaches their DM.
    await dispatch('chat.message', {
      podId: secondPodId, agentUsername: 'kai', displayName: 'Kai', content: '[ESCALATE] no gate',
    });
    expect(relay).not.toHaveBeenCalled();

    await Integration.updateOne(
      { _id: installed.integration._id },
      { $set: { [`config.gates.${secondPodId}`]: { enabled: false, since: new Date() } } },
    );

    await dispatch('chat.message', {
      podId: firstPodId, agentUsername: 'kai', displayName: 'Kai', content: '[ESCALATE] first',
    });
    await dispatch('chat.message', {
      podId: secondPodId, agentUsername: 'kai', displayName: 'Kai', content: '[ESCALATE] disabled',
    });
    expect(relay).toHaveBeenCalledTimes(1);

    await Integration.updateOne(
      { _id: installed.integration._id },
      { $set: { [`config.gates.${secondPodId}.enabled`]: true } },
    );
    await dispatch('chat.message', {
      podId: secondPodId, agentUsername: 'kai', displayName: 'Kai', content: '[ESCALATE] enabled',
    });
    expect(relay).toHaveBeenCalledTimes(2);

    await Pod.updateOne({ _id: secondPodId }, { $pull: { members: ownerId } });
    await dispatch('chat.message', {
      podId: secondPodId, agentUsername: 'kai', displayName: 'Kai', content: '[ESCALATE] removed',
    });
    expect(relay).toHaveBeenCalledTimes(2);
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
    const ownerId = freshId();
    await createPod(podId, ownerId);
    await Integration.create({
      podId,
      type: 'telegram',
      status: 'pending',
      createdBy: ownerId,
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
    const ownerId = freshId();
    await createPod(podId, ownerId);
    await install({ installableId: 'telegram', installedBy: ownerId, podId });
    await install({ installableId: 'slack', installedBy: ownerId, podId });
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

  it('does not dispatch an error-gated Slack row while keeping its projection active for recovery', async () => {
    const podId = freshId();
    const ownerId = freshId();
    await createPod(podId, ownerId);
    const installed = await install({ installableId: 'slack', installedBy: ownerId, podId });
    await Integration.updateOne(
      { _id: installed.integration._id },
      { $set: { status: 'error', isActive: true } },
    );
    const slackRelay = jest.fn().mockResolvedValue(undefined);
    eventHandlers['slack.relay'] = slackRelay;

    await dispatch('chat.message', {
      podId,
      agentUsername: 'kai',
      displayName: 'Kai',
      content: 'Do not send through an unavailable connector',
      podMessageId: 'message-error-gated',
    });

    expect(slackRelay).not.toHaveBeenCalled();
  });

  it('keeps fanning out when one member connector fails', async () => {
    const podId = freshId();
    const firstOwner = freshId();
    const secondOwner = freshId();
    const thirdOwner = freshId();
    await createPod(podId, firstOwner, [secondOwner, thirdOwner]);
    const [first, second, third] = await Promise.all([
      install({ installableId: 'telegram', installedBy: firstOwner, podId }),
      install({ installableId: 'telegram', installedBy: secondOwner, podId }),
      install({ installableId: 'telegram', installedBy: thirdOwner, podId }),
    ]);
    await Promise.all([
      Integration.updateOne({ _id: first.integration._id }, { $set: { 'config.chatId': 'chat-a', 'config.chatType': 'private' } }),
      Integration.updateOne({ _id: second.integration._id }, { $set: { 'config.chatId': 'chat-b', 'config.chatType': 'private' } }),
      Integration.updateOne({ _id: third.integration._id }, { $set: { 'config.chatId': 'chat-c', 'config.chatType': 'private' } }),
    ]);
    const previousToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'test-bot-token';
    const sendMessage = jest.spyOn(telegramSend, 'sendMessage')
      .mockResolvedValueOnce({ messageId: 1 })
      .mockRejectedValueOnce(new Error('provider throttled'))
      .mockResolvedValueOnce({ messageId: 3 });

    try {
      await dispatch('chat.message', {
        podId, agentUsername: 'kai', displayName: 'Kai', content: 'fan out despite one failure',
      });

      expect(sendMessage).toHaveBeenCalledTimes(3);
      expect(new Set(sendMessage.mock.calls.map((call) => call[1]))).toEqual(
        new Set(['chat-a', 'chat-b', 'chat-c']),
      );
      const rows = await Integration.find({ _id: { $in: [first.integration._id, second.integration._id, third.integration._id] } });
      expect(rows.every((row) => row.status !== 'error')).toBe(true);
    } finally {
      sendMessage.mockRestore();
      if (previousToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    }
  });

  it('contains an individual handler failure', async () => {
    const podId = freshId();
    const ownerId = freshId();
    await createPod(podId, ownerId);
    await install({ installableId: 'telegram', installedBy: ownerId, podId });
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
