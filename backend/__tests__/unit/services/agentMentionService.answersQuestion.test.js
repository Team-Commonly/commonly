/**
 * F390 part B: a person answering the question an agent just asked them
 * addresses that agent, with no @name.
 *
 * Earned 11-09: Scout (wake-on-message) asked a person to paste their slide
 * text, the person pasted it unaddressed, and Scout read the ambient frame and
 * returned NO_REPLY. Adjacency (D6.4) skips wake-on agents and rooms with two
 * people, so it never caught this.
 *
 * The contract, through enqueueMentions:
 *  - the agent asked this person a question in the last top-level message, and
 *    the person replies unaddressed: the agent's event is addressed and framed;
 *  - a different person's message, a message after someone else spoke, or a
 *    previous message with no question: not addressed;
 *  - a question that named the person by @handle counts even when the message
 *    before it was someone else's.
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
  findOne: jest.fn(),
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

const PERSON = '64aaaaaaaaaaaaaaaaaaaaa1';
const OTHER_PERSON = '64aaaaaaaaaaaaaaaaaaaaa2';
const SCOUT_BOT = '64bbbbbbbbbbbbbbbbbbbbb2';
const NOW = new Date('2026-11-09T18:00:00Z');
const ago = (s) => new Date(NOW.getTime() - s * 1000);

const USERS = {
  [PERSON]: { _id: PERSON, isBot: false },
  [OTHER_PERSON]: { _id: OTHER_PERSON, isBot: false },
  [SCOUT_BOT]: { _id: SCOUT_BOT, isBot: true, botMetadata: { agentName: 'scout', instanceId: 'default' } },
};

const leanChain = (value) => ({
  select: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

const QUESTION = {
  id: 79499,
  user_id: SCOUT_BOT,
  created_at: ago(40),
  message_type: 'text',
  content: "Want me to re-score it? Paste the slide text and I'll take a look?",
};
const PERSON_BEFORE = {
  id: 79498, user_id: PERSON, created_at: ago(90), message_type: 'text', content: 'can you score my deck', 
};

// `rows` maps the id a lookup starts before to the top-level message before it.
const setup = (rows) => {
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([{
      agentName: 'scout', instanceId: 'default', displayName: 'Scout', config: { wakeOnMessage: { enabled: true } },
    }]),
  });
  AgentInstallation.findOne.mockReturnValue(leanChain(null));
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: [PERSON, OTHER_PERSON, SCOUT_BOT] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: [PERSON, OTHER_PERSON, SCOUT_BOT] }),
  });
  User.findById.mockImplementation((id) => leanChain(USERS[String(id)] || null));
  User.findOne.mockReturnValue(leanChain(null));
  User.find.mockImplementation((query) => {
    if (query?.isBot) return leanChain([USERS[SCOUT_BOT]]);
    const ids = (query?._id?.$in || []).map(String);
    return leanChain(ids.map((id) => USERS[id]).filter(Boolean));
  });
  PGMessage.findPreviousTopLevel.mockImplementation(async (podId, beforeId) => rows[String(beforeId)] || null);
};

const send = (content, { userId = PERSON, username = 'priya', ...message } = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  userId,
  username,
  message: {
    content, id: '79500', createdAt: NOW, ...message, 
  },
});

const scoutEvent = () => AgentEventService.enqueue.mock.calls.map(([a]) => a)
  .find((a) => a.type === 'message.posted' && a.agentName === 'scout');

describe('a person answering the agent\'s question addresses it (F390 B)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.countDocuments.mockResolvedValue(0);
    maybeFireWelcomeWake.mockResolvedValue({ claimed: false, woke: [] });
  });

  test('the person the question was asked of replies unaddressed: addressed, with the frame', async () => {
    setup({ 79500: QUESTION, 79499: PERSON_BEFORE });
    await send('Slide 1: Commonly is where your agents live');
    const event = scoutEvent();
    expect(event.payload).toMatchObject({ addressed: true, answersYourQuestion: true });
    expect(event.payload.content).toMatch(/^\[This message answers the question YOU just asked this person/);
    expect(event.deliveryMode).toBe('wake');
  });

  test('a different person writes after the question: not addressed', async () => {
    setup({ 79500: QUESTION, 79499: PERSON_BEFORE });
    await send('unrelated, who is around?', { userId: OTHER_PERSON, username: 'omar' });
    expect(scoutEvent().payload.addressed).toBeUndefined();
    expect(scoutEvent().payload.answersYourQuestion).toBeUndefined();
  });

  test('someone else spoke after the question: not addressed', async () => {
    const later = {
      id: 79499, user_id: OTHER_PERSON, created_at: ago(20), message_type: 'text', content: 'hi all', 
    };
    setup({ 79500: later, 79499: QUESTION });
    await send('Slide 1: Commonly is where your agents live');
    expect(scoutEvent().payload.addressed).toBeUndefined();
  });

  test('the agent\'s last message asked nothing: not addressed', async () => {
    setup({ 79500: { ...QUESTION, content: 'Done, the deck scores 7/10.' }, 79499: PERSON_BEFORE });
    await send('ok');
    expect(scoutEvent().payload.addressed).toBeUndefined();
  });

  test('a question mark inside code is not a question', async () => {
    setup({ 79500: { ...QUESTION, content: 'Run `ls -la ?` to see it.' }, 79499: PERSON_BEFORE });
    await send('ok');
    expect(scoutEvent().payload.addressed).toBeUndefined();
  });

  test('a question the agent asked someone else first: not this person\'s to answer', async () => {
    const otherBefore = { ...PERSON_BEFORE, user_id: OTHER_PERSON };
    setup({ 79500: QUESTION, 79499: otherBefore });
    await send('Slide 1: Commonly is where your agents live');
    expect(scoutEvent().payload.addressed).toBeUndefined();
  });

  test('a question that names the person by @handle counts, whoever spoke before it', async () => {
    const otherBefore = { ...PERSON_BEFORE, user_id: OTHER_PERSON };
    setup({ 79500: { ...QUESTION, content: '@priya can you paste the slide text?' }, 79499: otherBefore });
    await send('Slide 1: Commonly is where your agents live');
    expect(scoutEvent().payload).toMatchObject({ addressed: true, answersYourQuestion: true });
  });

  test('a message that @s someone, even a person, is theirs: not an answer', async () => {
    setup({ 79500: QUESTION, 79499: PERSON_BEFORE });
    await send('@omar can you send it to me?');
    expect(scoutEvent().payload.answersYourQuestion).toBeUndefined();
  });

  test('a greeter the welcome wake just reached is not woken twice', async () => {
    setup({ 79500: QUESTION, 79499: PERSON_BEFORE });
    maybeFireWelcomeWake.mockResolvedValue({ claimed: false, woke: ['scout'] });
    await send('Slide 1: Commonly is where your agents live');
    const answered = AgentEventService.enqueue.mock.calls.map(([e]) => e).filter((e) => e.payload?.answersYourQuestion);
    expect(answered).toHaveLength(0);
  });

  test('a thread reply is left to the thread rules', async () => {
    setup({ 79500: QUESTION, 79499: PERSON_BEFORE });
    await send('Slide 1', { thread_root_id: 79400 });
    expect(PGMessage.findPreviousTopLevel).not.toHaveBeenCalledWith('pod-1', '79500', expect.anything());
  });
});
