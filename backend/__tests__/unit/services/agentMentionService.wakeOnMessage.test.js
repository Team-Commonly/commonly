/**
 * ADR-018 D8 — wake-on-message fan-out (agentMentionService.enqueueWakeOnMessage,
 * exercised through enqueueMentions, the module boundary).
 *
 * The contract under test:
 *  - opt-in only: `config.wakeOnMessage.enabled === true`, default OFF
 *  - unrouted messages wake opt-ins as `message.posted` with the inline frame
 *  - mention-enqueued targets are NOT double-delivered
 *  - an agent never wakes on its own post
 *  - bot-authored wake storms are dampened (>MENTION_LOOP_MAX in window);
 *    human-authored messages are never dampened
 *  - DM-shaped pods are excluded (enqueueDmEvent already routes there)
 *  - a wake composes through buildContentForTarget, so it carries the
 *    pod-context frame every other event type gets — and does NOT carry
 *    the two cues gated to chat.mention
 */

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

jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(),
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

const install = (agentName, { optIn = false, instanceId = 'default' } = {}) => ({
  agentName,
  instanceId,
  displayName: agentName,
  ...(optIn ? { config: { wakeOnMessage: { enabled: true } } } : {}),
});

const mockInstallations = (installations) => {
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue(installations),
  });
  AgentProfile.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([]),
  });
};

const mockPod = (type, members = ['user-1', 'seat-a']) => {
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type, members }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type, members }),
  });
};

const mockHumanSender = () => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
  });
};

const mockBotSender = (agentName, instanceId = 'default') => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({
      _id: 'bot-1',
      isBot: true,
      botMetadata: { agentName, instanceId },
    }),
  });
};

const wakeCalls = () => AgentEventService.enqueue.mock.calls
  .map(([args]) => args)
  .filter((a) => a.type === 'message.posted');

const mentionCalls = () => AgentEventService.enqueue.mock.calls
  .map(([args]) => args)
  .filter((a) => a.type === 'chat.mention');

