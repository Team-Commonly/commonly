/**
 * ADR-018 D6.4: adjacency is addressing, in a room with one person.
 *
 * Earned 2026-10-20: an outside signup's hosted agent greeted them in their own
 * new pod, ending on an invitation to reply. They replied with no @name, and
 * nothing heard it: the install was never opted into wake-on-message, and no
 * other rule routed the message.
 *
 * The contract, exercised through enqueueMentions (the module boundary):
 *  - a person alone with their agents, answering the agent that spoke last
 *    within 30 minutes, reaches exactly that agent as one chat.mention carrying
 *    the replies-to-you frame;
 *  - a second person, an older or human or system previous message, a thread
 *    reply, or a DM-shaped pod: nothing;
 *  - an @mention or a reply edge is addressing already, and adjacency adds
 *    nothing on top;
 *  - a wake-on agent already hears every message, so it is not delivered twice;
 *  - with no agent adjacency could reach, it costs no query at all.
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
  findPreviousTopLevel: jest.fn(),
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
const PGMessage = require('../../../models/pg/Message');
const { maybeFireWelcomeWake } = require('../../../services/welcomeWakeService');

const OWNER = '64aaaaaaaaaaaaaaaaaaaaa1';
const SECOND_HUMAN = '64aaaaaaaaaaaaaaaaaaaaa2';
const SEAT_A_BOT = '64bbbbbbbbbbbbbbbbbbbbb1';
const SCOUT_BOT = '64bbbbbbbbbbbbbbbbbbbbb2';
const PERSON_WITH_STALE_BOT_METADATA = '64aaaaaaaaaaaaaaaaaaaaa3';
const NOW = new Date('2026-10-20T03:00:23Z');

const install = (agentName, { wakeOn = false } = {}) => ({
  agentName,
  instanceId: 'default',
  displayName: agentName,
  ...(wakeOn ? { config: { wakeOnMessage: { enabled: true } } } : {}),
});

const USERS = {
  [OWNER]: { _id: OWNER, isBot: false },
  [SECOND_HUMAN]: { _id: SECOND_HUMAN, isBot: false },
  [SEAT_A_BOT]: { _id: SEAT_A_BOT, isBot: true, botMetadata: { agentName: 'seat-a', instanceId: 'default' } },
  [SCOUT_BOT]: { _id: SCOUT_BOT, isBot: true, botMetadata: { agentName: 'scout', instanceId: 'default' } },
  // A person whose row still carries an agent's metadata: isBot is what decides.
  [PERSON_WITH_STALE_BOT_METADATA]: {
    _id: PERSON_WITH_STALE_BOT_METADATA, isBot: false, botMetadata: { agentName: 'seat-a', instanceId: 'default' },
  },
};

const leanChain = (value) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const setup = ({
  installations = [install('seat-a')],
  podType = 'chat',
  members = [OWNER, SEAT_A_BOT],
  previous = { user_id: SEAT_A_BOT, created_at: new Date(NOW.getTime() - 51 * 1000), message_type: 'text' },
} = {}) => {
  AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(installations) });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ type: podType, members }) }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: podType, members }),
  });
  User.findById.mockImplementation((id) => leanChain(USERS[String(id)] || null));
  User.find.mockImplementation((query) => {
    const ids = (query?._id?.$in || []).map(String);
    return leanChain(ids.map((id) => USERS[id]).filter(Boolean));
  });
  PGMessage.findPreviousTopLevel.mockResolvedValue(previous);
};

// Scalars above the spread so an arm can override them; `message` below it, so
// a `message` override merges into the default message instead of replacing it
// (sprint-review on #2359: spread last, the thread arm lost its id and returned
// before the thread guard was reached).
const send = (content, extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  userId: OWNER,
  username: 'owner',
  ...extra,
  message: { content, id: '79500', createdAt: NOW, ...extra.message },
});

const calls = (type) => AgentEventService.enqueue.mock.calls.map(([args]) => args).filter((a) => a.type === type);

describe('adjacency is addressing in a one-person room (ADR-018 D6.4)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.countDocuments.mockResolvedValue(0);
    maybeFireWelcomeWake.mockResolvedValue({ claimed: false, woke: [] });
  });

  test('the person answering the agent that just spoke reaches exactly that agent, framed as a reply to it', async () => {
    setup();
    const res = await send('كيف أبدأ؟');

    const mentions = calls('chat.mention');
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agentName).toBe('seat-a');
    expect(mentions[0].payload.content).toMatch(/^\[This message replies to YOUR earlier message — you are addressed even though nobody typed your @name/);
    expect(mentions[0].payload.content).toContain('كيف أبدأ؟');
    expect(mentions[0].payload).toMatchObject({ messageId: '79500', implicitReply: true, adjacentReply: true });
    expect(res.implicit).toEqual(['seat-a']);
    expect(calls('message.posted')).toHaveLength(0);
    expect(PGMessage.findPreviousTopLevel).toHaveBeenCalledWith('pod-1', '79500', new Date(NOW.getTime() - 30 * 60 * 1000));
  });

  test('a second person in the room: nothing, because the line may be for them', async () => {
    setup({ members: [OWNER, SECOND_HUMAN, SEAT_A_BOT] });
    const res = await send('what do you both think?');
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(res.implicit).toEqual([]);
  });

  test('a wake-on agent already hears the message: one ambient wake, no second delivery', async () => {
    setup({ installations: [install('seat-a', { wakeOn: true })] });
    const res = await send('thanks, and next?');
    expect(calls('chat.mention')).toHaveLength(0);
    expect(calls('message.posted').map((c) => c.agentName)).toEqual(['seat-a']);
    expect(res.woken).toEqual(['seat-a']);
    // With nothing adjacency could reach, it reads nothing.
    expect(PGMessage.findPreviousTopLevel).not.toHaveBeenCalled();
  });

  test.each([
    ['the person\'s own', { user_id: OWNER, created_at: new Date(NOW.getTime() - 5000), message_type: 'text' }],
    ['older than 30 minutes', { user_id: SEAT_A_BOT, created_at: new Date(NOW.getTime() - 31 * 60 * 1000), message_type: 'text' }],
    ['a system notice', { user_id: SEAT_A_BOT, created_at: new Date(NOW.getTime() - 5000), message_type: 'system' }],
    ['absent (first message in the pod)', null],
  ])('a previous message that is %s: nothing', async (_label, previous) => {
    setup({ previous });
    await send('hello?');
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    // Each of these is refused from the previous row alone: the only User
    // lookup is the sender's own, never the previous author's.
    expect(User.findById).toHaveBeenCalledTimes(1);
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  test('a previous message by a person whose row carries agent metadata: nothing, isBot decides', async () => {
    setup({
      members: [OWNER, PERSON_WITH_STALE_BOT_METADATA, SEAT_A_BOT],
      previous: { user_id: PERSON_WITH_STALE_BOT_METADATA, created_at: new Date(NOW.getTime() - 5000), message_type: 'text' },
    });
    await send('hello?');
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(Pod.findById).not.toHaveBeenCalled();
  });

  test('a previous message from an agent no longer installed here: nothing', async () => {
    setup({ installations: [install('other-seat')] });
    await send('hello?');
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
  });

  test('a thread reply is not adjacent to the room', async () => {
    setup();
    await send('in the thread', { message: { thread_root_id: 79400 } });
    expect(AgentEventService.enqueue).not.toHaveBeenCalled();
    expect(PGMessage.findPreviousTopLevel).not.toHaveBeenCalled();
  });

  test('a DM-shaped pod is left to the DM path', async () => {
    setup({ podType: 'agent-room' });
    await send('hi');
    expect(calls('chat.mention')).toHaveLength(0);
  });

  test('an explicit @mention wins: the named agent is addressed, the last speaker is not', async () => {
    setup({
      installations: [install('seat-a'), install('scout')],
      members: [OWNER, SEAT_A_BOT, SCOUT_BOT],
    });
    await send('@scout can you take this one?');
    const mentions = calls('chat.mention');
    expect(mentions.map((m) => m.agentName)).toEqual(['scout']);
    expect(mentions[0].payload.adjacentReply).toBeUndefined();
    expect(PGMessage.findPreviousTopLevel).not.toHaveBeenCalled();
  });

  test('a reply edge wins: its target is addressed, and adjacency is not consulted', async () => {
    setup({
      installations: [install('seat-a'), install('scout')],
      members: [OWNER, SEAT_A_BOT, SCOUT_BOT],
    });
    PGMessage.findById.mockResolvedValue({ user_id: SCOUT_BOT });
    await send('yes, that one', { replyToMessageId: '79300' });
    const mentions = calls('chat.mention');
    expect(mentions.map((m) => m.agentName)).toEqual(['scout']);
    expect(mentions[0].payload.implicitReply).toBe(true);
    expect(mentions[0].payload.adjacentReply).toBeUndefined();
    expect(PGMessage.findPreviousTopLevel).not.toHaveBeenCalled();
  });

  test('the last speaker gets it even when its post was to another agent', async () => {
    // Scout's last post was addressed to seat-a, not to the person. Adjacency
    // follows who spoke last, not whom they spoke to: the person is answering
    // what is on their screen, which is Scout's line.
    setup({
      installations: [install('seat-a'), install('scout')],
      members: [OWNER, SEAT_A_BOT, SCOUT_BOT],
      previous: { user_id: SCOUT_BOT, created_at: new Date(NOW.getTime() - 20 * 1000), message_type: 'text' },
    });
    await send('ok, go ahead');
    expect(calls('chat.mention').map((m) => m.agentName)).toEqual(['scout']);
  });

  test('when the last speaker is a wake-on Scout, Scout hears it once, ambiently, and no one else is addressed', async () => {
    setup({
      installations: [install('seat-a'), install('scout', { wakeOn: true })],
      members: [OWNER, SEAT_A_BOT, SCOUT_BOT],
      previous: { user_id: SCOUT_BOT, created_at: new Date(NOW.getTime() - 20 * 1000), message_type: 'text' },
    });
    const res = await send('ok, go ahead');
    expect(calls('chat.mention')).toHaveLength(0);
    expect(res.woken).toEqual(['scout']);
  });

  test('an agent the welcome wake already reached is not addressed a second time', async () => {
    setup();
    maybeFireWelcomeWake.mockResolvedValue({ claimed: true, woke: ['seat-a'] });
    await send('hi there');
    expect(calls('chat.mention')).toHaveLength(0);
  });

  test('a bot sender never triggers adjacency', async () => {
    setup();
    User.findById.mockImplementation((id) => leanChain(String(id) === OWNER ? USERS[SCOUT_BOT] : (USERS[String(id)] || null)));
    await send('agent chatter');
    expect(calls('chat.mention')).toHaveLength(0);
    expect(PGMessage.findPreviousTopLevel).not.toHaveBeenCalled();
  });
});
