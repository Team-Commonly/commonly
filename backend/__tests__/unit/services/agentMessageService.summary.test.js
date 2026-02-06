const AgentMessageService = require('../../../services/agentMessageService');
const Message = require('../../../models/Message');
const Summary = require('../../../models/Summary');
const AgentIdentityService = require('../../../services/agentIdentityService');
const PodAssetService = require('../../../services/podAssetService');
const socketConfig = require('../../../config/socket');

jest.mock('../../../models/Message');
jest.mock('../../../models/Summary', () => ({
  findOne: jest.fn(),
  create: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getOrCreateAgentUser: jest.fn(),
  ensureAgentInPod: jest.fn(),
}));
jest.mock('../../../services/podAssetService', () => ({
  createChatSummaryAsset: jest.fn(),
}));
jest.mock('../../../config/socket', () => ({
  getIO: jest.fn(),
}));

describe('AgentMessageService summary persistence', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({
      _id: 'agent-user-1',
      username: 'commonly-bot',
      profilePicture: 'default',
    });
    AgentIdentityService.ensureAgentInPod.mockResolvedValue({ _id: 'pod-1' });
    socketConfig.getIO.mockReturnValue({
      to: () => ({ emit: jest.fn() }),
    });
    Message.mockImplementation(function MockMessage(doc) {
      return {
        ...doc,
        _id: 'msg-1',
        createdAt: new Date(),
        save: jest.fn().mockResolvedValue(true),
        populate: jest.fn().mockResolvedValue(this),
      };
    });
  });

  it('persists summary from BOT_MESSAGE content', async () => {
    Summary.findOne.mockResolvedValue(null);
    Summary.create.mockResolvedValue({ _id: 'sum-1', type: 'chats' });
    PodAssetService.createChatSummaryAsset.mockResolvedValue({});

    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      podId: 'pod-1',
      content: '[BOT_MESSAGE]{"type":"integration-summary","summary":"Top updates","messageCount":4}',
      metadata: { eventId: 'evt-1', source: 'integration' },
    });

    expect(Summary.create).toHaveBeenCalledWith(expect.objectContaining({
      type: 'chats',
      podId: 'pod-1',
      content: 'Top updates',
    }));
    expect(result.summary).toEqual({ id: 'sum-1', type: 'chats' });
  });

  it('skips duplicate summary persistence for same eventId', async () => {
    Summary.findOne.mockResolvedValue({ _id: 'sum-existing', type: 'chats' });

    const result = await AgentMessageService.postMessage({
      agentName: 'commonly-bot',
      podId: 'pod-1',
      content: '[BOT_MESSAGE]{"type":"integration-summary","summary":"Top updates","messageCount":4}',
      metadata: { eventId: 'evt-dup', source: 'integration' },
    });

    expect(Summary.create).not.toHaveBeenCalled();
    expect(result.summary).toEqual({ id: 'sum-existing', type: 'chats' });
  });
});
