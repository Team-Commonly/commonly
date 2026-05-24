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
});
