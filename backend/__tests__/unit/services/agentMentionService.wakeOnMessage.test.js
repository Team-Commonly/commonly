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
    expect(wakes[0].payload.messageId).toBe('msg-9');
    // The inline cue is the contract: not named, silence default, claim first.
    expect(wakes[0].payload.content).toContain('Wake-on-message');
    expect(wakes[0].payload.content).toContain('NO_REPLY');
    expect(wakes[0].payload.content).toContain('commonly_claim_message');
    expect(wakes[0].payload.content).toContain('just thinking out loud here');
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

  test('a historic opt-in is disabled as soon as its chat becomes shared', async () => {
    // Config was stamped while the room was personal; another human joining
    // must switch this delivery path to mention-only without reinstalling.
    mockPod('chat', ['user-1', 'seat-a', 'user-2']);
    mockInstallations([install('seat-a', { optIn: true })]);

    const res = await AgentMentionService.enqueueMentions({
      podId: 'pod-1',
      message: { content: 'team update', id: 'msg-7' },
      userId: 'user-1',
      username: 'alice',
    });

    expect(res.woken).toEqual([]);
    expect(wakeCalls()).toHaveLength(0);
  });
});
