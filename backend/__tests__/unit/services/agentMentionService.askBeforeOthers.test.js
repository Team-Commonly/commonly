/**
 * F371: an owner who asked to approve other people's requests gets a card in
 * place of the wake. Their own requests, and every agent whose owner didn't
 * ask, still run straight away.
 */
jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  constructor: { getLatestPodSummary: jest.fn() },
  summarizePodMessages: jest.fn(),
}));
jest.mock('../../../models/AgentEvent', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../services/welcomeWakeService', () => ({ maybeFireWelcomeWake: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({ findById: jest.fn(async () => null) }));
jest.mock('../../../models/pg/ThreadUserState', () => ({
  followByParticipation: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../services/stoppedMentionService', () => ({
  noteStoppedMention: jest.fn().mockResolvedValue(false),
  noteUnreachableAgentDm: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/neverConnectedMentionService', () => ({
  noteNeverConnectedMention: jest.fn().mockResolvedValue(false),
  noteOfflineMention: jest.fn().mockResolvedValue(false),
  isNeverConnectedAgent: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../../services/runRequestService', () => {
  const actual = jest.requireActual('../../../services/runRequestService');
  return {
    ...actual,
    approverFor: jest.fn((...args) => actual.approverFor(...args)),
    holdRunRequest: jest.fn(),
    noteRunRequestRefused: jest.fn(),
  };
});

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { approverFor, holdRunRequest, noteRunRequestRefused } = require('../../../services/runRequestService');
const { maybeFireWelcomeWake } = require('../../../services/welcomeWakeService');

const owner = { _id: 'user-a', username: 'ana', displayName: 'Ana', isBot: false };
const teammate = { _id: 'user-b', username: 'ben', displayName: 'Ben', isBot: false };
const bensAgent = {
  _id: 'bot-9', username: 'pip', isBot: true, botMetadata: { agentName: 'pip', instanceId: 'default', ownerUserId: 'user-b' },
};
const anasOtherAgent = {
  _id: 'bot-8', username: 'kit', isBot: true, botMetadata: { agentName: 'kit', instanceId: 'default', ownerUserId: 'user-a' },
};
const nova = {
  _id: 'bot-1', username: 'nova', isBot: true, botMetadata: { agentName: 'nova', instanceId: 'default' },
};
const people = [owner, teammate, bensAgent, anasOtherAgent, nova];

const chain = (value) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const setup = ({ askBeforeOthers = true, wakeOnMessage = false, installedBy = owner._id } = {}) => {
  const install = {
    agentName: 'nova',
    instanceId: 'default',
    displayName: 'Nova',
    installedBy,
    scopes: ['messages:read', 'messages:write'],
    config: {
      ...(askBeforeOthers ? { askBeforeOthers: { enabled: true } } : {}),
      ...(wakeOnMessage ? { wakeOnMessage: { enabled: true } } : {}),
    },
  };
  AgentInstallation.find.mockReturnValue(chain([install]));
  AgentInstallation.findOne.mockReturnValue(chain(install));
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.find.mockReturnValue(chain([]));
  User.find.mockImplementation((query) => chain(query?._id?.$in ? people.filter((p) => query._id.$in.includes(p._id)) : [nova]));
  User.findById.mockImplementation((id) => chain(people.find((p) => p._id === String(id)) || null));
  User.findOne.mockReturnValue(chain(nova));
  const pod = { _id: 'pod-1', type: 'chat', name: 'Launch', members: people.map((p) => p._id) };
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(pod) }),
    lean: jest.fn().mockResolvedValue(pod),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);
  AgentEventService.enqueue.mockResolvedValue({});
  holdRunRequest.mockResolvedValue(true);
};

const say = (sender, content = '@nova summarize the launch notes', extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  message: { _id: '900', content, createdAt: new Date() },
  userId: sender._id,
  username: sender.username,
  ...extra,
});

const mentionWakes = () => AgentEventService.enqueue.mock.calls.filter(([e]) => e.agentName === 'nova');

beforeEach(() => { jest.clearAllMocks(); });

