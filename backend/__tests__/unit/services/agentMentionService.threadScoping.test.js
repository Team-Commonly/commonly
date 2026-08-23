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
  findById: jest.fn(async (id) => (String(id) === '101' ? { id: 101, user_id: 'bot-user-a' } : null)),
}));
jest.mock('../../../models/pg/ThreadUserState', () => ({
  followByParticipation: jest.fn(),
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
const ThreadUserState = require('../../../models/pg/ThreadUserState');
const PGMessage = require('../../../models/pg/Message');

// `installedBy` is deliberately a DIFFERENT id from the bot's User row here.
// It is the human installer on five of the write paths (podController:119,
// personaHireService:93, podCurationService:147, authController:201,
// agentProfile:259) and the bot itself on the rest — so a fixture where the
// two coincide cannot tell a correct key from the wrong one. These differ so
// the assertion below discriminates.
const optIn = (agentName, installedBy) => ({
  agentName,
  instanceId: 'default',
  displayName: agentName,
  installedBy,
  config: { wakeOnMessage: { enabled: true } },
});

// ONE id per agent across the whole fixture. @sprint-review (57037): seat-a
// used to be `bot-1` through User.findById (as the thread root's author) and
// `bot-user-a` through User.find (as a wake target) — the same agent with two
// identities depending on which lookup you went through. Nothing asserted the
// difference, so nothing failed; but a later test asking "is the seat that
// authored the root scoped out?" would have got contradictory answers from
// the two paths and read it as a scoping bug rather than a fixture bug.
//
// That is the same shape as the defect this suite exists for: an identity
// fixture that quietly disagrees with itself cannot discriminate a correct
// key from a wrong one.
const BOT_USER_ROWS = [
  { _id: 'bot-user-a', botMetadata: { agentName: 'seat-a', instanceId: 'default' } },
  { _id: 'bot-user-b', botMetadata: { agentName: 'seat-b', instanceId: 'default' } },
];

const byType = (t) => AgentEventService.enqueue.mock.calls.map(([a]) => a).filter((a) => a.type === t);

const send = (message, extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1', userId: 'user-1', username: 'alice', message, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  narrowToThread.mockImplementation(async (_root, targets) => targets);
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([
      optIn('seat-a', 'human-installer-a'), optIn('seat-b', 'human-installer-b'),
    ]),
  });
  User.find.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(BOT_USER_ROWS) }),
  });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'bot-user-a'] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1'] }),
  });
  User.findById.mockImplementation((id) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(String(id) === 'bot-user-a'
      ? { _id: 'bot-user-a', isBot: true, botMetadata: { agentName: 'seat-a', instanceId: 'default' } }
      : { _id: 'user-1', isBot: false }),
  }));
  AgentEvent.countDocuments.mockResolvedValue(0);
  ThreadUserState.followByParticipation.mockResolvedValue(true);
});

