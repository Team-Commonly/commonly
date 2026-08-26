// Which side of the pod write a failure lands on decides whether Telegram's
// redelivery is a repair or a duplicate. These pin that split.
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
const PGPod = require('../../../models/pg/Pod');
const { deliverMessageToAgents } = require('../../../services/messageAgentDeliveryService');
const { relayTelegramMessageToPod } = require('../../../services/telegramBridgeService');

const integration = {
  _id: 'i1',
  podId: 'pod-1',
  config: { chatId: '42', liveRelay: true, linkedUserId: 'user-1' },
};
const telegramMessage = { text: 'ship it', message_id: 555, from: { first_name: 'Sam' } };

describe('relayTelegramMessageToPod — failures either side of the pod write', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ username: 'sam', profilePicture: null }) }) });
    Pod.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ type: 'chat' }) }) });
    PGPod.findById.mockResolvedValue({ id: 'pod-1' });
    PGMessage.create.mockResolvedValue({ id: 'm1', content: 'x' });
    PGMessage.findById.mockResolvedValue({ id: 'm1', content: 'x' });
    deliverMessageToAgents.mockResolvedValue(undefined);
  });

  it('relays and reports it', async () => {
    await expect(relayTelegramMessageToPod({ integration, telegramMessage }))
      .resolves.toEqual(expect.objectContaining({ relayed: true }));
    expect(PGMessage.create).toHaveBeenCalledTimes(1);
    expect(deliverMessageToAgents).toHaveBeenCalledTimes(1);
  });

  // Nothing was persisted, so the webhook must NOT ack — Telegram's redelivery
  // is the only thing that saves the update, and there is no row to duplicate.
  it('propagates a failure BEFORE the write, so the retry can repair it', async () => {
    PGMessage.create.mockRejectedValue(new Error('pg down'));
    await expect(relayTelegramMessageToPod({ integration, telegramMessage }))
      .rejects.toThrow('pg down');
    expect(deliverMessageToAgents).not.toHaveBeenCalled();
  });

  // The row exists. A redelivery here would re-run create and duplicate both
  // the message and every wake, because nothing dedupes on message_id.
  it('swallows a failure AFTER the write, so the retry cannot duplicate it', async () => {
    deliverMessageToAgents.mockRejectedValue(new Error('wake blew up'));
    await expect(relayTelegramMessageToPod({ integration, telegramMessage }))
      .resolves.toEqual(expect.objectContaining({ relayed: true }));
    expect(PGMessage.create).toHaveBeenCalledTimes(1);
  });
});
