jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
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
    expect(res.skipped).toEqual(['commonly-summarizer']);
  });

  test('enqueueMentions enqueues when installed', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        {
          agentName: 'commonly-summarizer',
          instanceId: 'default',
          displayName: 'Commonly Summarizer',
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
        agentName: 'commonly-summarizer',
        podId: 'pod-1',
        type: 'summary.request',
      }),
    );
    expect(res.enqueued).toEqual(['commonly-summarizer']);
  });
});
