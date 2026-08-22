/**
 * Ambient-only scoping, at the pipeline boundary (W-T, TASK-029, 3/4).
 *
 * The set arithmetic lives in threadWakeScopeService and is tested against
 * pg-mem there. This suite tests the HOOK: that `enqueueWakeOnMessage` applies
 * it, applies it only to threaded messages, and — the half that matters most —
 * never lets it touch the addressing path.
 */

jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  constructor: { getLatestPodSummary: jest.fn() }, summarizePodMessages: jest.fn(),
}));
jest.mock('../../../models/AgentEvent', () => ({ countDocuments: jest.fn() }));
jest.mock('../../../services/welcomeWakeService', () => ({ maybeFireWelcomeWake: jest.fn() }));
jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(async (id) => (String(id) === '101' ? { id: 101, user_id: 'bot-1' } : null)),
}));
jest.mock('../../../services/threadWakeScopeService', () => ({
  narrowToThread: jest.fn(async (_root, targets) => targets),
  effectiveFollowerIds: jest.fn(async () => new Set()),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { narrowToThread } = require('../../../services/threadWakeScopeService');

const optIn = (agentName, installedBy) => ({
  agentName, instanceId: 'default', displayName: agentName, installedBy,
  config: { wakeOnMessage: { enabled: true } },
});

const byType = (t) => AgentEventService.enqueue.mock.calls.map(([a]) => a).filter((a) => a.type === t);

const send = (message, extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1', userId: 'user-1', username: 'alice', message, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  narrowToThread.mockImplementation(async (_root, targets) => targets);
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([optIn('seat-a', 'uid-a'), optIn('seat-b', 'uid-b')]),
  });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'bot-1'] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1'] }),
  });
  User.findById.mockImplementation((id) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(String(id) === 'bot-1'
      ? { _id: 'bot-1', isBot: true, botMetadata: { agentName: 'seat-a', instanceId: 'default' } }
      : { _id: 'user-1', isBot: false }),
  }));
  AgentEvent.countDocuments.mockResolvedValue(0);
});

describe('the hook fires only for threaded messages', () => {
  test('an unthreaded message never consults the scope service', async () => {
    await send({ id: 'm1', content: 'just talking' });
    expect(narrowToThread).not.toHaveBeenCalled();
    expect(byType('message.posted')).toHaveLength(2);
  });

  test('a threaded message consults it, with the root and the opt-in list', async () => {
    await send({ id: 'm2', content: 'in a thread', thread_root_id: 101 });
    expect(narrowToThread).toHaveBeenCalledTimes(1);
    const [root, targets, identify] = narrowToThread.mock.calls[0];
    expect(root).toBe(101);
    expect(targets.map((t) => t.agentName)).toEqual(['seat-a', 'seat-b']);
    // Keyed on installedBy — the bot User id thread_user_state holds.
    expect(identify(targets[0])).toBe('uid-a');
  });

  test('the camelCase spelling works too — callers pass either', async () => {
    await send({ id: 'm3', content: 'in a thread', threadRootId: 101 });
    expect(narrowToThread).toHaveBeenCalledTimes(1);
  });
});

describe('scoping narrows delivery, and only delivery', () => {
  test('a non-follower opt-in is dropped', async () => {
    narrowToThread.mockImplementation(async (_r, targets) => targets.filter((t) => t.agentName === 'seat-a'));
    await send({ id: 'm4', content: 'threaded', thread_root_id: 101 });
    expect(byType('message.posted').map((e) => e.agentName)).toEqual(['seat-a']);
  });

  test('a thread nobody follows wakes nobody', async () => {
    narrowToThread.mockImplementation(async () => []);
    await send({ id: 'm5', content: 'threaded', thread_root_id: 101 });
    expect(byType('message.posted')).toHaveLength(0);
  });

  test('CONTROL: the same message unthreaded still wakes both', async () => {
    // Without this, the two tests above pass from a pipeline that wakes nobody.
    narrowToThread.mockImplementation(async () => []);
    await send({ id: 'm6', content: 'not threaded' });
    expect(byType('message.posted')).toHaveLength(2);
  });
});

describe('scoping cannot reach the addressing path', () => {
  // Corrected after the first run. I asserted that a routed message never
  // consults the scope service, on the belief that `isRouted` short-circuits
  // before any ambient fan-out. It does not: there are TWO wake call sites —
  // :1157 for unrouted messages and :1470 for routed ones, the latter waking
  // opt-ins who were not mention targets (excludeKeys = already enqueued).
  //
  // The code was right and the assumption was wrong, and the truth is the
  // better invariant: an addressed message still delivers its chat.mention
  // unconditionally, while the AMBIENT fan-out that accompanies it is scoped
  // like any other ambient traffic. Addressing is untouchable; the ambient
  // companion is not, and should not be.

  test('an @mention in a thread is enqueued even when scoping drops everyone', async () => {
    narrowToThread.mockImplementation(async () => []);
    await send({ id: 'm7', content: '@seat-a look at this', thread_root_id: 101 });

    // The addressing half: unconditional.
    expect(byType('chat.mention').map((e) => e.agentName)).toEqual(['seat-a']);
    // The ambient half: scoped away, correctly. seat-b is an opt-in who does
    // not follow the thread and has not been addressed.
    expect(byType('message.posted')).toHaveLength(0);
  });

  test('a reply edge in a thread likewise still delivers its mention', async () => {
    narrowToThread.mockImplementation(async () => []);
    await send(
      { id: 'm8', content: 'replying', thread_root_id: 101, replyTo: { userId: 'bot-1' } },
      { replyToMessageId: '101' },
    );
    expect(byType('chat.mention')).toHaveLength(1);
    expect(byType('message.posted')).toHaveLength(0);
  });

  test('CONTROL: with scoping permissive, the ambient companion DOES fire', async () => {
    // Proves the two assertions above measure scoping and not a pipeline that
    // simply never fans out alongside a mention.
    narrowToThread.mockImplementation(async (_r, targets) => targets);
    await send({ id: 'm9', content: '@seat-a look at this', thread_root_id: 101 });

    expect(byType('chat.mention').map((e) => e.agentName)).toEqual(['seat-a']);
    // seat-b gets the ambient wake; seat-a is excluded, already addressed.
    expect(byType('message.posted').map((e) => e.agentName)).toEqual(['seat-b']);
  });

  test('a muted seat that is ADDRESSED still gets its mention', async () => {
    // The rule in one case: a mute scopes ambient activity, never addressing.
    narrowToThread.mockImplementation(async () => []);
    await send({ id: 'm10', content: '@seat-a you muted this but I need you', thread_root_id: 101 });
    expect(byType('chat.mention').map((e) => e.agentName)).toEqual(['seat-a']);
  });
});
