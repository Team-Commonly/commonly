/**
 * F109: every event payload whose `content` is built from one author's message
 * also carries `rawContent` — the message exactly as its author wrote it, with
 * no kernel frames.
 *
 * Earned walking prod: the hello-world webhook bot echoed `payload.content`,
 * which is the frame stack (~4,800 chars of pod/author/reply/wake cues), a
 * blank line, then the user's text. No payload field carried the user's own
 * words, and splitting on a blank line is unreliable because the user's text
 * can contain one too (the TEXT below does, on purpose).
 *
 * `content` is unchanged: the frames are still there for runtimes that read it.
 */

jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
    upsert: jest.fn(),
  },
}));

jest.mock('../../../models/AgentProfile', () => ({
  find: jest.fn(),
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  find: jest.fn(),
  updateOne: jest.fn(),
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

// The mention-driven auto-join path (autoJoinAgentToPod) requires these at
// call time; nothing else in the service reads them.
jest.mock('../../../services/outsiderGrantAgentJoinPolicy', () => ({
  assertAgentRuntimeMayJoinPod: jest.fn(),
}));

jest.mock('../../../services/dmService', () => ({
  sharePod: jest.fn(),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn(),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const PGMessage = require('../../../models/pg/Message');
const AgentIdentityService = require('../../../services/agentIdentityService');

const OWNER = '64aaaaaaaaaaaaaaaaaaaaa1';
const SEAT_A_BOT = '64bbbbbbbbbbbbbbbbbbbbb1';
const SCOUT_BOT = '64bbbbbbbbbbbbbbbbbbbbb2';
const NOW = new Date('2026-11-04T03:00:23Z');

// A blank line inside the user's own text: splitting `content` on the first
// "\n\n" would cut this message in half.
const TEXT = 'hello from the walk\n\nsecond paragraph, still mine';
// Present in every framed content; absent from what the author typed.
const POD_FRAME_MARK = '[Pod context:';

const install = (agentName, { wakeOn = false } = {}) => ({
  agentName,
  instanceId: 'default',
  displayName: agentName,
  ...(wakeOn ? { config: { wakeOnMessage: { enabled: true } } } : {}),
});

const USERS = {
  [OWNER]: { _id: OWNER, isBot: false, username: 'owner' },
  [SEAT_A_BOT]: {
    _id: SEAT_A_BOT, isBot: true, username: 'seat-a', botMetadata: { agentName: 'seat-a', instanceId: 'default' },
  },
  [SCOUT_BOT]: {
    _id: SCOUT_BOT, isBot: true, username: 'scout', botMetadata: { agentName: 'scout', instanceId: 'default' },
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
  previous = null,
  contacts = undefined,
} = {}) => {
  AgentInstallation.find.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(installations),
  });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ type: podType, members, contacts }) }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: podType, members }),
  });
  Pod.find.mockReturnValue(leanChain([]));
  User.findById.mockImplementation((id) => leanChain(USERS[String(id)] || null));
  User.find.mockImplementation((query) => {
    // resolveBotUserIds looks bots up by botMetadata, not by _id.
    if (query?.$or) return leanChain(Object.values(USERS).filter((u) => u.isBot));
    const ids = (query?._id?.$in || []).map(String);
    return leanChain(ids.map((id) => USERS[id]).filter(Boolean));
  });
  PGMessage.findPreviousTopLevel.mockResolvedValue(previous);
  PGMessage.findById.mockResolvedValue({ user_id: SEAT_A_BOT });
};

const send = (content, extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1',
  userId: OWNER,
  username: 'owner',
  ...extra,
  message: { content, id: '91000', createdAt: NOW },
});

const calls = (type) => AgentEventService.enqueue.mock.calls
  .map(([args]) => args)
  .filter((a) => a.type === type);