describe('F371: a request to an agent whose owner asks first', () => {
  it("holds a teammate's @mention as a card for the owner, and runs nothing", async () => {
    setup();
    const result = await say(teammate);
    expect(mentionWakes()).toHaveLength(0);
    expect(holdRunRequest).toHaveBeenCalledTimes(1);
    const [args] = holdRunRequest.mock.calls[0];
    expect(args).toMatchObject({
      ownerUserId: 'user-a',
      requesterUserId: 'user-b',
      requesterName: 'Ben',
      request: '@nova summarize the launch notes',
    });
    expect(args.event).toMatchObject({ agentName: 'nova', type: 'chat.mention' });
    expect(args.event.payload.userId).toBe('user-b');
    expect(result.enqueued).not.toContain('nova');
    expect(result.skipped).toContain('nova:held-for-owner');
  });

  it("runs the owner's own request straight away", async () => {
    setup();
    await say(owner);
    expect(holdRunRequest).not.toHaveBeenCalled();
    expect(mentionWakes()).toHaveLength(1);
  });

  it('runs straight away when the owner never asked', async () => {
    setup({ askBeforeOthers: false });
    await say(teammate);
    expect(holdRunRequest).not.toHaveBeenCalled();
    expect(mentionWakes()).toHaveLength(1);
  });

  it("counts an agent's request as its owner's: Ben's agent is held, Ana's other agent is not", async () => {
    setup();
    await say(bensAgent);
    expect(holdRunRequest).toHaveBeenCalledTimes(1);
    expect(holdRunRequest.mock.calls[0][0].ownerUserId).toBe('user-a');
    expect(mentionWakes()).toHaveLength(0);

    jest.clearAllMocks();
    setup();
    await say(anasOtherAgent);
    expect(holdRunRequest).not.toHaveBeenCalled();
    expect(mentionWakes()).toHaveLength(1);
  });

  it('fails closed: a request that could not be held does not run', async () => {
    setup();
    holdRunRequest.mockRejectedValue(new Error('store down'));
    const result = await say(teammate);
    expect(mentionWakes()).toHaveLength(0);
    expect(result.skipped).toContain('nova:hold-failed');
    // CodeRabbit on #3846: the person who asked is told, beside their request.
    expect(noteRunRequestRefused).toHaveBeenCalledTimes(1);
    expect(noteRunRequestRefused.mock.calls[0][0].event).toMatchObject({ agentName: 'nova', type: 'chat.mention' });
  });

  it('a hold that posted no card tells the asker; a held one does not', async () => {
    setup();
    holdRunRequest.mockResolvedValue(false);
    await say(teammate);
    expect(noteRunRequestRefused).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();
    setup();
    holdRunRequest.mockResolvedValue(true);
    await say(teammate);
    expect(noteRunRequestRefused).not.toHaveBeenCalled();
  });

  it('fails closed when the owner lookup itself fails, and tells the asker', async () => {
    setup();
    const actual = jest.requireActual('../../../services/runRequestService').approverFor;
    approverFor.mockRejectedValue(new Error('users down'));
    try {
      const result = await say(teammate);
      expect(holdRunRequest).not.toHaveBeenCalled();
      expect(mentionWakes()).toHaveLength(0);
      expect(result.skipped).toContain('nova:hold-failed');
      expect(noteRunRequestRefused).toHaveBeenCalledTimes(1);
    } finally {
      approverFor.mockImplementation((...args) => actual(...args));
    }
  });

  it("holds a teammate's reply to the agent, which addresses it without an @", async () => {
    setup();
    await say(teammate, 'and the other one?', {
      replyToMessageId: '899',
      message: { _id: '900', content: 'and the other one?', createdAt: new Date(), replyTo: { userId: nova._id } },
    });
    expect(mentionWakes()).toHaveLength(0);
    expect(holdRunRequest).toHaveBeenCalledTimes(1);
  });

  it("doesn't wake the agent on a teammate's unaddressed message, even with wake-on-message on", async () => {
    setup({ wakeOnMessage: true });
    await say(teammate, 'morning all');
    expect(mentionWakes()).toHaveLength(0);
    expect(holdRunRequest).not.toHaveBeenCalled();
  });

  it("still wakes it on the owner's unaddressed message with wake-on-message on", async () => {
    setup({ wakeOnMessage: true });
    await say(owner, 'morning all');
    expect(mentionWakes()).toHaveLength(1);
  });
  it("doesn't hand a stranger's first message to a greeter that asks first", async () => {
    setup();
    await say(teammate, 'please delete the staging branch');
    expect(maybeFireWelcomeWake).toHaveBeenCalledTimes(1);
    expect(maybeFireWelcomeWake.mock.calls[0][0].installations.map((i) => i.agentName)).not.toContain('nova');

    jest.clearAllMocks();
    setup();
    await say(owner, 'hello everyone');
    expect(maybeFireWelcomeWake.mock.calls[0][0].installations.map((i) => i.agentName)).toContain('nova');
  });

  it('refuses, never runs, a request to an agent that asks first but has no owner to ask', async () => {
    // installedBy is the bot itself, and the bot has no ownerUserId.
    setup({ installedBy: nova._id });
    const result = await say(teammate);
    expect(holdRunRequest).not.toHaveBeenCalled();
    expect(mentionWakes()).toHaveLength(0);
    expect(result.skipped).toContain('nova:hold-failed');
    expect(noteRunRequestRefused).toHaveBeenCalledTimes(1);
  });
});
