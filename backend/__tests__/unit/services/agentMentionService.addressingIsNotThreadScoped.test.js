/**
 * Addressing is never scoped by the thread — the mechanism, not the copy.
 *
 * `threadWakeScopeService`'s header states it in prose ("NOT the addressing
 * path"), and #1216's wake cue teaches agents to rely on it. @sprint-review's
 * gate on that PR named the gap exactly: the tests there pin the CUE TEXT, and
 * "addressing is never scoped by the thread" would become a lie the moment
 * someone added one `narrowToThread` call to the mention fan-out — with every
 * copy assertion still green, because copy is not mechanism.
 *
 * This file is that missing pin. It asserts the call graph rather than the
 * sentence: `narrowToThread` runs on the WAKE fan-out and never on the
 * addressing fan-out, so a mute or a non-follow can silence ambient activity
 * and can never silence an @mention.
 *
 * The discriminator is a seat that is mentioned but NOT wake-opted-in. That
 * seat reaches the addressing fan-out and never the wake one, so any
 * `narrowToThread` call observed under it came from the mention path — the
 * mutation this file exists to catch. The paired control is an unrouted
 * threaded message to an opted-in seat, which MUST call it: without that,
 * `not.toHaveBeenCalled()` would pass just as well from a mock nothing can
 * reach, which is the failure mode the sibling suite
 * (`threadingIsNotAddressing`) already had to learn once.
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
jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(async (id) => (String(id) === '101' ? { id: 101, user_id: 'bot-1' } : null)),
}));
jest.mock('../../../models/pg/ThreadUserState', () => ({
  followByParticipation: jest.fn().mockResolvedValue(true),
}));

// The instrument. Identity by default — narrowing that removes nothing — so
// the observable under test is WHETHER it was consulted, not what it returned.
// A mock that dropped targets would conflate "addressing was scoped" with
// "addressing was suppressed", and only the first is the claim here.
jest.mock('../../../services/threadWakeScopeService', () => ({
  narrowToThread: jest.fn(async (_rootId, targets) => targets),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { narrowToThread } = require('../../../services/threadWakeScopeService');

const SEAT = { agentName: 'seat-a', instanceId: 'default', displayName: 'Seat A' };
const SEAT_OPTED_IN = { ...SEAT, config: { wakeOnMessage: { enabled: true } } };

const mockInstallations = (installations) => {
  AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(installations) });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
};

const mockUsers = () => {
  User.findById.mockImplementation((id) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(
      String(id) === 'bot-1'
        ? { _id: 'bot-1', isBot: true, botMetadata: { agentName: 'seat-a', instanceId: 'default' } }
        : { _id: 'user-1', isBot: false },
    ),
  }));
  User.find.mockReturnValue({ select: jest.fn().mockReturnThis(), lean: jest.fn().mockResolvedValue([]) });
};

const byType = (t) => AgentEventService.enqueue.mock.calls.map(([a]) => a).filter((a) => a.type === t);
const mentions = () => byType('chat.mention');
const wakes = () => byType('message.posted');

const send = (message) => AgentMentionService.enqueueMentions({
  podId: 'pod-1', userId: 'user-1', username: 'alice', ...message,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockUsers();
  narrowToThread.mockImplementation(async (_rootId, targets) => targets);
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'bot-1'] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1', 'bot-1'] }),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);
});

describe('the addressing fan-out never consults thread scope', () => {
  test('an @mention inside a thread is delivered without narrowToThread being called', async () => {
    // Not opted in to wake-on-message, so the only fan-out this message can
    // reach is the addressing one.
    mockInstallations([SEAT]);

    await send({
      message: {
        id: 'msg-2',
        content: '@seat-a what do you think',
        thread_root_id: 101,
        threadRootId: 101,
      },
    });

    expect(mentions()).toHaveLength(1);
    // The load-bearing assertion. Adding `narrowToThread` to the mention path
    // reds this line while every copy test about "addressing is never scoped
    // by the thread" stays green.
    expect(narrowToThread).not.toHaveBeenCalled();
  });

  test('CONTROL: an unrouted threaded message to an opted-in seat DOES call it', async () => {
    // Proves the mock is reachable from production code. Without this, the
    // assertion above passes from a mis-pathed jest.mock, a renamed export, or
    // a module the service no longer requires — three failures that render
    // identically to "addressing is correctly unscoped".
    mockInstallations([SEAT_OPTED_IN]);

    await send({
      message: { id: 'msg-3', content: 'thinking out loud in a thread', thread_root_id: 101, threadRootId: 101 },
    });

    expect(narrowToThread).toHaveBeenCalledTimes(1);
    expect(wakes()).toHaveLength(1);
    expect(mentions()).toHaveLength(0);
  });

  test('a ROUTED threaded message still has an ambient fan-out, and it IS narrowed', async () => {
    // The case where the two fan-outs collide, and the one that corrected this
    // file's first draft. I assumed a routed message skips the wake path
    // entirely, on the strength of the comment at agentMentionService:1123
    // ("This branch runs only when `!isRouted`"). It does not: there are TWO
    // call sites, and the second (:1748) runs unconditionally, after the
    // mention path, to reach opt-ins the mention did not. The comment at that
    // call site says so outright; the one inside the function contradicts it.
    //
    // So the invariant is NOT "a routed message never touches thread scope".
    // It is the narrower and more useful one: scoping applies to the ambient
    // companion, and the chat.mention is delivered either way.
    mockInstallations([SEAT_OPTED_IN]);

    await send({
      message: { id: 'msg-4', content: '@seat-a please look', thread_root_id: 101, threadRootId: 101 },
    });

    expect(mentions()).toHaveLength(1);
    expect(narrowToThread).toHaveBeenCalledTimes(1);
    // The mentioned seat is excluded from its own ambient companion, so the
    // narrowing cannot double-deliver — it can only remove.
    expect(wakes()).toHaveLength(0);
  });

  test('a narrowing that drops every target still cannot suppress a mention', async () => {
    // The strongest form: even if thread scope says this seat follows nothing,
    // the @mention is delivered. A mute scopes ambient activity, never
    // addressing — `threadWakeScopeService`'s header claim, executable.
    narrowToThread.mockImplementation(async () => []);
    mockInstallations([SEAT_OPTED_IN]);

    await send({
      message: { id: 'msg-5', content: '@seat-a urgent', thread_root_id: 101, threadRootId: 101 },
    });

    expect(mentions()).toHaveLength(1);
  });

  test('CONTROL: the same total narrowing DOES suppress the ambient wake', async () => {
    // Pairs with the test above. Without it, "the mention survived" is equally
    // consistent with a narrowing mock that never took effect at all.
    narrowToThread.mockImplementation(async () => []);
    mockInstallations([SEAT_OPTED_IN]);

    await send({
      message: { id: 'msg-6', content: 'ambient thought', thread_root_id: 101, threadRootId: 101 },
    });

    expect(wakes()).toHaveLength(0);
  });
});

describe('the call site itself', () => {
  test('narrowToThread has exactly one call site, inside enqueueWakeOnMessage', () => {
    // Structural backstop, and the earliest warning: the behavioural tests
    // above cover the paths a message can take today, and this catches a
    // second call site added on a path no fixture exercises yet.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/agentMentionService.ts'), 'utf8',
    );

    const calls = [...src.matchAll(/\bnarrowToThread\s*\(/g)].map((m) => m.index);
    expect(calls).toHaveLength(1);

    const wakeDecl = src.indexOf('const enqueueWakeOnMessage = async ({');
    const mentionDecl = src.indexOf('const enqueueMentions = async ({');
    expect(wakeDecl).toBeGreaterThan(-1);
    expect(mentionDecl).toBeGreaterThan(-1);

    // Both declarations exist, so "the call is after enqueueWakeOnMessage"
    // means something only if we also know where enqueueMentions begins —
    // otherwise a call moved into a later function would still pass.
    const [callIdx] = calls;
    expect(callIdx).toBeGreaterThan(wakeDecl);
    if (mentionDecl > wakeDecl) expect(callIdx).toBeLessThan(mentionDecl);
  });
});
