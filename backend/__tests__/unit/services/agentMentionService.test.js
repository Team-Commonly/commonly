jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
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

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const chatSummarizerService = require('../../../services/chatSummarizerService');
const User = require('../../../models/User');

describe('AgentMentionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('extractMentions finds supported agent aliases', () => {
    const result = AgentMentionService.extractMentions(
      'Ping @commonly-bot and @Clawdbot plus @commonlybot',
    );
    expect(result.sort()).toEqual(['commonly-bot', 'clawdbot', 'commonlybot'].sort());
  });

  test('extractMentions ignores unknown mentions', () => {
    const result = AgentMentionService.extractMentions('Hello @someoneelse');
    expect(result).toEqual(['someoneelse']);
  });

  test('enqueueMentions skips when not installed', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'Hi @commonly-bot' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(res.enqueued).toEqual([]);
    expect(res.skipped).toEqual(['commonly-bot']);
  });

  test('enqueueMentions enqueues when installed', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          agentName: 'commonly-bot',
          instanceId: 'default',
          displayName: 'Commonly Bot',
        },
      ]),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', name: 'Pod One' }),
    });
    chatSummarizerService.constructor.getLatestPodSummary.mockResolvedValue({
      title: 'Pod Summary',
      content: 'Summary content',
      metadata: { podName: 'Pod One', totalItems: 2 },
      timeRange: { start: new Date(), end: new Date() },
      type: 'chats',
    });

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'Hi @commonly-bot', id: 'msg-1' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'commonly-bot',
        instanceId: 'default',
        podId: 'pod-1',
        type: 'summary.request',
      }),
    );
    expect(res.enqueued).toEqual(['commonly-bot']);
  });

  test('enqueueMentions normalizes numeric message ids to strings for agent events', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          agentName: 'openclaw',
          instanceId: 'liz',
          displayName: 'Liz',
        },
      ]),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'Hi @liz', id: 1800 },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'openclaw',
        instanceId: 'liz',
        type: 'chat.mention',
        payload: expect.objectContaining({
          messageId: '1800',
        }),
      }),
    );
    expect(res.enqueued).toEqual(['openclaw']);
  });

  test('enqueueDmEvent enqueues dm.message for bot members in agent-admin pod', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-dm-1',
        type: 'agent-admin',
        members: ['user-1', 'agent-user-1'],
      }),
    });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'agent-user-1',
          username: 'openclaw-liz',
          botMetadata: { agentName: 'openclaw', instanceId: 'liz' },
        },
      ]),
    });
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{
        _id: 'inst-1',
        podId: 'pod-chat-1',
        installedBy: 'user-1',
        agentName: 'openclaw',
        instanceId: 'liz',
        status: 'active',
      }]),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'pod-chat-1' }]),
    });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
    });

    const result = await AgentMentionService.enqueueDmEvent({
      podId: 'pod-dm-1',
      message: { id: 42, content: 'hello there' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'openclaw',
        instanceId: 'liz',
        podId: 'pod-dm-1',
        type: 'chat.mention',
        payload: expect.objectContaining({
          messageId: '42',
          source: 'dm',
          dmPodId: 'pod-dm-1',
          installationPodId: 'pod-chat-1',
        }),
      }),
    );
    expect(result.enqueued).toEqual(['openclaw']);
  });

  test('enqueueDmEvent skips non-agent-admin pods', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat' }),
    });

    const result = await AgentMentionService.enqueueDmEvent({
      podId: 'pod-1',
      message: { content: 'hello' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: false, reason: 'not_dm_pod' });
  });
});
