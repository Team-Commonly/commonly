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
const { TELEGRAM_CONNECTOR } = require('../../../scripts/seed-builtin-connectors');
const {
  setupMongoDb,
  closeMongoDb,
  clearMongoDb,
} = require('../../utils/testUtils');

const freshId = () => new mongoose.Types.ObjectId().toString();

describe('installable event dispatcher', () => {
  let originalTelegramHandler;

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
    originalTelegramHandler = eventHandlers['telegram.relay'];
  });

  afterEach(() => {
    eventHandlers['telegram.relay'] = originalTelegramHandler;
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
