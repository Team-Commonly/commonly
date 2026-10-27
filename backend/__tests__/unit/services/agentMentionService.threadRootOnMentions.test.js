/**
 * TASK-026 / PR #2811: a hosted agent @-mentioned in a thread must receive the
 * thread root on the event it is woken with. Before this, only the ambient
 * message.posted path carried threadRootId, so a hosted reply landed at the pod
 * root. This drives the real enqueueMentions path (no hand-built payload) and
 * asserts the field on every chat.mention and thread.mention it enqueues.
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
jest.mock('../../../services/messageDeliveryModeService', () => ({
  addressedMessageTargets: jest.fn(async () => new Set()),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { narrowToThread } = require('../../../services/threadWakeScopeService');
const { addressedMessageTargets } = require('../../../services/messageDeliveryModeService');
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
const HUMAN_MENTION_ROWS = [
  { _id: 'human-casey', username: 'Casey_Dev', isBot: false },
];

const byType = (t) => AgentEventService.enqueue.mock.calls.map(([a]) => a).filter((a) => a.type === t);

const send = (message, extra = {}) => AgentMentionService.enqueueMentions({
  podId: 'pod-1', userId: 'user-1', username: 'alice', message, ...extra,
});

beforeEach(() => {
  jest.clearAllMocks();
  narrowToThread.mockImplementation(async (_root, targets) => targets);
  addressedMessageTargets.mockResolvedValue(new Set());
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue([
      optIn('seat-a', 'human-installer-a'), optIn('seat-b', 'human-installer-b'),
    ]),
  });
  User.find.mockImplementation((filter) => ({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue(filter.isBot === false ? HUMAN_MENTION_ROWS : BOT_USER_ROWS),
    }),
  }));
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        type: 'chat', members: ['user-1', 'bot-user-a', 'human-casey'],
      }),
    }),
    lean: jest.fn().mockResolvedValue({
      _id: 'pod-1', type: 'chat', members: ['user-1', 'human-casey'],
    }),
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

const mentionEvents = () => AgentEventService.enqueue.mock.calls
  .map(([a]) => a)
  .filter((a) => a.type === 'chat.mention' || a.type === 'thread.mention');

describe('a mention carries the thread root it was posted in (TASK-026)', () => {
  test('a thread.mention to a hosted agent carries threadRootId', async () => {
    await send({ id: 'm2', _id: 'm2', content: '@seat-a please look', source: 'thread', thread_root_id: 101 });
    const events = mentionEvents().filter((e) => e.agentName === 'seat-a');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('thread.mention');
    expect(events[0].payload.threadRootId).toBe(101);
  });

  test('a chat-sourced mention inside a thread carries threadRootId', async () => {
    await send({ id: 'm3', _id: 'm3', content: '@seat-a in the thread', source: 'chat', threadRootId: 101 });
    const events = mentionEvents().filter((e) => e.agentName === 'seat-a');
    expect(events).toHaveLength(1);
    expect(events[0].payload.threadRootId).toBe(101);
  });

  test('a top-level mention carries no threadRootId key at all', async () => {
    await send({ id: 'm4', _id: 'm4', content: '@seat-a at the root', source: 'chat' });
    const events = mentionEvents().filter((e) => e.agentName === 'seat-a');
    expect(events).toHaveLength(1);
    expect(events[0].payload).not.toHaveProperty('threadRootId');
  });
});