describe('wake-on-message (ADR-018 D8)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHumanSender();
    mockPod('chat');
    AgentEvent.countDocuments.mockResolvedValue(0);
  });

  test('an unrouted message wakes the opted-in install as message.posted with the inline frame', async () => {
    mockInstallations([install('seat-a', { optIn: true })]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'just thinking out loud here', id: 'msg-9' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual(['seat-a']);
    const wakes = wakeCalls();
    expect(wakes).toHaveLength(1);
    expect(wakes[0]).toMatchObject({
      agentName: 'seat-a',
      instanceId: 'default',
      podId: 'pod-1',
      type: 'message.posted',
    });
    expect(wakes[0].payload.wakeOnMessage).toBe(true);
    expect(wakes[0].payload.senderIsHuman).toBe(true);
    expect(wakes[0].payload.messageId).toBe('msg-9');
    // The inline cue is the contract: not named, silence default, claim first.
    expect(wakes[0].payload.content).toContain('Wake-on-message');
    expect(wakes[0].payload.content).toContain('NO_REPLY');
    expect(wakes[0].payload.content).toContain('commonly_claim_message');
    expect(wakes[0].payload.content).toContain('just thinking out loud here');
  });

  test('a shared room wakes every explicitly opted-in installation', async () => {
    mockPod('chat', ['user-1', 'seat-a', 'seat-b', 'seat-c']);
    mockInstallations([
      install('seat-a', { optIn: true }),
      install('seat-b', { optIn: true }),
      install('seat-c'),
    ]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'team update', id: 'msg-shared' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual(['seat-a', 'seat-b']);
    expect(wakeCalls().map((call) => call.agentName)).toEqual(['seat-a', 'seat-b']);
  });

  test('default is OFF: installs without the flag are never woken', async () => {
    mockInstallations([install('seat-a'), install('seat-b')]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'nobody asked anyone anything', id: 'msg-1' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual([]);
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    // Zero-opt-in fast path: no pod-shape lookup was needed at all.
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  test('a mention-enqueued target is not double-delivered; other opt-ins still wake', async () => {
    mockInstallations([
      install('seat-a', { optIn: true }),
      install('seat-b', { optIn: true }),
    ]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'hey @seat-a can you look', id: 'msg-2' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.enqueued).toEqual(['seat-a']);
    expect(res.woken).toEqual(['seat-b']);
    expect(mentionCalls().map((c) => c.agentName)).toEqual(['seat-a']);
    expect(wakeCalls().map((c) => c.agentName)).toEqual(['seat-b']);
  });

  test('an agent never wakes on its own post', async () => {
    mockBotSender('seat-a');
    mockInstallations([
      install('seat-a', { optIn: true }),
      install('seat-b', { optIn: true }),
    ]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'posting my result', id: 'msg-3' },
      userId: 'bot-1',
      username: 'seat-a',
    });

    expect(res.woken).toEqual(['seat-b']);
    expect(wakeCalls().map((c) => c.agentName)).toEqual(['seat-b']);
    expect(wakeCalls()[0].payload.senderIsHuman).toBe(false);
  });

  test('bot-authored wake storms are dampened on the message.posted count', async () => {
    mockBotSender('seat-a');
    mockInstallations([install('seat-b', { optIn: true })]);
    AgentEvent.countDocuments.mockResolvedValue(5); // > MENTION_LOOP_MAX

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'yet another bot post', id: 'msg-4' },
      userId: 'bot-1',
      username: 'seat-a',
    });

    expect(res.woken).toEqual([]);
    expect(wakeCalls()).toHaveLength(0);
    // The dampener counted the WAKE event type, not mentions.
    expect(AgentEvent.countDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'message.posted', agentName: 'seat-b' }),
    );
  });

  test('human-authored messages are never dampened, whatever the count says', async () => {
    mockInstallations([install('seat-b', { optIn: true })]);
    AgentEvent.countDocuments.mockResolvedValue(50);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'human speaking', id: 'msg-5' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual(['seat-b']);
  });

  test('DM-shaped pods are excluded — enqueueDmEvent already routes every message there', async () => {
    mockPod('agent-room');
    mockInstallations([install('seat-a', { optIn: true })]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-dm',
      message: { content: 'dm chatter', id: 'msg-6' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual([]);
    expect(wakeCalls()).toHaveLength(0);
  });

  test('a historic opt-in continues waking after its chat becomes shared', async () => {
    // The installation setting is explicit and revertible. A later member
    // changes who may claim, not whether this opted-in agent wakes.
    mockPod('chat', ['user-1', 'seat-a', 'user-2']);
    mockInstallations([install('seat-a', { optIn: true })]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'team update', id: 'msg-7' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual(['seat-a']);
    expect(wakeCalls().map((call) => call.agentName)).toEqual(['seat-a']);
  });

  // The wake path used to build its own content prefix inline, which is how it
  // went its whole life without the pod-context frame. These pin the routing,
  // not the strings: a frame added to buildContentForTarget must reach wakes,
  // and the two chat.mention-gated cues must keep NOT reaching them.
  describe('frame composition', () => {
    const wakeContent = async (installations, message = { content: 'body text', id: 'msg-f' }) => {
      mockInstallations(installations);
      await AgentMentionService.enqueueMentions({
        podId: 'pod-1', message, userId: 'user-1', username: 'alice',
      });
      return wakeCalls()[0].payload.content;
    };

    test('a wake carries the pod-context frame, with this pod id and the post-as-yourself rule', async () => {
      const content = await wakeContent([install('seat-a', { optIn: true })]);

      expect(content).toContain('Pod context: this conversation is in pod `pod-1`');
      // The podId has to be interpolated into the tool signature, not merely
      // mentioned — that call is the reason the frame is inline rather than
      // metadata.
      expect(content).toContain('commonly_attach_file({ podId: "pod-1"');
      // The safety half: without it a woken agent can post through an
      // operator profile and misattribute the turn to a human.
      expect(content).toContain('Post as yourself only');
    });

    test('the wake frame stays last before the body', async () => {
      const content = await wakeContent([install('seat-a', { optIn: true })]);

      // Presence asserted before order: indexOf returns -1 for an absent
      // frame, and -1 is less than every real index, so an ordering
      // assertion alone goes green on exactly the bug being fixed.
      const podAt = content.indexOf('Pod context:');
      const authorAt = content.indexOf('Trigger:');
      const wakeAt = content.indexOf('Wake-on-message:');
      expect(podAt).toBeGreaterThanOrEqual(0);
      expect(authorAt).toBeGreaterThanOrEqual(0);
      expect(wakeAt).toBeGreaterThanOrEqual(0);
      expect(podAt).toBeLessThan(authorAt);
      expect(authorAt).toBeLessThan(wakeAt);
      expect(content).toMatch(/\[Wake-on-message:[^\]]*\]\n\nbody text$/);
    });

    test('the collab cue reaches a mention but not a wake raised by the same message', async () => {
      // Both seats are non-utility installs in a non-DM pod, so the pod
      // qualifies under isCollaborativePod — and the mention half proves it
      // did. Without that control, `not.toContain` would also pass on a pod
      // that simply failed the heuristic, which is not what is being tested.
      mockPod('chat', ['user-1', 'seat-a', 'seat-b']);
      mockInstallations([
        install('seat-a', { optIn: true }),
        install('seat-b', { optIn: true }),
      ]);

      await AgentMentionService.enqueueMentions({
        podId: 'pod-1',
        message: { content: 'hey @seat-a can you look', id: 'msg-c' },
        userId: 'user-1',
        username: 'alice',
      });

      const mention = mentionCalls().find((c) => c.agentName === 'seat-a');
      const wake = wakeCalls().find((c) => c.agentName === 'seat-b');
      expect(mention).toBeDefined();
      expect(wake).toBeDefined();

      expect(mention.payload.content).toContain('Collaborative pod:');
      expect(mention.payload.content).toContain('Reply mechanics:');
      expect(wake.payload.content).not.toContain('Collaborative pod:');
      expect(wake.payload.content).not.toContain('Reply mechanics:');
      // Same pod, same message, and the wake still gets the unconditional
      // frame — so the two cues above are withheld by their event-type gate,
      // not by the wake missing frames wholesale.
      expect(wake.payload.content).toContain('Pod context: this conversation is in pod `pod-1`');
    });

    test('the consultation cue follows its own specialist gate, not the event type', async () => {
      const generalist = await wakeContent([install('seat-a', { optIn: true })]);
      expect(generalist).toContain('Collaboration: for code-heavy work');

      jest.clearAllMocks();
      mockHumanSender();
      mockPod('chat', ['user-1', 'codex']);
      AgentEvent.countDocuments.mockResolvedValue(0);

      const specialist = await wakeContent([install('codex', { optIn: true })]);
      expect(specialist).not.toContain('Collaboration: for code-heavy work');
      expect(specialist).toContain('Wake-on-message:');
    });
  });
});

