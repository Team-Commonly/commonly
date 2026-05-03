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
    // Default sender for enqueueMentions lookups — a regular human user.
    // Tests that need a bot sender (self-mention guard) override this.
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
    });
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

  test('enqueueMentions skips when the sender is the mentioned agent (self-mention loop guard)', async () => {
    // Installation: one agent "smoke-echo" in the pod
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { agentName: 'smoke-echo', instanceId: 'default', displayName: 'Smoke Echo' },
      ]),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    // Sender is the bot itself — botMetadata matches the mention target
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'agent-user-1',
        isBot: true,
        botMetadata: { agentName: 'smoke-echo', instanceId: 'default' },
      }),
    });

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'echo: @smoke-echo hello', id: 'msg-99' },
      userId: 'agent-user-1',
      username: 'smoke-echo',
    });

    // Must NOT re-enqueue an event back to the sender
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(res.enqueued).toEqual([]);
    expect(res.skipped).toEqual(['smoke-echo:self']);
  });

  test('enqueueMentions still enqueues when a different bot mentions this agent', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { agentName: 'smoke-echo', instanceId: 'default', displayName: 'Smoke Echo' },
      ]),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    // Sender is a DIFFERENT bot — self-mention guard must not fire
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'agent-user-2',
        isBot: true,
        botMetadata: { agentName: 'other-agent', instanceId: 'default' },
      }),
    });

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: '@smoke-echo please help', id: 'msg-100' },
      userId: 'agent-user-2',
      username: 'other-agent',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'smoke-echo', instanceId: 'default' }),
    );
    expect(res.enqueued).toEqual(['smoke-echo']);
  });

  test('enqueueMentions still enqueues when sender lookup fails (guard degrades to no-op)', async () => {
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([
        { agentName: 'smoke-echo', instanceId: 'default', displayName: 'Smoke Echo' },
      ]),
    });
    AgentProfile.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });
    // Simulate a transient DB failure during sender lookup — the guard
    // should log and fall through, not block the mention enqueue.
    User.findById.mockImplementationOnce(() => {
      throw new Error('mongo connection lost');
    });

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: '@smoke-echo hello', id: 'msg-101' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
    expect(res.enqueued).toEqual(['smoke-echo']);
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

  // Agent-dm allow-list — without this, every message into the new pod
  // type is silent-dropped on the way to the agent runtime. Same bug
  // class as e78b5df241; documented in AGENT_RUNTIME.md Routing Invariants.
  test('enqueueDmEvent enqueues for agent-dm pods (allow-list)', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-dm-2',
        type: 'agent-dm',
        members: ['user-1', 'agent-user-1'],
      }),
    });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'agent-user-1',
          username: 'codex-default',
          botMetadata: { agentName: 'codex', instanceId: 'default' },
        },
      ]),
    });
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{
        _id: 'inst-2',
        podId: 'pod-dm-2',
        installedBy: 'user-1',
        agentName: 'codex',
        instanceId: 'default',
        status: 'active',
      }]),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'pod-dm-2' }]),
    });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
    });

    const result = await AgentMentionService.enqueueDmEvent({
      podId: 'pod-dm-2',
      message: { id: 99, content: 'cut a hot-fix' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        agentName: 'codex',
        podId: 'pod-dm-2',
        type: 'chat.mention',
        // Human → agent: dmKind tells the agent prompt to reply
        // responsively, not judge whether silence is appropriate.
        payload: expect.objectContaining({ dmKind: 'user-agent' }),
      }),
    );
    expect(result.enqueued).toEqual(['codex']);
  });

  // Bot senders are allowed in agent-dm rooms (the whole point — agent ↔
  // agent collaboration). They're still blocked in agent-admin/agent-room.
  test('enqueueDmEvent allows bot sender in agent-dm', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-dm-3',
        type: 'agent-dm',
        members: ['aria-user', 'codex-user'],
      }),
    });
    User.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          _id: 'codex-user',
          username: 'codex-default',
          botMetadata: { agentName: 'codex', instanceId: 'default' },
        },
      ]),
    });
    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{
        _id: 'inst-3',
        podId: 'pod-dm-3',
        installedBy: 'aria-user',
        agentName: 'codex',
        instanceId: 'default',
        status: 'active',
      }]),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'pod-dm-3' }]),
    });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'aria-user',
        isBot: true,
        botMetadata: { agentName: 'aria', instanceId: 'default' },
      }),
    });

    const result = await AgentMentionService.enqueueDmEvent({
      podId: 'pod-dm-3',
      message: { id: 100, content: 'can you review this PR?' },
      userId: 'aria-user',
      username: 'aria',
    });

    expect(AgentEventService.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        // Bot → agent in agent-dm: dmKind tells the agent prompt to
        // judge whether the reply materially advances the work and
        // return NO_REPLY when the conversation has reached a
        // natural conclusion. This pairs with the bot-loop guard
        // (8 consecutive turns within 30 min) as the backstop.
        payload: expect.objectContaining({ dmKind: 'agent-agent' }),
      }),
    );
    expect(result.enqueued).toEqual(['codex']);
  });

  test('enqueueDmEvent still blocks bot sender in legacy agent-admin', async () => {
    Pod.findById.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'pod-admin-1',
        type: 'agent-admin',
        members: ['aria-user', 'human-1'],
      }),
    });
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'aria-user',
        isBot: true,
        botMetadata: { agentName: 'aria', instanceId: 'default' },
      }),
    });

    const result = await AgentMentionService.enqueueDmEvent({
      podId: 'pod-admin-1',
      message: { content: 'hi' },
      userId: 'aria-user',
      username: 'aria',
    });

    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: false, reason: 'sender_is_bot' });
  });
});