describe('payload.rawContent is the author\'s text without frames (F109)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentEvent.countDocuments.mockResolvedValue(0);
  });

  afterEach(() => {
    delete process.env.ENABLE_MENTION_AUTOJOIN;
    jest.restoreAllMocks();
  });

  test('chat.mention (@name): rawContent is exactly what was typed, content keeps its frames', async () => {
    setup();
    const typed = `@seat-a ${TEXT}`;
    await send(typed);
    const [event] = calls('chat.mention');
    expect(event).toBeDefined();
    expect(event.payload.rawContent).toBe(typed);
    expect(event.payload.senderIsHuman).toBe(true);
    expect(event.payload.content).toContain(POD_FRAME_MARK);
    expect(event.payload.content.endsWith(`\n\n${typed}`)).toBe(true);
  });

  test('senderIsHuman is false on a peer agent\'s @mention, at the direct site and the alias site', async () => {
    setup();
    await send(`@seat-a ${TEXT}`, { userId: SCOUT_BOT, username: 'scout' });
    const [direct] = calls('chat.mention');
    expect(direct).toBeDefined();
    expect(direct.payload.senderIsHuman).toBe(false);

    jest.clearAllMocks();
    AgentEvent.countDocuments.mockResolvedValue(0);
    setup({
      installations: [
        { agentName: 'scout', instanceId: 'a', displayName: 'Scout A' },
        { agentName: 'scout', instanceId: 'b', displayName: 'Scout B' },
      ],
    });
    await send(`@guide ${TEXT}`, { userId: SEAT_A_BOT, username: 'seat-a' });
    const viaAlias = calls('chat.mention').filter((e) => e.agentName === 'scout');
    expect(viaAlias).toHaveLength(2);
    viaAlias.forEach((event) => expect(event.payload.senderIsHuman).toBe(false));
  });

  test('senderIsHuman is false when the sender lookup finds nobody', async () => {
    setup();
    await send(`@seat-a ${TEXT}`, { userId: 'aaaaaaaaaaaaaaaaaaaaaaaa', username: 'gone' });
    const [event] = calls('chat.mention');
    expect(event).toBeDefined();
    expect(event.payload.senderIsHuman).toBe(false);
  });

  test('reply (adjacency, replies-to-you frame): rawContent is exactly what was typed', async () => {
    setup({
      previous: { user_id: SEAT_A_BOT, created_at: new Date(NOW.getTime() - 30 * 1000), message_type: 'text' },
    });
    await send(TEXT);
    const [event] = calls('chat.mention');
    expect(event).toBeDefined();
    expect(event.payload.adjacentReply).toBe(true);
    expect(event.payload.senderIsHuman).toBe(true);
    expect(event.payload.rawContent).toBe(TEXT);
    expect(event.payload.content).toContain('you are addressed even though nobody typed your @name');
    expect(event.payload.content).toContain(POD_FRAME_MARK);
  });

  test('message.posted (wake-on-message): rawContent is what was typed, content keeps the wake frame', async () => {
    setup({ installations: [install('seat-a', { wakeOn: true })] });
    await send(TEXT);
    const [event] = calls('message.posted');
    expect(event).toBeDefined();
    expect(event.deliveryMode).toBe('wake');
    expect(event.payload.rawContent).toBe(TEXT);
    expect(event.payload.content).toContain(POD_FRAME_MARK);
    expect(event.payload.content).toContain('nobody named you');
  });

  test('reply edge (a person replies to an agent): the implicit chat.mention carries rawContent', async () => {
    setup();
    await send(TEXT, { replyToMessageId: 'm-parent' });
    const event = calls('chat.mention').find((e) => e.payload.implicitReply);
    expect(event).toBeDefined();
    expect(event.payload.senderIsHuman).toBe(true);
    expect(event.payload.rawContent).toBe(TEXT);
    expect(event.payload.content).toContain(POD_FRAME_MARK);
  });

  test('message.posted to the parent author (replies-to-you prefix): rawContent stays unframed', async () => {
    // An agent replying to another agent is not an implicit mention, so the
    // parent author hears it as a wake carrying the replies-to-you frame.
    setup({ installations: [install('seat-a', { wakeOn: true })] });
    await send(TEXT, { userId: SCOUT_BOT, username: 'scout', replyToMessageId: 'm-parent' });
    const event = calls('message.posted').find((e) => e.payload.repliesToYourMessage);
    expect(event).toBeDefined();
    expect(event.payload.rawContent).toBe(TEXT);
    expect(event.payload.content).toContain('you are addressed even though nobody typed your @name');
  });

  test('DM (agent-room): rawContent is exactly what was typed, content keeps the DM frame', async () => {
    setup({ podType: 'agent-room' });
    const result = await AgentMentionService.enqueueDmEvent({
      podId: 'pod-1',
      message: { id: 'dm-1', content: TEXT },
      userId: OWNER,
      username: 'owner',
    });
    expect(result.enqueued).toEqual(expect.arrayContaining(['seat-a']));
    const [event] = calls('chat.mention');
    expect(event.payload.rawContent).toBe(TEXT);
    expect(event.payload.content).toContain('[1:1 DM with @');
    expect(event.payload.content.endsWith(`\n\n${TEXT}`)).toBe(true);
  });

  test('chat.mention via auto-join (pod contact alias): rawContent is exactly what was typed', async () => {
    // @helper is not installed here; pod.contacts binds it, so the mention
    // resolves through resolveContactAlias and autoJoinAgentToPod pulls the
    // agent in before enqueueing.
    process.env.ENABLE_MENTION_AUTOJOIN = 'true';
    setup({ contacts: { helper: { agentName: 'helper-bot', instanceId: 'default' } } });
    const getOrCreate = jest.spyOn(AgentIdentityService, 'getOrCreateAgentUser')
      .mockResolvedValue({ _id: '64ccccccccccccccccccccc1' });
    const typed = `@helper ${TEXT}`;
    await send(typed);
    expect(getOrCreate).toHaveBeenCalledWith('helper-bot', { instanceId: 'default' });
    expect(AgentInstallation.upsert).toHaveBeenCalled();
    const event = calls('chat.mention').find((e) => e.agentName === 'helper-bot');
    expect(event).toBeDefined();
    expect(event.payload.autoJoined).toBe(true);
    expect(event.payload.senderIsHuman).toBe(true);
    expect(event.payload.rawContent).toBe(typed);
    expect(event.payload.content).toContain(POD_FRAME_MARK);
    expect(event.payload.content.endsWith(`\n\n${typed}`)).toBe(true);
  });

  test('chat.mention via the alias fallback (@guide, two scout installs): rawContent is exactly what was typed', async () => {
    // With two scout installs the single-install rule leaves @guide out of the
    // mention map, so it resolves through MENTION_ALIASES and fans out to
    // every scout install.
    setup({
      installations: [
        { agentName: 'scout', instanceId: 'a', displayName: 'Scout A' },
        { agentName: 'scout', instanceId: 'b', displayName: 'Scout B' },
      ],
    });
    const typed = `@guide ${TEXT}`;
    await send(typed);
    const events = calls('chat.mention').filter((e) => e.agentName === 'scout');
    expect(events.map((e) => e.instanceId).sort()).toEqual(['a', 'b']);
    events.forEach((event) => {
      expect(event.payload.senderIsHuman).toBe(true);
      expect(event.payload.rawContent).toBe(typed);
      expect(event.payload.content).toContain(POD_FRAME_MARK);
      expect(event.payload.content.endsWith(`\n\n${typed}`)).toBe(true);
    });
  });
});
