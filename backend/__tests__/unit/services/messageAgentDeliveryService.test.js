jest.mock('../../../services/agentMentionService', () => ({
  isAutoRoutedDmPod: jest.fn(),
  enqueueDmEvent: jest.fn(),
  enqueueMentions: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { countDocuments: jest.fn() },
}));

const AgentMentionService = require('../../../services/agentMentionService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const {
  authorUsername,
  deliverMessageToAgents,
} = require('../../../services/messageAgentDeliveryService');

describe('messageAgentDeliveryService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentMentionService.isAutoRoutedDmPod.mockReturnValue(false);
    AgentMentionService.enqueueMentions.mockResolvedValue({
      enqueued: [{ installationId: 'mention-1' }],
      implicit: ['recorder'],
      woken: [{ installationId: 'wake-1' }],
    });
    AgentInstallation.countDocuments.mockResolvedValue(2);
  });

  test.each([
    ['request user', { username: 'joined', user: { username: 'legacy' } }, { username: 'request' }, 'request'],
    ['joined PG author', { userId: { username: 'joined' }, username: 'raw' }, undefined, 'joined'],
    ['raw message author', { username: 'raw', user: { username: 'legacy' } }, undefined, 'raw'],
    ['legacy Mongo author', { user: { username: 'legacy' } }, undefined, 'legacy'],
  ])('uses the %s in the sender frame', (_case, message, requestUser, expected) => {
    expect(authorUsername(message, requestUser)).toBe(expected);
  });

  it('enriches explicit-mention delivery and preserves an explicit root-post null', async () => {
    const message = { id: 'm1', userId: { username: 'joined' }, content: 'hello @recorder' };

    const response = await deliverMessageToAgents({
      podId: 'p1',
      podType: 'chat',
      message,
      userId: 'u1',
      requestUser: { username: 'request' },
      replyToMessageId: null,
    });

    expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith({
      podId: 'p1',
      message,
      userId: 'u1',
      username: 'request',
      replyToMessageId: null,
    });
    expect(response).toEqual({
      ...message,
      agentDelivery: {
        enqueued: 1,
        implicit: ['recorder'],
        agentsInPod: 2,
        woken: 1,
      },
    });
  });

  it('omits a reply edge for a route that cannot receive one', async () => {
    const message = { id: 'm1', userId: { username: 'joined' } };

    await deliverMessageToAgents({
      podId: 'p1',
      podType: 'chat',
      message,
      userId: 'u1',
    });

    expect(AgentMentionService.enqueueMentions).toHaveBeenCalledWith({
      podId: 'p1',
      message,
      userId: 'u1',
      username: 'joined',
    });
  });

  it('sends automatic DM delivery without advisory metadata', async () => {
    const message = { id: 'm1', user: { username: 'mongo-author' } };
    AgentMentionService.isAutoRoutedDmPod.mockReturnValue(true);

    const response = await deliverMessageToAgents({
      podId: 'p1',
      podType: 'agent-admin',
      message,
      userId: 'u1',
    });

    expect(AgentMentionService.enqueueDmEvent).toHaveBeenCalledWith({
      podId: 'p1', message, userId: 'u1', username: 'mongo-author',
    });
    expect(AgentMentionService.enqueueMentions).not.toHaveBeenCalled();
    expect(AgentInstallation.countDocuments).not.toHaveBeenCalled();
    expect(response).toBe(message);
  });

  it('keeps a persisted post successful when the advisory count fails', async () => {
    const countError = new Error('database unavailable');
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    AgentInstallation.countDocuments.mockRejectedValue(countError);

    const response = await deliverMessageToAgents({
      podId: 'p1', podType: 'chat', message: { id: 'm1' }, userId: 'u1',
    });

    expect(response.agentDelivery.agentsInPod).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      '[messageAgentDelivery] active-agent delivery count failed:',
      'database unavailable',
    );
    warn.mockRestore();
  });
});
