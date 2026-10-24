// Real AgentInstallation queries: paused/uninstalled rows must not receive new events.
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  find: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  find: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../../services/chatSummarizerService', () => ({
  constructor: {
    getLatestPodSummary: jest.fn(),
  },
  summarizePodMessages: jest.fn(),
}));

jest.mock('../../../models/AgentEvent', () => ({
  countDocuments: jest.fn(),
}));

jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(),
  // ADR-018 D6.4 reads the previous top-level message on an unrouted human
  // message; null means no adjacency, so D8 is what these arms exercise.
  findPreviousTopLevel: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../../services/welcomeWakeService', () => ({
  maybeFireWelcomeWake: jest.fn(),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const messageDeliveryModeService = require('../../../services/messageDeliveryModeService');


const mongoose = require('mongoose');
const { setupMongoDb, closeMongoDb, clearMongoDb } = require('../../utils/testUtils');

describe('message producer installation status (real Mongo)', () => {
  const podId = new mongoose.Types.ObjectId().toString();
  const userId = new mongoose.Types.ObjectId().toString();
  const send = (content = 'ambient update') => AgentMentionService.enqueueMentions({
    podId, userId, username: 'alice', message: { content, id: 'status-message' },
  });
  const insert = (status) => AgentInstallation.collection.insertOne({
    agentName: 'scout', instanceId: 'default', podId: new mongoose.Types.ObjectId(podId),
    status, installedBy: new mongoose.Types.ObjectId(userId),
    config: { wakeOnMessage: { enabled: false } },
  });

  beforeAll(setupMongoDb);
  afterAll(closeMongoDb);
  beforeEach(() => {
    jest.clearAllMocks();
    User.findById.mockReturnValue({ select: () => ({ lean: async () => ({ _id: userId, isBot: false }) }) });
    AgentProfile.find.mockReturnValue({ lean: async () => [] });
    Pod.findById.mockReturnValue({
      select: () => ({ lean: async () => ({ type: 'chat' }) }),
      lean: async () => ({ type: 'agent-room', members: [userId, 'bot-user'] }),
    });
    Pod.find.mockReturnValue({ select: () => ({ lean: async () => [] }) });
    User.find.mockReturnValue({ select: () => ({ lean: async () => [{
      _id: 'bot-user', username: 'scout', botMetadata: { agentName: 'scout', instanceId: 'default' },
    }] }) });
    AgentEvent.countDocuments.mockResolvedValue(0);
  });
  afterEach(clearMongoDb);

  test.each(['paused', 'uninstalled', 'error', 'stale'])('%s installations receive neither pod digest nor DM event', async (status) => {
    await insert(status);
    await send();
    await AgentMentionService.enqueueDmEvent({
      podId, userId, username: 'alice', message: { content: 'direct update', id: 'dm-status-message' },
    });
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('active installation gets a digest, then pause/uninstall prevents subsequent receipt', async () => {
    const row = await insert('active');
    await send();
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ deliveryMode: 'digest' }));
    AgentEventService.enqueue.mockClear();
    await AgentInstallation.collection.updateOne({ _id: row.insertedId }, { $set: { status: 'paused' } });
    await send();
    await AgentInstallation.collection.updateOne({ _id: row.insertedId }, { $set: { status: 'uninstalled' } });
    await send();
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('an active installation remains available to DM auto-routing', async () => {
    await insert('active');
    await AgentMentionService.enqueueDmEvent({
      podId, userId, username: 'alice', message: { content: 'direct update', id: 'dm-status-message' },
    });
    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({ type: 'chat.mention' }));
  });
});
