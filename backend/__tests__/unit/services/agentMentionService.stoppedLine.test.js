/**
 * F297: the mention and DM paths tell a person when the agent is stopped, and the
 * wake still queues, because that's what answers on Start.
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
jest.mock('../../../services/stoppedMentionService', () => ({ noteStoppedMention: jest.fn() }));
jest.mock('../../../services/neverConnectedMentionService', () => ({
  noteNeverConnectedMention: jest.fn().mockResolvedValue(false),
  isNeverConnectedAgent: jest.fn().mockResolvedValue(false),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { noteStoppedMention } = require('../../../services/stoppedMentionService');

const human = { _id: 'user-1', username: 'priya', isBot: false };
const peer = {
  _id: 'bot-2', username: 'milo', isBot: true, botMetadata: { agentName: 'milo', instanceId: 'default' },
};
const nova = {
  _id: 'bot-1', username: 'nova', isBot: true, botMetadata: { agentName: 'nova', instanceId: 'default' },
};
const installs = [
  { agentName: 'nova', instanceId: 'default', displayName: 'Nova' },
  { agentName: 'milo', instanceId: 'default', displayName: 'Milo' },
];

const chain = (value) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const setup = ({ sender = human, podType = 'chat', members = [human, nova, peer] } = {}) => {
  AgentInstallation.find.mockReturnValue(chain(
    podType === 'chat' ? installs : [{ podId: 'pod-1', installedBy: human._id }],
  ));
  AgentInstallation.findOne.mockReturnValue(chain(installs[0]));
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.find.mockReturnValue(chain([]));
  User.find.mockImplementation((query) => chain(query?._id?.$in ? members.filter((m) => !query.isBot || m.isBot) : [nova]));
  User.findById.mockImplementation((id) => chain(id === nova._id ? nova : sender));
  const pod = { _id: 'pod-1', type: podType, members: members.map((m) => m._id) };
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(pod) }),
    lean: jest.fn().mockResolvedValue(pod),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);
  AgentEventService.enqueue.mockResolvedValue({});
  noteStoppedMention.mockResolvedValue(true);
};

const mention = ({
  sender = human, content = '@nova hello', message = {}, ...extra
} = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  message: {
    _id: '900', content, createdAt: new Date(), ...message,
  },
  userId: sender._id,
  username: sender.username,
  ...extra,
});

beforeEach(() => { jest.clearAllMocks(); });

describe('a mention of a stopped agent', () => {
  it('asks about each agent addressed, and the wake still queues', async () => {
    setup();
    await mention({ content: '@nova @milo hello' });
    expect(noteStoppedMention.mock.calls.map(([args]) => args.agentName).sort()).toEqual(['milo', 'nova']);
    expect(noteStoppedMention.mock.calls[0][0]).toMatchObject({ podId: 'pod-1', messageId: '900' });
    expect(AgentEventService.enqueue.mock.calls.filter(([e]) => e.type === 'chat.mention')).toHaveLength(2);
  });

  it('carries the thread, so the line lands where they asked', async () => {
    setup();
    await mention({ message: { threadRootId: 812 } });
    expect(noteStoppedMention.mock.calls[0][0].threadRootId).toBe(812);
  });

  it('a reply to the agent with no @ counts as addressing it', async () => {
    setup();
    await mention({
      content: 'and the other one?',
      replyToMessageId: '899',
      message: { replyTo: { userId: nova._id } },
    });
    expect(noteStoppedMention.mock.calls.map(([args]) => args.agentName)).toEqual(['nova']);
  });

  it('an agent mentioning it hears nothing: the line is for people', async () => {
    setup({ sender: peer });
    await mention({ sender: peer });
    expect(noteStoppedMention).not.toHaveBeenCalled();
  });

  it('a message nobody addressed asks nothing', async () => {
    setup();
    await mention({ content: 'hello all' });
    expect(noteStoppedMention).not.toHaveBeenCalled();
  });

  it('hands on a plain pod id, because a post passes the ObjectId and Postgres would refuse it', async () => {
    setup();
    await AgentMentionService.enqueueMentions({
      podId: { toString: () => 'pod-1' },
      message: { _id: '900', content: '@nova hello', createdAt: new Date() },
      userId: human._id,
      username: human.username,
    });
    expect(noteStoppedMention.mock.calls[0][0].podId).toBe('pod-1');
  });

  it('a sender nobody can name is not told, as a person would be', async () => {
    setup();
    User.findById.mockImplementation(() => chain(null));
    await mention();
    expect(noteStoppedMention).not.toHaveBeenCalled();
  });

  it('a notice that never finishes holds up neither the send nor the wake', async () => {
    setup();
    noteStoppedMention.mockReturnValue(new Promise(() => {}));
    const result = await mention();
    expect(result.enqueued).toContain('nova');
  });

  it('a failed notice never drops the wake', async () => {
    setup();
    noteStoppedMention.mockRejectedValue(new Error('pg down'));
    const result = await mention();
    expect(result.enqueued).toEqual(['nova']);
    expect(AgentEventService.enqueue).toHaveBeenCalled();
  });
});

describe('a DM to a stopped agent', () => {
  const dm = (sender = human) => AgentMentionService.enqueueDmEvent({
    podId: 'pod-1',
    message: { _id: '901', content: 'hello' },
    userId: sender._id,
    username: sender.username,
  });

  it('tells the person, and the wake still queues', async () => {
    setup({ podType: 'agent-room', members: [human, nova] });
    const result = await dm();
    expect(noteStoppedMention.mock.calls[0][0]).toMatchObject({
      podId: 'pod-1', agentName: 'nova', messageId: '901',
    });
    expect(result.enqueued).toEqual(['nova']);
  });

  it('an agent in a DM with another agent hears nothing', async () => {
    setup({ sender: peer, podType: 'agent-dm', members: [peer, nova] });
    await dm(peer);
    expect(noteStoppedMention).not.toHaveBeenCalled();
  });

  it('a sender nobody can name is not told in a DM either', async () => {
    setup({ podType: 'agent-room', members: [human, nova] });
    User.findById.mockImplementation(() => chain(null));
    await dm();
    expect(noteStoppedMention).not.toHaveBeenCalled();
  });

  it('a notice that never finishes holds up neither the send nor the DM', async () => {
    setup({ podType: 'agent-room', members: [human, nova] });
    noteStoppedMention.mockReturnValue(new Promise(() => {}));
    const result = await dm();
    expect(result.enqueued).toEqual(['nova']);
  });

  it('lands in the thread the person asked in', async () => {
    setup({ podType: 'agent-room', members: [human, nova] });
    await AgentMentionService.enqueueDmEvent({
      podId: 'pod-1',
      message: { _id: '902', content: 'hello', thread_root_id: 77 },
      userId: human._id,
      username: human.username,
    });
    expect(noteStoppedMention.mock.calls[0][0].threadRootId).toBe(77);
  });

  it('a failed notice never drops the DM', async () => {
    setup({ podType: 'agent-room', members: [human, nova] });
    noteStoppedMention.mockRejectedValue(new Error('pg down'));
    const result = await dm();
    expect(result.enqueued).toEqual(['nova']);
  });
});
