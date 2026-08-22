const fs = require('fs');
const path = require('path');

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

jest.mock('../../../models/AgentEvent', () => ({
  countDocuments: jest.fn(),
}));

jest.mock('../../../services/welcomeWakeService', () => ({
  maybeFireWelcomeWake: jest.fn(),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const chatSummarizerService = require('../../../services/chatSummarizerService');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { maybeFireWelcomeWake } = require('../../../services/welcomeWakeService');

describe('AgentMentionService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Default sender for enqueueMentions lookups — a regular human user.
    // Tests that need a bot sender (self-mention guard) override this.
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
    });
    // #508 dampener default — no prior mentions, so nothing is dampened.
    AgentEvent.countDocuments.mockResolvedValue(0);
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

  test.each([
    ['agent-admin', true],
    ['agent-room', true],
    ['agent-dm', true],
    ['chat', false],
    ['team', false],
  ])('classifies %s as an auto-routed DM pod: %s', (type, expected) => {
    expect(AgentMentionService.isAutoRoutedDmPod(type)).toBe(expected);
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

  describe('implicit reply mentions', () => {
    const setupReplyTarget = ({ installed = true } = {}) => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue(installed ? [
          { agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' },
        ] : []),
      });
      AgentProfile.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      });
      Pod.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({ _id: 'pod-reply', type: 'chat' }),
      });
    };

    const asHumanReplyingTo = (replyAuthor) => {
      User.findById.mockImplementation((id) => ({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(
          id === 'reply-author'
            ? replyAuthor
            : { _id: 'human-1', isBot: false },
        ),
      }));
    };

    test('bot sender replying to an agent does not implicitly enqueue (loop guard)', async () => {
      setupReplyTarget();
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: 'agent-sender',
          isBot: true,
          botMetadata: { agentName: 'openclaw', instanceId: 'theo' },
        }),
      });

      const result = await AgentMentionService.enqueueMentions({
        podId: 'pod-reply',
        replyToMessageId: 'message-from-aria',
        message: {
          id: 'bot-reply',
          content: 'Following up',
          replyTo: { userId: 'reply-author' },
        },
        userId: 'agent-sender',
        username: 'theo',
      });

      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(User.findById).toHaveBeenCalledTimes(1);
      expect(result.implicit).toEqual([]);
    });

    test('human reply to an active agent enqueues exactly one implicit mention', async () => {
      setupReplyTarget();
      asHumanReplyingTo({
        _id: 'reply-author',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
      });

      const result = await AgentMentionService.enqueueMentions({
        podId: 'pod-reply',
        replyToMessageId: 'message-from-aria',
        message: {
          id: 'human-reply',
          content: 'That sounds good',
          replyTo: { userId: 'reply-author' },
        },
        userId: 'human-1',
        username: 'alice',
      });

      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      expect(AgentEventService.enqueue).toHaveBeenCalledWith(expect.objectContaining({
        agentName: 'openclaw',
        instanceId: 'aria',
        podId: 'pod-reply',
        type: 'chat.mention',
        payload: expect.objectContaining({
          messageId: 'human-reply',
          replyToMessageId: 'message-from-aria',
          implicitReply: true,
        }),
      }));
      expect(result.enqueued).toEqual(['openclaw']);
      expect(result.implicit).toEqual(['openclaw']);
    });

    test('explicit mention plus reply to the same agent enqueues only once', async () => {
      setupReplyTarget();
      asHumanReplyingTo({
        _id: 'reply-author',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
      });

      const result = await AgentMentionService.enqueueMentions({
        podId: 'pod-reply',
        replyToMessageId: 'message-from-aria',
        message: {
          id: 'human-reply',
          content: '@aria thanks',
          replyTo: { userId: 'reply-author' },
        },
        userId: 'human-1',
        username: 'alice',
      });

      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      expect(result.enqueued).toEqual(['openclaw']);
      expect(result.implicit).toEqual([]);
    });

    test('reply to a human does not enqueue an implicit mention', async () => {
      setupReplyTarget();
      asHumanReplyingTo({ _id: 'reply-author', isBot: false });

      const result = await AgentMentionService.enqueueMentions({
        podId: 'pod-reply',
        replyToMessageId: 'human-message',
        message: {
          id: 'human-reply',
          content: 'Thanks',
          replyTo: { userId: 'reply-author' },
        },
        userId: 'human-1',
        username: 'alice',
      });

      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(result.implicit).toEqual([]);
    });

    test('reply to an uninstalled agent does not enqueue an implicit mention', async () => {
      setupReplyTarget({ installed: false });
      asHumanReplyingTo({
        _id: 'reply-author',
        isBot: true,
        botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
      });

      const result = await AgentMentionService.enqueueMentions({
        podId: 'pod-reply',
        replyToMessageId: 'message-from-aria',
        message: {
          id: 'human-reply',
          content: 'Are you there?',
          replyTo: { userId: 'reply-author' },
        },
        userId: 'human-1',
        username: 'alice',
      });

      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(result.implicit).toEqual([]);
    });
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

  // ------------------------------------------------------------------
  // Inline-cue composition (consultation + reply-mechanics) — verifies
  // the 4-way matrix: chat-vs-thread × specialist-vs-not.
  //   chat.mention + non-specialist  → [Pod] [Collab] [Reply] body
  //   chat.mention + specialist      → [Pod] [Reply] body
  //   thread.mention + non-specialist→ [Pod] [Collab] body
  //   thread.mention + specialist    → [Pod] body
  // See buildContentForTarget in agentMentionService.ts for full
  // rationale + invariants.
  // ------------------------------------------------------------------
  describe('inline cue composition (consultation + reply-mechanics)', () => {
    const setupForAgent = ({ agentName, instanceId, displayName }) => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([{ agentName, instanceId, displayName }]),
      });
      AgentProfile.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      });
    };
    const lastPayload = () => AgentEventService.enqueue.mock.calls[0][0];

    test('chat.mention + openclaw (non-specialist) → pod + consultation + reply-mechanics', async () => {
      setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
      await AgentMentionService.enqueueMentions({
        podId: 'pod-mention-1',
        message: { content: 'Hi @nova', id: 'msg-1' },
        userId: 'user-1',
        username: 'sam',
      });
      const ev = lastPayload();
      expect(ev.type).toBe('chat.mention');
      expect(ev.payload.content).toContain('[Pod context:');
      expect(ev.payload.content).toContain('[Collaboration:');
      expect(ev.payload.content).toContain('[Reply mechanics:');
      expect(ev.payload.content).toContain('Hi @nova');
    });

    // Author/age frame. The envelope has always carried `username` and
    // `createdAt`; the model only ever sees `payload.content`, so they
    // were invisible to their only reader (four sprint agents spent
    // 2026-08-04 misattributing each other and re-answering
    // redeliveries). These guard the two properties that make the frame
    // work, both of which a plausible "simplification" would break.
    describe('author/age frame', () => {
      test('chat.mention carries author + message id inline in content', async () => {
        setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
        await AgentMentionService.enqueueMentions({
          podId: 'pod-author-1',
          message: { content: 'Hi @nova', id: 'msg-42', createdAt: new Date('2026-08-04T11:42:38.637Z') },
          userId: 'user-1',
          username: 'UX Lead',
        });
        const ev = lastPayload();
        expect(ev.payload.content).toContain('[Trigger:');
        expect(ev.payload.content).toContain('UX Lead');
        expect(ev.payload.content).toContain('message msg-42');
      });

      // THE regression guard. Content is composed once at enqueue and an
      // unacked event is re-served with that same frozen string, so a
      // relative age ("posted 3 seconds ago") would still read "3 seconds
      // ago" on a redelivery 18 minutes later — lying on exactly the case
      // the frame exists to catch. The stamp must be the message's own
      // createdAt, absolute.
      test('stamp is the message createdAt, absolute — never a relative age', async () => {
        setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
        const written = new Date('2026-08-04T11:42:38.637Z');
        await AgentMentionService.enqueueMentions({
          podId: 'pod-author-2',
          message: { content: 'Hi @nova', id: 'msg-43', createdAt: written },
          userId: 'user-1',
          username: 'sam',
        });
        const { content } = lastPayload().payload;
        expect(content).toContain(written.toISOString());
        // Bare /\bago\b/, not a unit-prefixed pattern. The likelier bad
        // edit ADDS a friendly age beside the stamp rather than
        // replacing it — `posted at <ISO> (3m ago)` keeps the ISO and
        // slips a unit-prefixed matcher, which was this guard's first
        // shape (@sprint-review, verified applied, 35/35 still passed).
        expect(content).not.toMatch(/\bago\b/i);
      });

      // A missing createdAt must read as UNKNOWN, never as `new Date()`.
      // An absent author renders "unknown" and is honest; a fabricated
      // stamp is not — it is indistinguishable from a real one, asserted
      // as the write time, and frozen into the string, so an ageless
      // message would read as freshly-written on every redelivery
      // forever. That is the exact failure the frame exists to prevent.
      test('no createdAt → says UNKNOWN, does not fabricate a stamp', async () => {
        setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
        await AgentMentionService.enqueueMentions({
          podId: 'pod-author-4',
          message: { content: 'Hi @nova', id: 'msg-99' },
          userId: 'user-1',
          username: 'sam',
        });
        const { content } = lastPayload().payload;
        expect(content).toContain('write time UNKNOWN');
        // No ISO-8601 timestamp anywhere in the frame.
        const frame = content.slice(content.indexOf('[Trigger:'));
        expect(frame.slice(0, frame.indexOf(']') + 1))
          .not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
      });

      // `.toISOString()` on an Invalid Date THROWS, so an unparseable
      // value would take the whole enqueue down rather than degrading.
      test('unparseable createdAt degrades to UNKNOWN, does not throw', async () => {
        setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
        await expect(AgentMentionService.enqueueMentions({
          podId: 'pod-author-5',
          message: { content: 'Hi @nova', id: 'msg-100', createdAt: 'not-a-date' },
          userId: 'user-1',
          username: 'sam',
        })).resolves.toBeDefined();
        expect(lastPayload().payload.content).toContain('write time UNKNOWN');
      });

      // The advice must name all three exposures a stale event creates,
      // not just the one it originally named. "rather than answering
      // twice" scoped a correct instruction to a third of its reach: a
      // redelivery hides a peer's PROGRESS as well as their question, so
      // it also drives racing finished work and re-claiming a peer's
      // finding. Both happened on 2026-08-05, twenty minutes apart, and
      // the single call this frame already named would have shown both.
      test('names picking up work and posting a finding, not only replying', async () => {
        setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
        await AgentMentionService.enqueueMentions({
          podId: 'pod-author-6',
          message: { content: 'Hi @nova', id: 'msg-101', createdAt: new Date('2026-08-05T20:31:09.579Z') },
          userId: 'user-1',
          username: 'UX Lead',
        });
        const { content } = lastPayload().payload;
        expect(content).toContain('commonly_get_messages');
        expect(content).toMatch(/pick up work/i);
        expect(content).toMatch(/post a finding as new/i);
        // The scope regression this guards is a REVERT to reply-only
        // advice, which would still mention replying — so asserting the
        // other two actions is what actually holds the line.
      });

      // A widening edit has to re-read every branch that shares the
      // shape. This frame has two: the stamped path and the UNKNOWN
      // path, which carried the same reply-only scope and is the one a
      // fix aimed at the common case silently leaves behind.
      test('the UNKNOWN branch got the same widening — no half-fixed path', async () => {
        setupForAgent({ agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' });
        await AgentMentionService.enqueueMentions({
          podId: 'pod-author-7',
          message: { content: 'Hi @nova', id: 'msg-102' },
          userId: 'user-1',
          username: 'sam',
        });
        const { content } = lastPayload().payload;
        expect(content).toContain('write time UNKNOWN');
        expect(content).toMatch(/pick up work/i);
        expect(content).toMatch(/post a finding as new/i);
      });

      // Unconditional, unlike the four cues around it: every event type
      // and every runtime needs to know who spoke and when.
      test('thread.mention carries it too — the frame is not shape-gated', async () => {
        setupForAgent({ agentName: 'codex', instanceId: 'cody', displayName: 'Cody' });
        await AgentMentionService.enqueueMentions({
          podId: 'pod-author-3',
          message: {
            content: 'Hi @cody',
            id: 'msg-44',
            source: 'thread',
            createdAt: new Date('2026-08-04T11:42:38.637Z'),
            thread: { postId: 'thread-1', postContent: 'parent' },
          },
          userId: 'user-1',
          username: 'Sprint Review',
        });
        const { content } = lastPayload().payload;
        expect(content).toContain('[Trigger:');
        expect(content).toContain('Sprint Review');
      });
    });

    test('chat.mention + codex (specialist) → pod + reply-mechanics, NO consultation', async () => {
      setupForAgent({ agentName: 'codex', instanceId: 'cody', displayName: 'Cody' });
      await AgentMentionService.enqueueMentions({
        podId: 'pod-mention-2',
        message: { content: 'Hi @cody', id: 'msg-2' },
        userId: 'user-1',
        username: 'sam',
      });
      const ev = lastPayload();
      expect(ev.type).toBe('chat.mention');
      expect(ev.payload.content).toContain('[Pod context:');
      expect(ev.payload.content).not.toContain('[Collaboration:');
      // chat.mention always gets reply-mechanics regardless of specialist
      // status — heartbeat-clobber affects all openclaw event paths; cloud-
      // codex runs codex CLI which posts via the same path, so the rule
      // is fine to apply uniformly to chat.mention.
      expect(ev.payload.content).toContain('[Reply mechanics:');
    });

    test('thread.mention + openclaw (non-specialist) → pod + consultation, NO reply-mechanics', async () => {
      setupForAgent({ agentName: 'openclaw', instanceId: 'theo', displayName: 'Theo' });
      await AgentMentionService.enqueueMentions({
        podId: 'pod-thread-1',
        message: {
          content: 'Hi @theo',
          id: 'msg-3',
          source: 'thread',
          thread: { postId: 'thread-99', postContent: 'parent post' },
        },
        userId: 'user-1',
        username: 'sam',
      });
      const ev = lastPayload();
      expect(ev.type).toBe('thread.mention');
      expect(ev.payload.content).toContain('[Pod context:');
      expect(ev.payload.content).toContain('[Collaboration:');
      // Thread replies post via a different openclaw path — no clobber race.
      expect(ev.payload.content).not.toContain('[Reply mechanics:');
    });

    test('thread.mention + codex (specialist) → pod only, no consultation or reply-mechanics', async () => {
      setupForAgent({ agentName: 'codex', instanceId: 'cody', displayName: 'Cody' });
      await AgentMentionService.enqueueMentions({
        podId: 'pod-thread-2',
        message: {
          content: 'Hi @cody',
          id: 'msg-4',
          source: 'thread',
          thread: { postId: 'thread-100', postContent: 'parent post' },
        },
        userId: 'user-1',
        username: 'sam',
      });
      const ev = lastPayload();
      expect(ev.type).toBe('thread.mention');
      expect(ev.payload.content).toContain('[Pod context:');
      expect(ev.payload.content).not.toContain('[Collaboration:');
      expect(ev.payload.content).not.toContain('[Reply mechanics:');
    });

    test('claude-code is also treated as a specialist (cross-runtime parity)', async () => {
      setupForAgent({ agentName: 'claude-code', instanceId: 'default', displayName: 'Claude Code' });
      await AgentMentionService.enqueueMentions({
        podId: 'pod-cc-1',
        message: { content: 'Hi @claude-code', id: 'msg-5' },
        userId: 'user-1',
        username: 'sam',
      });
      expect(lastPayload().payload.content).not.toContain('[Collaboration:');
    });

    // ----------------------------------------------------------------
    // Collaborative-pod cue (Phase 3.A — auto-replicates the
    // execute-not-handoff principle established in the 2026-05-23
    // huddle). Fires when:
    //   1. Pod has ≥2 active non-utility agent installations
    //   2. Pod.type is NOT agent-room or agent-dm (1:1 by design)
    //   3. Target is a non-specialist (specialists self-execute already)
    //   4. Event is chat.mention (not thread.mention)
    //
    // Reference incidents in docs/audits/ui-smoke-2026-05-23/
    // huddle-observations.md and the memory entries
    // feedback-agents-collab-execute-not-handoff +
    // feedback-claim-the-orphan-stalled-peer-work.
    // ----------------------------------------------------------------
    describe('collaborative-pod cue', () => {
      const setupForMultipleAgents = (installs, { podType = 'team' } = {}) => {
        AgentInstallation.find.mockReturnValue({
          lean: jest.fn().mockResolvedValue(installs),
        });
        AgentProfile.find.mockReturnValue({
          lean: jest.fn().mockResolvedValue([]),
        });
        // Pod.findById(podId).select('type').lean() — the chained mock the
        // collaborative-pod detection consults. Falls back to count-only
        // heuristic if this rejects, so the test stays useful even if the
        // mock shape drifts.
        Pod.findById.mockReturnValue({
          select: jest.fn().mockReturnValue({
            lean: jest.fn().mockResolvedValue({ type: podType }),
          }),
        });
      };

      test('chat.mention + ≥2 non-utility agents + non-specialist target → [Collaborative pod:] cue present', async () => {
        setupForMultipleAgents([
          { agentName: 'openclaw', instanceId: 'theo', displayName: 'Theo' },
          { agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' },
          { agentName: 'codex', instanceId: 'cody', displayName: 'Cody' },
        ]);
        await AgentMentionService.enqueueMentions({
          podId: 'pod-collab-1',
          message: { content: 'Hi @nova please review', id: 'msg-collab-1' },
          userId: 'user-1',
          username: 'sam',
        });
        const ev = lastPayload();
        expect(ev.type).toBe('chat.mention');
        expect(ev.payload.content).toContain('[Collaborative pod:');
        expect(ev.payload.content).toContain('EXECUTE it yourself');
        // Composes with the other cues — collab-pod doesn't displace them.
        expect(ev.payload.content).toContain('[Pod context:');
        expect(ev.payload.content).toContain('[Collaboration:');
        expect(ev.payload.content).toContain('[Reply mechanics:');
      });

      test('chat.mention + single agent in pod → NO [Collaborative pod:] cue (solo pod)', async () => {
        // Single-agent pod: not a huddle, don't add the cue.
        setupForMultipleAgents([
          { agentName: 'openclaw', instanceId: 'theo', displayName: 'Theo' },
        ]);
        await AgentMentionService.enqueueMentions({
          podId: 'pod-collab-2',
          message: { content: 'Hi @theo', id: 'msg-collab-2' },
          userId: 'user-1',
          username: 'sam',
        });
        expect(lastPayload().payload.content).not.toContain('[Collaborative pod:');
      });

      test('chat.mention + ≥2 agents but target IS specialist → NO collab cue (noise for codex)', async () => {
        setupForMultipleAgents([
          { agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' },
          { agentName: 'codex', instanceId: 'cody', displayName: 'Cody' },
        ]);
        await AgentMentionService.enqueueMentions({
          podId: 'pod-collab-3',
          message: { content: 'Hi @cody build this', id: 'msg-collab-3' },
          userId: 'user-1',
          username: 'sam',
        });
        const ev = lastPayload();
        expect(ev.payload.content).not.toContain('[Collaborative pod:');
        // Specialist still gets pod-context + reply-mechanics
        expect(ev.payload.content).toContain('[Pod context:');
        expect(ev.payload.content).toContain('[Reply mechanics:');
      });

      test('chat.mention + 2 agents but BOTH are utility helpers → NO collab cue (helpers don\'t count as peers)', async () => {
        // pod-welcomer + task-clerk are utility helpers, not collab peers
        setupForMultipleAgents([
          { agentName: 'pod-welcomer', instanceId: 'default', displayName: 'Welcomer' },
          { agentName: 'task-clerk', instanceId: 'default', displayName: 'Clerk' },
          { agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' },
        ]);
        await AgentMentionService.enqueueMentions({
          podId: 'pod-collab-4',
          message: { content: 'Hi @nova', id: 'msg-collab-4' },
          userId: 'user-1',
          username: 'sam',
        });
        // Only 1 non-utility peer (nova), so collab cue should NOT fire
        expect(lastPayload().payload.content).not.toContain('[Collaborative pod:');
      });

      test('chat.mention + agent-room pod type → NO collab cue regardless of agent count', async () => {
        // agent-room is explicitly 1:1 user↔agent; even with 2 agents installed
        // (edge case), the cue is wrong for this pod type.
        setupForMultipleAgents(
          [
            { agentName: 'openclaw', instanceId: 'theo', displayName: 'Theo' },
            { agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' },
          ],
          { podType: 'agent-room' },
        );
        await AgentMentionService.enqueueMentions({
          podId: 'pod-collab-5',
          message: { content: 'Hi @nova', id: 'msg-collab-5' },
          userId: 'user-1',
          username: 'sam',
        });
        expect(lastPayload().payload.content).not.toContain('[Collaborative pod:');
      });

      test('thread.mention + ≥2 agents → NO collab cue (threads are different posture)', async () => {
        setupForMultipleAgents([
          { agentName: 'openclaw', instanceId: 'theo', displayName: 'Theo' },
          { agentName: 'openclaw', instanceId: 'nova', displayName: 'Nova' },
        ]);
        await AgentMentionService.enqueueMentions({
          podId: 'pod-collab-6',
          message: {
            content: 'Hi @theo',
            id: 'msg-collab-6',
            source: 'thread',
            thread: { postId: 'thread-1', postContent: 'parent' },
          },
          userId: 'user-1',
          username: 'sam',
        });
        expect(lastPayload().payload.content).not.toContain('[Collaborative pod:');
      });
    });
  });

  // ------------------------------------------------------------------
  // #508 mutual bot<->bot @mention loop dampener. Suppresses a bot->bot
  // mention once the target has received > MENTION_LOOP_MAX (3) chat.mention
  // events in this pod within the recent window. Genuine handoffs (under
  // threshold) and ALL human->agent mentions are never dampened.
  // ------------------------------------------------------------------
  describe('bot<->bot loop dampener (#508)', () => {
    const setupTargetAgent = () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'openclaw', instanceId: 'cody', displayName: 'Cody' },
        ]),
      });
      AgentProfile.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      });
    };
    const asBotSender = () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: 'agent-theo',
          isBot: true,
          botMetadata: { agentName: 'openclaw', instanceId: 'theo' },
        }),
      });
    };

    test('bot -> bot UNDER threshold still enqueues (genuine collaboration)', async () => {
      setupTargetAgent();
      asBotSender();
      // 3 prior mentions == MENTION_LOOP_MAX; not strictly greater, so allowed.
      AgentEvent.countDocuments.mockResolvedValue(3);

      const res = await AgentMentionService.enqueueMentions({
        podId: 'pod-loop-1',
        message: { content: '@cody can you take this?', id: 'msg-loop-1' },
        userId: 'agent-theo',
        username: 'theo',
      });

      expect(AgentEvent.countDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          agentName: 'openclaw',
          instanceId: 'cody',
          podId: 'pod-loop-1',
          // Was `type: 'chat.mention'` — this assertion pinned #976 rather
          // than catching it, because it described the query the code made
          // instead of the population the gate covers.
          type: { $in: ['chat.mention', 'thread.mention'] },
        }),
      );
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      expect(res.enqueued).toEqual(['openclaw']);
      expect(res.skipped).toEqual([]);
    });

    test('bot -> bot OVER threshold is suppressed (loop dampened)', async () => {
      setupTargetAgent();
      asBotSender();
      // 4 prior mentions > MENTION_LOOP_MAX (3) → treat as a loop.
      AgentEvent.countDocuments.mockResolvedValue(4);

      const res = await AgentMentionService.enqueueMentions({
        podId: 'pod-loop-2',
        message: { content: '@cody and again', id: 'msg-loop-2' },
        userId: 'agent-theo',
        username: 'theo',
      });

      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(res.enqueued).toEqual([]);
      expect(res.skipped).toEqual(['openclaw:loop-dampened']);
    });

    test('human -> bot is NEVER suppressed even over threshold', async () => {
      setupTargetAgent();
      // Default sender is a human (User.findById from beforeEach).
      AgentEvent.countDocuments.mockResolvedValue(999);

      const res = await AgentMentionService.enqueueMentions({
        podId: 'pod-loop-3',
        message: { content: '@cody please help', id: 'msg-loop-3' },
        userId: 'user-1',
        username: 'alice',
      });

      // Human sender short-circuits before any count check.
      expect(AgentEvent.countDocuments).not.toHaveBeenCalled();
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      expect(res.enqueued).toEqual(['openclaw']);
      expect(res.skipped).toEqual([]);
    });
  });

  /**
   * Every tool named in an inline cue must exist on the recipient's surface.
   *
   * These cues are kernel-level: buildContentForTarget ships them to every
   * agent with NO driver-class branch, so a name that is valid in one
   * runtime's namespace is an instruction the rest of the fleet cannot serve.
   * Until 2026-08-04 the pod-context frame named `commonly_read_attachment`
   * (exists nowhere — not in @commonlyai/mcp, not in this repo outside the
   * sentence naming it) and the consultation cue named only
   * `commonly_open_dm`, which is the openclaw-extension name; MCP consumers
   * — every ADR-005 wrapper and cloud-codex seat — hold `commonly_dm_agent`.
   *
   * Same defect as the heartbeat cue's rolled-back `commonly_save_my_memory`
   * shape (PR #818), on a much wider surface: heartbeats are per-tick, this
   * is every mention to every agent. Found by @ux-lead, who noticed their own
   * pod context instructing them toward two tools they do not have.
   *
   * Asserted against the DELIVERED payload rather than the source, so the
   * composition path is covered too — the #818 lesson was that pinning the
   * constant leaves the delivery unpinned.
   */
  describe('inline cues name only tools that exist', () => {
    // Provenance is deliberate: each entry records WHICH surface provides the
    // tool, because "it exists" was never the question — "it exists for the
    // agent being told to call it" is.
    //
    // READ from docs/MCP_INTEGRATION.md rather than copied out of it. The first
    // version of this guard hand-listed twelve tools under a `Source:` comment
    // naming that doc, which then carried twenty-six. The list went stale the
    // moment a tool was added, and the guard's first real firing was a FALSE
    // POSITIVE: it called `commonly_get_messages` — shipped, documented, and
    // the tool #798 fixed pagination for — a tool that does not exist.
    //
    // A guard against drift that keeps its own copy of the thing it guards is
    // the defect it exists to catch, one level up. Same shape as #818 itself
    // (an extracted cue that went stale against the delivered one) and as
    // ADR-016's rule that a creation gate must consult the DM predicate rather
    // than a hand-maintained allowlist that happens to agree with it.
    const MCP_DOC = path.join(__dirname, '../../../../docs/MCP_INTEGRATION.md');
    const MCP_TOOLS = [...new Set(
      (fs.readFileSync(MCP_DOC, 'utf8').match(/commonly_[a-z][a-z0-9_]*[a-z0-9]/g) || []),
    )];
    // Names the openclaw extension declares and the MCP server does not, so
    // they are absent from the doc above. Deliberately NOT annotated with a
    // commit — every previous attempt to pin these to a sha ("live since
    // 11878b43c") named a ref on a lineage the gitlink was not tracking, and
    // was false or true depending on the week. Whether a given pin declares
    // these is asserted by `npm run verify:moltbot-tools` against the actual
    // submodule; this list only records that the names are openclaw's, which
    // is a fact about namespaces and does not move.
    const OPENCLAW_ONLY = ['commonly_open_dm', 'commonly_read_attachment'];
    const KNOWN = new Set([...MCP_TOOLS, ...OPENCLAW_ONLY]);

    // If the doc ever moves or empties, every cue silently "passes". Fail loud.
    test('the tool inventory actually loaded — an empty allowlist proves nothing', () => {
      expect(MCP_TOOLS.length).toBeGreaterThan(20);
      expect(MCP_TOOLS).toContain('commonly_log_cycle');
    });

    test('every commonly_* tool in a delivered mention payload is a real tool', async () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' },
        ]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', name: 'Pod One' }),
      });

      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'Hi @openclaw', id: 'msg-1' },
        userId: 'user-1',
        username: 'alice',
      });

      expect(AgentEventService.enqueue).toHaveBeenCalled();
      const { content } = AgentEventService.enqueue.mock.calls[0][0].payload;
      const named = [...new Set(content.match(/commonly_[a-z_]+/g) || [])];

      // Control: if the cue stops naming tools entirely this assertion would
      // pass vacuously, which is the failure mode that hides a broken cue.
      expect(named.length).toBeGreaterThan(0);

      const unknown = named.filter((t) => !KNOWN.has(t));
      expect(unknown).toEqual([]);
    });

    test('the DM opener names the MCP tool, not only the openclaw one', async () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' },
        ]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', name: 'Pod One' }),
      });

      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'Hi @openclaw', id: 'msg-1' },
        userId: 'user-1',
        username: 'alice',
      });

      const { content } = AgentEventService.enqueue.mock.calls[0][0].payload;
      expect(content).toContain('commonly_dm_agent');
    });

    /**
     * The read line is the same two-namespace problem as the DM opener, and
     * it has now been wrong in BOTH directions inside 24 hours: it named
     * `commonly_read_attachment` (right for openclaw, absent from MCP), that
     * was deleted as nonexistent, and the replacement `commonly_read_file`
     * is right for MCP but absent from openclaw — and was written at the
     * wrong arity besides. An assertion that the delivered payload does NOT
     * contain the openclaw name used to live in the DM-opener test above;
     * it pinned one half of the defect while the other half shipped.
     *
     * What is asserted here is the property that survives a pin move: both
     * names present, the MCP call at full arity, and a fallback for an agent
     * that holds neither — which is the state the `0082147920` pin was in.
     */
    test('the read line names both readers, at the right arity, with a fallback', async () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' },
        ]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', name: 'Pod One' }),
      });

      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'Hi @openclaw', id: 'msg-1' },
        userId: 'user-1',
        username: 'alice',
      });

      const { content } = AgentEventService.enqueue.mock.calls[0][0].payload;

      // MCP's reader requires podId AND fileName — naming it with fileName
      // alone is the defect this replaces, and reads as correct.
      expect(content).toMatch(/commonly_read_file\(\{\s*podId:\s*"pod-1",\s*fileName\s*\}\)/);
      expect(content).toContain('commonly_read_attachment');
      // Pin-independence: an agent on a pin that declares neither must be
      // told to stop, not left to hunt for a third name.
      expect(content).toMatch(/no working reader/i);
      expect(content).toMatch(/paste the content/i);

      /**
       * The skip clause must cover FAILURE, not only ABSENCE — declaration is
       * not sufficiency.
       *
       * At `70bd82b8` the openclaw reader shells out: `officecli` for Office
       * formats, `pdftotext` for PDF, and `markitdown` as the DEFAULT branch
       * for every extension outside its short text list — `.ts`, `.js`, `.py`,
       * `.sql` all land there, so source files (the likeliest attachment in a
       * dev pod) take the spawn path. A missing binary rejects through
       * `child.on('error')` and the surrounding try/finally has no catch, so
       * the tool throws rather than degrading to raw text.
       *
       * That agent holds a declared, correctly-named, correctly-invoked tool
       * that cannot read. A cue scoped to absence sends it hunting for another
       * name, which is the behaviour this whole line exists to prevent.
       */
      expect(content).toMatch(/or the call fails/i);

      /**
       * ...and the THIRD state, which is neither absence nor failure.
       *
       * Probed on the deployed gateway (934df6de) 2026-08-05: markitdown is
       * installed without extras, so a valid PNG converts to exit 0 and zero
       * bytes. Nothing throws, nothing is missing, the status code says
       * success. The agent receives "" and reports the file as blank —
       * a specific false statement, not a vague one, which is why the cue
       * names it rather than only saying "you have no reader".
       */
      expect(content).toMatch(/returns nothing/i);
      expect(content).toMatch(/reporting the file as empty/i);
    });

    /**
     * Sentence-level, same as the open_dm scoping test: the openclaw-only
     * reader may appear, but never unqualified — an MCP seat reading
     * "call commonly_read_attachment" with no runtime qualifier is exactly
     * the turn-burn that forced the #296 rollback.
     */
    test('every commonly_read_attachment mention is scoped to openclaw', async () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' },
        ]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', name: 'Pod One' }),
      });

      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'Hi @openclaw', id: 'msg-1' },
        userId: 'user-1',
        username: 'alice',
      });

      const { content } = AgentEventService.enqueue.mock.calls[0][0].payload;
      const sites = [...content.matchAll(/commonly_read_attachment/g)];

      // Control: zero occurrences would make the loop assert nothing.
      expect(sites.length).toBeGreaterThan(0);

      sites.forEach((m) => {
        const window = content.slice(Math.max(0, m.index - 120), m.index + 120);
        expect(window).toMatch(/openclaw/i);
      });
    });

    // The allow-list above is deliberately weaker than it looks: it treats
    // `commonly_open_dm` as a known tool, so a cue reading "open a DM with
    // commonly_open_dm" — with no runtime qualifier — passes it identically to
    // the correct text. That is the exact defect this PR fixes, so the
    // allow-list cannot be the guard against it.
    //
    // The property is sentence-level, not token-level: the openclaw-only name
    // may appear, but never unqualified. Suggested by @ux-lead.
    test('every commonly_open_dm mention is scoped to openclaw', async () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'openclaw', instanceId: 'aria', displayName: 'Aria' },
        ]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue({ _id: 'pod-1', name: 'Pod One' }),
      });

      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'Hi @openclaw', id: 'msg-1' },
        userId: 'user-1',
        username: 'alice',
      });

      const { content } = AgentEventService.enqueue.mock.calls[0][0].payload;
      const sites = [...content.matchAll(/commonly_open_dm/g)];

      // Control: with zero occurrences the loop below asserts nothing, which
      // is indistinguishable from a pass. The cue is expected to name it.
      expect(sites.length).toBeGreaterThan(0);

      sites.forEach((m) => {
        const window = content.slice(Math.max(0, m.index - 120), m.index + 120);
        expect(window).toMatch(/openclaw/i);
      });
    });
  });
  // ── #834 first-message welcome wake, wiring ───────────────────────────────
  //
  // The unit behaviour lives in welcomeWakeService.test.js. What matters here
  // is that enqueueMentions reaches it at all, because the wake's whole point
  // is to run on the path that used to return before doing anything.
  describe('first-message welcome wake wiring', () => {
    const human = () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ isBot: false }),
        }),
      });
    };
    const bot = () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            isBot: true,
            botMetadata: { agentName: 'openclaw', instanceId: 'aria' },
          }),
        }),
      });
    };

    beforeEach(() => {
      AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ type: 'chat' }) }),
      });
      maybeFireWelcomeWake.mockResolvedValue({ claimed: true, woke: [] });
    });

    test('an unaddressed human message reaches the wake — the path that used to return early', async () => {
      human();
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: '这个是什么', _id: 'm-9' },
        userId: 'user-1',
        username: 'user-9228',
      });
      expect(maybeFireWelcomeWake).toHaveBeenCalledWith(
        expect.objectContaining({ isRouted: false, podId: 'pod-1', userId: 'user-1' }),
      );
    });

    test('an unaddressed message still enqueues nothing — behaviour is unchanged', async () => {
      human();
      const res = await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'no mention here' },
        userId: 'user-1',
        username: 'alice',
      });
      expect(res).toEqual({
        enqueued: [], implicit: [], skipped: [], woken: [],
      });
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });

    test('an addressed message reaches the wake flagged routed, so it claims without welcoming', async () => {
      human();
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'hi @codex' },
        userId: 'user-1',
        username: 'alice',
      });
      expect(maybeFireWelcomeWake).toHaveBeenCalledWith(
        expect.objectContaining({ isRouted: true }),
      );
    });

    test('a reply counts as routed even with no @mention', async () => {
      human();
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'thanks!' },
        userId: 'user-1',
        username: 'alice',
        replyToMessageId: 'm-1',
      });
      expect(maybeFireWelcomeWake).toHaveBeenCalledWith(
        expect.objectContaining({ isRouted: true }),
      );
    });

    // An agent's first post in a pod must never claim or wake: the greeter
    // would answer it, that answer is itself a first post elsewhere, and the
    // #703 path is gated on isBot === false for exactly this reason.
    test('a bot sender never reaches the wake', async () => {
      bot();
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'status update' },
        userId: 'bot-1',
        username: 'Aria',
      });
      expect(maybeFireWelcomeWake).not.toHaveBeenCalled();
    });

    test('a wake failure never breaks the send', async () => {
      human();
      maybeFireWelcomeWake.mockRejectedValue(new Error('mongo down'));
      await expect(AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'hello' },
        userId: 'user-1',
        username: 'alice',
      })).resolves.toEqual({
        enqueued: [], implicit: [], skipped: [], woken: [],
      });
    });
  });
  // ── the greeter naming its own handle must not re-trigger itself ─────────
  //
  // The welcome cue instructs the agent to close with "@<handle> anytime".
  // That puts the agent's OWN handle into a message the agent itself sent, so
  // the self-mention guard is what stops an endless wake loop — and it is now
  // load-bearing rather than incidental.
  //
  // The resolution is non-obvious and worth pinning: the support agent's
  // identity is (agentName 'hq-support', instanceId 'commonly-support'), and
  // `@commonly-support` resolves through BOTH the instanceId key and the
  // displayName slug to that same pair. isSelfMention compares the pair, so
  // it matches. Rename the display name without thinking and this test is
  // what catches the loop.
  describe('a greeter that names its own handle does not wake itself', () => {
    const supportInstall = {
      agentName: 'hq-support',
      instanceId: 'commonly-support',
      displayName: 'Commonly Support',
    };

    beforeEach(() => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([supportInstall]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      Pod.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ type: 'chat' }) }),
      });
      AgentEvent.countDocuments.mockResolvedValue(0);
      // The sender IS the support agent.
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({
            isBot: true,
            botMetadata: { agentName: 'hq-support', instanceId: 'commonly-support' },
          }),
        }),
      });
    });

    test('the display-slug handle in its own reply enqueues nothing', async () => {
      const res = await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'Happy to help — you can @commonly-support anytime.' },
        userId: 'support-bot-user',
        username: 'Commonly Support',
      });
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
      expect(res.enqueued).toEqual([]);
    });

    test('its bare agentName in its own reply also enqueues nothing', async () => {
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'reach me at @hq-support' },
        userId: 'support-bot-user',
        username: 'Commonly Support',
      });
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });

    test('but a HUMAN using that same handle still reaches the agent', async () => {
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue({ isBot: false }),
        }),
      });
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: '@commonly-support how do I attach an agent?' },
        userId: 'human-1',
        username: 'user-9228',
      });
      expect(AgentEventService.enqueue).toHaveBeenCalledTimes(1);
      const [event] = AgentEventService.enqueue.mock.calls[0];
      expect(event.agentName).toBe('hq-support');
    });
  });

  // ------------------------------------------------------------------
  // #976 — the #508 dampener gates BOTH mention types but used to count
  // only chat.mention, so a bot<->bot thread-mention loop was measured
  // against a counter it could never move.
  // ------------------------------------------------------------------
  describe('#508 mention dampener — event-type coverage (#976)', () => {
    const setup = () => {
      AgentInstallation.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue([
          { agentName: 'smoke-echo', instanceId: 'default', displayName: 'Smoke Echo' },
        ]),
      });
      AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
      // A DIFFERENT bot: the dampener only runs for bot senders, and the
      // self-mention guard must not pre-empt it.
      User.findById.mockReturnValue({
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue({
          _id: 'agent-user-2',
          isBot: true,
          botMetadata: { agentName: 'other-agent', instanceId: 'default' },
        }),
      });
    };

    const mention = (extra = {}) => AgentMentionService.enqueueMentions({
      podId: 'pod-dampen',
      message: { content: '@smoke-echo again', id: 'msg-d1', ...extra },
      userId: 'agent-user-2',
      username: 'other-agent',
    });

    test('the count selects both mention types, not just chat.mention', async () => {
      setup();
      await mention();
      const query = AgentEvent.countDocuments.mock.calls[0][0];
      // The assertion is on the SELECTOR rather than on a suppression,
      // because the defect was invisible in behaviour: with the old query a
      // thread-mention loop simply counted zero forever, and "not dampened"
      // is indistinguishable from "under the threshold".
      expect(query.type).toEqual({ $in: ['chat.mention', 'thread.mention'] });
    });

    // A blanket countDocuments mock cannot express this defect: it returns the
    // same number whatever the query asks for, so the old selector looks
    // healthy. These drive a tiny selector-aware store instead — which is the
    // production failure exactly, a counter reading rows it never selects.
    const withStore = (rows) => {
      AgentEvent.countDocuments.mockImplementation(async (query) => {
        const wanted = query?.type?.$in ?? [query?.type];
        return rows.filter((r) => wanted.includes(r.type)).length;
      });
    };

    test('a thread-mention loop is dampened, where the chat-only counter read zero', async () => {
      setup();
      withStore(Array.from({ length: 4 }, () => ({ type: 'thread.mention' })));

      const res = await mention({
        source: 'thread',
        thread: { postId: 'thread-1', postContent: 'parent' },
      });

      expect(res.enqueued).toEqual([]);
      expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    });

    test('the budget is shared, so alternating surfaces cannot each sit at half of it', async () => {
      // 2 + 2 is over the threshold of 3 together and under it apart. A
      // per-type budget would let this loop run forever with both counters
      // permanently below the line.
      setup();
      withStore([
        { type: 'chat.mention' }, { type: 'chat.mention' },
        { type: 'thread.mention' }, { type: 'thread.mention' },
      ]);

      const chat = await mention();
      const thread = await mention({
        source: 'thread', thread: { postId: 't-2', postContent: 'p' },
      });

      expect(chat.enqueued).toEqual([]);
      expect(thread.enqueued).toEqual([]);
    });
  });
});