// Reply-evidence flag (interim for TASK-058): a bot's reply reaches the
// replied-to agent as message.posted (the isBot gate keeps the implicit
// chat.mention path human-only), but the fan-out stamps per-target evidence
// so the wrapper can treat "replies to MY message" as addressed instead of
// standing down on the replier's own claim (Sage stood down twice on
// Anvil's thread replies, observed live 2026-08-24).
const PGMessage = require('../../../models/pg/Message');

describe('wake-on-message reply evidence (repliesToYourMessage)', () => {
  const mockBotUserRows = (rows) => {
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue(rows),
      }),
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockPod('chat');
    AgentEvent.countDocuments.mockResolvedValue(0);
    // Bot sender: anvil replies to sage's message.
    mockBotSender('anvil', 'anvil-seo-engineer');
    PGMessage.findById.mockResolvedValue({ user_id: 'sage-bot-user-id' });
    mockBotUserRows([
      { _id: 'sage-bot-user-id', botMetadata: { agentName: 'sage', instanceId: 'sage-seo-lead' } },
      { _id: 'quill-bot-user-id', botMetadata: { agentName: 'quill', instanceId: 'quill-seo-writer' } },
    ]);
  });

  test('the parent author gets the flag and the inline frame; bystanders get neither', async () => {
    mockInstallations([
      install('sage', { optIn: true, instanceId: 'sage-seo-lead' }),
      install('quill', { optIn: true, instanceId: 'quill-seo-writer' }),
    ]);

    await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'audit follow-up detail', id: 'm-77' },
      userId: 'anvil-bot-user-id',
      username: 'Anvil (SEO engineer)',
      replyToMessageId: 'm-root-42',
    });

    const wakes = wakeCalls();
    const sage = wakes.find((w) => w.agentName === 'sage');
    const quill = wakes.find((w) => w.agentName === 'quill');
    expect(sage).toBeDefined();
    expect(quill).toBeDefined();
    // The flag is the wrapper's claim-decision input…
    expect(sage.payload.repliesToYourMessage).toBe(true);
    expect(quill.payload.repliesToYourMessage).toBeUndefined();
    // …and the inline frame is what the model actually reads.
    expect(sage.payload.content).toContain('replies to YOUR earlier message');
    expect(sage.payload.content).toContain('NO_REPLY');
    expect(quill.payload.content).not.toContain('replies to YOUR earlier message');
  });

  test('a parent-author lookup failure degrades to plain ambient wakes, never to silence', async () => {
    PGMessage.findById.mockRejectedValue(new Error('pg down'));
    mockInstallations([install('sage', { optIn: true, instanceId: 'sage-seo-lead' })]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'still delivered', id: 'm-78' },
      userId: 'anvil-bot-user-id',
      username: 'Anvil (SEO engineer)',
      replyToMessageId: 'm-root-42',
    });

    expect(res.woken).toEqual(['sage']);
    const wake = wakeCalls()[0];
    expect(wake.payload.repliesToYourMessage).toBeUndefined();
    expect(wake.payload.content).toContain('Wake-on-message');
  });

  test('a human reply still routes via the implicit mention path, not the flag', async () => {
    // findById serves TWO lookups here: the sender (human) and the reply
    // author (sage's bot row, so resolveImplicitReplyTarget can address it).
    User.findById.mockImplementation((id) => ({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue(id === 'sage-bot-user-id'
        ? { _id: 'sage-bot-user-id', isBot: true, botMetadata: { agentName: 'sage', instanceId: 'sage-seo-lead' } }
        : { _id: 'user-1', isBot: false }),
    }));
    mockInstallations([install('sage', { optIn: true, instanceId: 'sage-seo-lead' })]);

    await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'what do you think?', id: 'm-79', replyTo: { userId: 'sage-bot-user-id' } },
      userId: 'user-1',
      username: 'sam',
      replyToMessageId: 'm-root-42',
    });

    // The mention path claimed the target (stronger cue), so the fan-out
    // excluded it: no double delivery, and the flag never fires for humans.
    expect(mentionCalls()).toHaveLength(1);
    expect(wakeCalls()).toHaveLength(0);
  });
});
