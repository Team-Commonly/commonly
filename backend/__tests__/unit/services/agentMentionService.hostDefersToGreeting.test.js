/**
 * The pod host stands down while a person's own agent is greeting them.
 *
 * A person starts their own hosted agent and writes in the same breath. Their
 * message mentions nobody, so the host (scout, opted into wake-on-message)
 * answered it, while the person's agent ran its first-contact greeting. The
 * person got two answers to one first message.
 *
 * A hosted greeting always sees that message: hosted native turns inline the
 * last pod messages, and the unseen-messages hold catches one posted after the
 * turn began. So while that greeting is in flight, the host takes the message
 * as a digest instead of a turn. Every other case keeps today's wake, and a
 * failed lookup wakes the host too (delivery wins when unsure).
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
  exists: jest.fn(),
}));

jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(),
  findPreviousTopLevel: jest.fn().mockResolvedValue(null),
}));

jest.mock('../../../services/neverConnectedMentionService', () => ({
  noteNeverConnectedMention: jest.fn().mockResolvedValue(false),
  noteOfflineMention: jest.fn().mockResolvedValue(false),
  isNeverConnectedAgent: jest.fn().mockResolvedValue(false),
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

const PERSON = 'user-1';

const install = (agentName, { optIn = false } = {}) => ({
  agentName,
  instanceId: 'default',
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

const mockPod = (members = [PERSON, 'scout', 'my-agent']) => {
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members }),
  });
};

const mockHumanSender = () => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: PERSON, isBot: false }),
  });
};

const hostEvent = () => AgentEventService.enqueue.mock.calls
  .map(([args]) => args)
  .find((a) => a.agentName === 'scout' && a.type === 'message.posted');

const post = (content = 'hi, can you help me plan my week?') => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  message: { content, id: 'msg-1' },
  userId: PERSON,
  username: 'alice',
});

describe("the host stands down while the person's own agent greets them (F562)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockHumanSender();
    mockPod();
    AgentEvent.countDocuments.mockResolvedValue(0);
    AgentEvent.exists.mockResolvedValue(null);
    mockInstallations([install('scout', { optIn: true }), install('my-agent')]);
  });

  test("an unaddressed message while the sender's hosted greeting is in flight reaches the host as a digest", async () => {
    AgentEvent.exists.mockResolvedValue({ _id: 'first-contact-1' });

    const res = await post();

    expect(res.woken).not.toContain('scout');
    expect(hostEvent().deliveryMode).toBe('digest');
    // The query names exactly the greeting that covers this message.
    const query = AgentEvent.exists.mock.calls[0][0];
    expect(query).toMatchObject({
      type: 'first_contact',
      'payload.userId': PERSON,
      'payload.hostedGreeting': true,
      agentName: { $ne: 'scout' },
      status: { $in: ['pending', 'folding', 'delivered'] },
    });
    expect(String(query.podId)).toBe('pod-1');
    const age = Date.now() - query.createdAt.$gte.getTime();
    expect(age).toBeGreaterThanOrEqual(AgentMentionService.OWNER_GREETING_WINDOW_MS);
    expect(age).toBeLessThan(AgentMentionService.OWNER_GREETING_WINDOW_MS + 5000);
  });

  test('with no greeting in flight the host wakes as before', async () => {
    const res = await post();

    expect(res.woken).toContain('scout');
    expect(hostEvent().deliveryMode).toBe('wake');
  });

  test('a lookup that fails wakes the host (delivery wins when unsure)', async () => {
    AgentEvent.exists.mockRejectedValue(new Error('mongo down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await post();

    expect(res.woken).toContain('scout');
    expect(hostEvent().deliveryMode).toBe('wake');
    warn.mockRestore();
  });

  test('a person who @mentions the host still gets the host, greeting or not', async () => {
    AgentEvent.exists.mockResolvedValue({ _id: 'first-contact-1' });

    await post('@scout how do I invite a teammate?');

    const mention = AgentEventService.enqueue.mock.calls
      .map(([args]) => args)
      .find((a) => a.agentName === 'scout' && a.type === 'chat.mention');
    expect(mention).toBeDefined();
  });

  test('only the host stands down: another opted-in agent still wakes', async () => {
    mockInstallations([
      install('scout', { optIn: true }),
      install('my-agent'),
      install('helper', { optIn: true }),
    ]);
    AgentEvent.exists.mockResolvedValue({ _id: 'first-contact-1' });

    const res = await post();

    expect(res.woken).toContain('helper');
    expect(res.woken).not.toContain('scout');
  });

  test('a message from an agent never asks the greeting question', async () => {
    User.findById.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue({
        _id: 'bot-1', isBot: true, botMetadata: { agentName: 'helper', instanceId: 'default' },
      }),
    });

    await post();

    expect(AgentEvent.exists).not.toHaveBeenCalled();
  });
});
