/**
 * A human @handle routes nothing (TASK-070a / TASK-074, follow-up to #1244).
 *
 * #1244 added a paragraph to the pod-context frame telling every agent that a
 * human's handle "is necessary and not sufficient — it flags the message in a
 * mentions filter the human pulls; nothing pushes". That is an assertion about
 * the kernel, made to a reader who cannot check it: an agent acts on the cue
 * and has no view of `enqueueMentions`.
 *
 * #1244's three tests pin the SENTENCE (`toContain('nothing pushes')`). They go
 * red if someone rewords the cue and stay green if someone makes it false. This
 * file pins the other half: the behaviour the sentence describes.
 *
 * Two mechanisms, stated separately because they can break separately:
 *
 *  1. A handle that resolves to a human enqueues no `AgentEvent` of any type.
 *     `enqueueMentions` has no human delivery branch at all — the handle is
 *     filtered into `humanMentionHandles` and never reaches an enqueue. The
 *     realistic future edit is TASK-070b (should a bare name route?): an
 *     implementer who answers "yes, and push it" makes the cue a lie taught on
 *     every wake, fleet-wide, and nothing in the suite objects.
 *
 *  2. Even the thread-follow half is narrower than the cue's readers assume:
 *     `resolveHumanMentionUserIds` is called only inside `if (threadRootId)`,
 *     so a plain channel post materialises no state for the mentioned human.
 *     Hoisting that call out of the guard is the consistency fix that looks
 *     correct and quietly widens what a handle does.
 *
 * Every negative here is paired with a control, per the house rule: an
 * assertion that nothing was enqueued is worthless from a harness that cannot
 * enqueue anything.
 */

jest.mock('../../../services/agentEventService', () => ({ enqueue: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { find: jest.fn(), findOne: jest.fn() },
}));
jest.mock('../../../models/AgentProfile', () => ({ find: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
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

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const ThreadUserState = require('../../../models/pg/ThreadUserState');

const SEAT = { agentName: 'seat-a', instanceId: 'default', displayName: 'Seat A' };
const HUMAN = { _id: 'user-sam', username: 'sam' };

const mockInstallations = (installations) => {
  AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(installations) });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
};

// The human-handle resolver. MOCKED DELIBERATELY and load-bearing: `sam` is a
// real non-bot row inside the pod, so anything that hands this handle to a
// delivery path WILL find a user to deliver to. A harness where the lookup
// returns nothing would pass every negative below for the wrong reason.
const mockUserLookup = () => {
  User.find.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue([HUMAN]),
  });
  User.findById.mockImplementation(() => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: 'user-1', isBot: false }),
  }));
};

const enqueued = () => AgentEventService.enqueue.mock.calls.map(([a]) => a);
const mentions = () => enqueued().filter((a) => a.type === 'chat.mention');

const send = (message, extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1', userId: 'user-1', username: 'alice', message, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUserLookup();
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'user-sam', 'bot-1'] }),
    }),
    lean: jest.fn().mockResolvedValue({
      _id: 'pod-1', type: 'chat', members: ['user-1', 'user-sam', 'bot-1'],
    }),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);
  mockInstallations([SEAT]);
});

describe('a human handle is not a delivery target', () => {
  test('@handle for a human enqueues no event of any kind', async () => {
    await send({ id: 'm-1', content: 'can you decide this @sam' });

    // Not "no chat.mention" — no event at all. A future human-push branch is
    // as likely to invent a type as to reuse this one.
    expect(enqueued()).toHaveLength(0);
  });

  test('CONTROL: the same sentence addressed to an installed agent DOES enqueue', async () => {
    await send({ id: 'm-2', content: 'can you decide this @seat-a' });

    const got = mentions();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ agentName: 'seat-a', type: 'chat.mention' });
  });

  test('one message naming both routes to the agent only', async () => {
    // The discriminating case. A human-push branch added beside the agent one
    // leaves every single-target fixture above intact — it only shows up when
    // both appear at once and the count stops being 1.
    await send({ id: 'm-3', content: '@seat-a please answer, @sam to press' });

    expect(enqueued()).toHaveLength(1);
    expect(enqueued()[0]).toMatchObject({ agentName: 'seat-a' });
  });
});

describe('the thread-follow half is guarded by threadRootId', () => {
  test('a plain channel post materialises no thread state for the mentioned human', async () => {
    await send({ id: 'm-4', content: 'over to you @sam' });

    expect(ThreadUserState.followByParticipation).not.toHaveBeenCalled();
    // And it declined to make the lookup at all, rather than making it and
    // finding nobody — the guard is on the call, not on the result.
    expect(User.find).not.toHaveBeenCalled();
  });

  test('CONTROL: the same message inside a thread DOES follow that human', async () => {
    await send({
      id: 'm-5', content: 'over to you @sam', thread_root_id: 101, threadRootId: 101,
    });

    expect(ThreadUserState.followByParticipation).toHaveBeenCalledWith(101, 'user-sam', 'pod-1');
  });

  test('a follow is not a wake — the threaded case still enqueues no event', async () => {
    // Both halves of the cue's ceiling in one assertion: the handle bought a
    // pull-surface row, and nothing was pushed.
    await send({
      id: 'm-6', content: 'over to you @sam', thread_root_id: 101, threadRootId: 101,
    });

    expect(ThreadUserState.followByParticipation).toHaveBeenCalled();
    expect(enqueued()).toHaveLength(0);
  });
});