describe('the fixture agrees with itself about who seat-a is', () => {
  // @sprint-review (57037) found seat-a carrying two ids: `bot-1` through
  // User.findById and `bot-user-a` through User.find. Renaming them to match
  // is hygiene, and hygiene drifts — probed it, and reintroducing the split
  // passes 18/18, so nothing here would have caught it coming back.
  //
  // This is that consistency made executable. It is a test ABOUT THE FIXTURE,
  // which is unusual and deliberate: the suite's whole subject is which id a
  // seat is keyed by, so a fixture that disagrees with itself cannot tell a
  // correct key from a wrong one — exactly the defect that let `installedBy`
  // look right for as long as it did.
  test('the root author resolves to the same id User.find maps seat-a to', async () => {
    const viaFind = BOT_USER_ROWS
      .find((r) => r.botMetadata.agentName === 'seat-a')._id;

    const rootAuthorId = (await PGMessage.findById('101')).user_id;
    const viaFindById = await User.findById(rootAuthorId).select().lean();

    expect(viaFindById.botMetadata.agentName).toBe('seat-a');
    expect(viaFindById._id).toBe(viaFind);
    expect(rootAuthorId).toBe(viaFind);
  });
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
    // The BOT's User row id, which is what thread_user_state.user_id holds —
    // NOT `installedBy`, which on this fixture is the human who installed it.
    expect(identify(targets[0])).toBe('bot-user-a');
    expect(identify(targets[1])).toBe('bot-user-b');
    expect(identify(targets[0])).not.toBe(targets[0].installedBy);
  });

  test('an install whose bot User row is missing keys to null, so it is KEPT', async () => {
    // narrowToThread's contract: an unclassifiable target degrades to today's
    // delivery rather than to silence. That only holds if `identify` says
    // "unknown" instead of guessing a plausible id.
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue([BOT_USER_ROWS[0]]) }),
    });
    await send({ id: 'm2b', content: 'in a thread', thread_root_id: 101 });
    const [, targets, identify] = narrowToThread.mock.calls[0];
    expect(identify(targets[0])).toBe('bot-user-a');
    expect(identify(targets[1])).toBeNull();
  });

  test('the lookup fails closed to unscoped delivery, never to silence', async () => {
    // A resolution failure must not drop wakes. Empty map -> every identify
    // returns null -> narrowToThread keeps everyone.
    User.find.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockRejectedValue(new Error('mongo down')) }),
    });
    await send({ id: 'm2c', content: 'in a thread', thread_root_id: 101 });
    const [, targets, identify] = narrowToThread.mock.calls[0];
    expect(identify(targets[0])).toBeNull();
    expect(identify(targets[1])).toBeNull();
    expect(byType('message.posted')).toHaveLength(2);
  });

  test('one query for the whole target list, not one per target', async () => {
    await send({ id: 'm2d', content: 'in a thread', thread_root_id: 101 });
    expect(User.find).toHaveBeenCalledTimes(1);
    const [filter] = User.find.mock.calls[0];
    expect(filter.isBot).toBe(true);
    expect(filter.$or).toHaveLength(2);
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
      {
        id: 'm8', content: 'replying', thread_root_id: 101, replyTo: { userId: 'bot-user-a' }, 
      },
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

describe('a delivered thread mention follows by participation', () => {
  test('the shared delivery record follows the BOT user only after its mention enqueues', async () => {
    await send({ id: 'm11', content: '@seat-a please review', thread_root_id: 101 });

    expect(ThreadUserState.followByParticipation).toHaveBeenCalledTimes(1);
    expect(ThreadUserState.followByParticipation).toHaveBeenCalledWith(101, 'bot-user-a', 'pod-1');

    const mentionCall = AgentEventService.enqueue.mock.calls.find(
      ([event]) => event.type === 'chat.mention' && event.agentName === 'seat-a',
    );
    expect(mentionCall).toBeDefined();
    expect(ThreadUserState.followByParticipation.mock.invocationCallOrder[0])
      .toBeGreaterThan(AgentEventService.enqueue.mock.invocationCallOrder[
        AgentEventService.enqueue.mock.calls.indexOf(mentionCall)
      ]);
  });

  test('a delivery failure cannot create a follow for an address that was never delivered', async () => {
    AgentEventService.enqueue.mockRejectedValueOnce(new Error('queue down'));
    await send({ id: 'm12', content: '@seat-a please review', thread_root_id: 101 });

    expect(ThreadUserState.followByParticipation).not.toHaveBeenCalled();
  });

  test('a follow-write failure is visible but cannot fail a send whose address already delivered', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    ThreadUserState.followByParticipation.mockRejectedValueOnce(new Error('pg down'));

    await expect(send({ id: 'm12b', content: '@seat-a please review', thread_root_id: 101 }))
      .resolves.toMatchObject({ enqueued: ['seat-a'] });

    expect(warn).toHaveBeenCalledWith(
      '[thread-follow] mention delivery succeeded but follow write failed:',
      'pg down',
    );
    warn.mockRestore();
  });

  test('a reply edge is addressing, not an explicit mention, so it does not create a follow', async () => {
    await send(
      {
        id: 'm13', content: 'replying', thread_root_id: 101, replyTo: { userId: 'bot-user-a' },
      },
      { replyToMessageId: '101' },
    );

    expect(byType('chat.mention')).toHaveLength(1);
    expect(ThreadUserState.followByParticipation).not.toHaveBeenCalled();
  });

  test('CONTROL: the same successful mention outside a thread does not create thread state', async () => {
    await send({ id: 'm14', content: '@seat-a please review' });

    expect(byType('chat.mention')).toHaveLength(1);
    expect(ThreadUserState.followByParticipation).not.toHaveBeenCalled();
  });
});
