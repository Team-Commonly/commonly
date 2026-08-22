/**
 * Threading is not addressing (W-T, TASK-029, 1/4).
 *
 * `thread_root_id` and `reply_to_message_id` are deliberately separate columns.
 * The reason is a behaviour, not a preference: `reply_to_message_id` is an
 * ADDRESSING edge — it feeds `isRouted` (agentMentionService:1061) and resolves
 * an implicit-reply `chat.mention` (:1392). Express thread membership through
 * it and joining a thread becomes identical to pinging the parent's author,
 * which is the opposite of what ambient-only scoping is for (#1045).
 *
 * @sprint-review (56773/56777): a comment saying "these can't be one column" is
 * exactly what a later refactor deletes. The discriminating assertion is that
 * setting a thread root alone enqueues NO chat.mention — that fails the moment
 * someone routes threading back through the addressing edge, which prose can't.
 *
 * Every "nothing was enqueued" case here is paired with a control that DOES
 * enqueue. An assertion that nothing happened is worthless from an instrument
 * that cannot make anything happen.
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

// The PG lookup resolveImplicitReplyTarget falls back to when the caller did
// not pass a populated `replyTo`. MOCKED DELIBERATELY, and the suite is worth
// nothing without it: message 101 is a real, bot-authored row, so if anything
// ever hands a thread root to that resolver it WILL find a target and enqueue.
//
// Learned the hard way. The first version of this file left it unmocked, and
// the negative cases passed because the lookup died in the harness rather than
// because the code declined to make it. A mutation that routed thread roots
// through resolveImplicitReplyTarget went completely undetected — the exact
// refactor these tests exist to stop. The controls hid it too, because they
// pass `replyTo` inline and never touch this path at all.
jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(async (id) => (String(id) === '101' ? { id: 101, user_id: 'bot-1' } : null)),
}));
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
const PGMessage = require('../../../models/pg/Message');

const SEAT = { agentName: 'seat-a', instanceId: 'default', displayName: 'Seat A' };
const SEAT_OPTED_IN = { ...SEAT, config: { wakeOnMessage: { enabled: true } } };

const mockInstallations = (installations) => {
  AgentInstallation.find.mockReturnValue({ lean: jest.fn().mockResolvedValue(installations) });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
};

// Dispatches on id: the SENDER is human, the message being replied to was
// authored by the bot. A single blanket mock cannot express that, and the
// implicit-reply path only fires when the two differ in exactly this way.
const mockUsers = () => {
  User.findById.mockImplementation((id) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(
      String(id) === 'bot-1'
        ? { _id: 'bot-1', isBot: true, botMetadata: { agentName: 'seat-a', instanceId: 'default' } }
        : { _id: 'user-1', isBot: false },
    ),
  }));
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
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ type: 'chat', members: ['user-1', 'bot-1'] }),
    }),
    lean: jest.fn().mockResolvedValue({ _id: 'pod-1', type: 'chat', members: ['user-1', 'bot-1'] }),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);
});

describe('a thread root alone addresses nobody', () => {
  test('a threaded message with no reply edge and no mention enqueues NO chat.mention', async () => {
    mockInstallations([SEAT]);

    await send({
      message: {
        id: 'msg-2',
        content: 'adding a thought to this thread',
        // The thread root is carried on the row. It must reach the mention
        // pipeline as inert data, or as nothing at all.
        thread_root_id: 101,
        threadRootId: 101,
      },
    });

    expect(mentions()).toHaveLength(0);
    // And it declined to make the lookup at all — not merely failed to find a
    // target. Asserting only "no mention" would pass from a harness where the
    // resolver is dead, which is exactly how the first draft of this file
    // missed the mutation it was written to catch.
    expect(PGMessage.findById).not.toHaveBeenCalled();
  });

  test('CONTROL: the same message WITH a reply edge to the bot DOES enqueue one', async () => {
    // Without this the test above passes just as well from a broken harness.
    mockInstallations([SEAT]);

    await send({
      message: {
        id: 'msg-2',
        content: 'adding a thought to this thread',
        thread_root_id: 101,
        replyTo: { userId: 'bot-1' },
      },
      replyToMessageId: '101',
    });

    const got = mentions();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ agentName: 'seat-a', type: 'chat.mention' });
  });

  test('a deep thread root — many levels in — still addresses nobody', async () => {
    // The derivation collapses depth: every reply in a 7-deep chain carries the
    // SAME root. If a root ever addressed its author, one message would ping
    // them on behalf of an entire conversation.
    mockInstallations([SEAT]);

    await send({
      message: { id: 'msg-90', content: 'seven levels deep', thread_root_id: 101, threadRootId: 101 },
    });

    expect(mentions()).toHaveLength(0);
    expect(PGMessage.findById).not.toHaveBeenCalled();
  });
});

describe('threading does not suppress addressing either', () => {
  test('an explicit @mention inside a threaded message still enqueues', async () => {
    // The mirror failure. Separating the columns must not make a threaded
    // message unaddressable — ambient-only scopes the AMBIENT case only.
    mockInstallations([SEAT]);

    await send({
      message: { id: 'msg-3', content: '@seat-a what do you think', thread_root_id: 101 },
    });

    expect(mentions()).toHaveLength(1);
  });

  test('a threaded message is still unrouted, so wake-on-message opt-ins hear it', async () => {
    // isRouted is `mentions.length > 0 || !!replyToMessageId`. A thread root
    // must not make a message look routed, or ADR-018 D8 delivery silently
    // stops for every threaded message.
    mockInstallations([SEAT_OPTED_IN]);

    const res = await send({
      message: { id: 'msg-4', content: 'thinking out loud in a thread', thread_root_id: 101 },
    });

    expect(res.woken).toEqual(['seat-a']);
    expect(wakes()).toHaveLength(1);
    expect(mentions()).toHaveLength(0);
  });

  test('CONTROL: adding a reply edge makes it routed, so the opt-in does NOT get a wake', async () => {
    mockInstallations([SEAT_OPTED_IN]);

    await send({
      message: { id: 'msg-5', content: 'replying', thread_root_id: 101, replyTo: { userId: 'bot-1' } },
      replyToMessageId: '101',
    });

    // Proves the previous test's `wakes()` is sensitive to routedness rather
    // than always returning one.
    expect(wakes()).toHaveLength(0);
    expect(mentions()).toHaveLength(1);
  });
});

describe('the pipeline has no thread-root input at all', () => {
  test('enqueueMentions takes replyToMessageId and no thread-root parameter', () => {
    // Structural, and the earliest possible warning. The moment someone adds a
    // threadRootId parameter here, this fails and the change gets looked at —
    // which is the whole point, since the behavioural tests above would still
    // pass for a parameter that is accepted and then ignored.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/agentMentionService.ts'), 'utf8',
    );
    const sig = src.slice(
      src.indexOf('const enqueueMentions = async ({'),
      src.indexOf('}: EnqueueMentionsOptions)'),
    );
    expect(sig).toContain('replyToMessageId');
    expect(sig).not.toMatch(/thread_?[Rr]oot/);
  });

  test('isRouted is derived from mentions and the reply edge only', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../../../services/agentMentionService.ts'), 'utf8',
    );
    expect(src).toContain('const isRouted = rawMentions.length > 0 || !!replyToMessageId;');
  });
});
