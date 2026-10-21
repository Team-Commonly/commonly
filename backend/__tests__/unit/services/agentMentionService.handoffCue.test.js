/**
 * The handoff cue (C14 call rehearsal, 2026-10-20). Claude handed a change to
 * Codex and promised to review it; Codex posted the result without @mentioning
 * Claude, so Claude never woke and the review never came. When one agent
 * @mentions another, the target's event now says who handed it over and to
 * @mention them back with the result: only on the FIRST handoff of a chain,
 * so the result coming back (and the thanks after it) carries no cue.
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
jest.mock('../../../models/pg/Message', () => ({ recentContentByAuthor: jest.fn() }));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const PGMessage = require('../../../models/pg/Message');

const POD = 'pod-c14';
// Two own agents in one pod, as on the call: each is its own agentName with
// the default instance, so each answers to its bare name.
const AGENTS = {
  'laruiss-claude': { _id: 'u-claude', agentName: 'laruiss-claude', instanceId: 'default' },
  'laruiss-codex': { _id: 'u-codex', agentName: 'laruiss-codex', instanceId: 'default' },
};
const HUMAN = { _id: 'u-laruiss', isBot: false, username: 'laruiss' };

// What each agent said in the pod, by user id (what recentContentByAuthor reads).
let posted;

beforeEach(() => {
  jest.clearAllMocks();
  posted = {};
  AgentEvent.countDocuments.mockResolvedValue(0);
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue({ _id: POD, type: 'chat', contacts: {} }),
  });
  AgentInstallation.find.mockReturnValue({
    lean: jest.fn().mockResolvedValue(Object.values(AGENTS).map(({ agentName, instanceId }) => (
      { agentName, instanceId, displayName: agentName }
    ))),
  });
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  User.findOne.mockImplementation(({ username }) => ({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(AGENTS[username] ? { _id: AGENTS[username]._id } : null),
  }));
  PGMessage.recentContentByAuthor.mockImplementation(async (_podId, userId) => posted[userId] || []);
});

const as = (sender) => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnThis(),
    lean: jest.fn().mockResolvedValue(sender.isBot === false ? sender : {
      _id: sender._id,
      isBot: true,
      username: sender.agentName,
      botMetadata: { agentName: sender.agentName, instanceId: sender.instanceId },
    }),
  });
};

// Post as `sender`: record it in the pod, run the mention fan-out, and return
// the content of the event each mentioned agent received.
const post = async (sender, content) => {
  as(sender);
  AgentEventService.enqueue.mockClear();
  const result = await AgentMentionService.enqueueMentions({
    podId: POD,
    message: { content, id: `m-${Math.random()}` },
    userId: sender._id,
    username: sender.username || sender.agentName,
  });
  posted[sender._id] = [content, ...(posted[sender._id] || [])];
  const events = {};
  AgentEventService.enqueue.mock.calls.forEach(([event]) => { events[event.agentName] = event.payload.content; });
  return { result, events };
};

const CUE = /handed this to you/;

describe('handoff cue', () => {
  test('the first agent-to-agent handoff tells the target to @mention the sender with the result', async () => {
    const { events } = await post(AGENTS['laruiss-claude'], '@laruiss-codex add a size prop to DsfrButton');
    expect(events['laruiss-codex']).toMatch(
      '[@laruiss-claude handed this to you. When it\'s done, post the result and @mention @laruiss-claude',
    );
  });

  test('a two-agent chain ends: the result coming back and the thanks after it carry no cue', async () => {
    const handoff = await post(AGENTS['laruiss-claude'], '@laruiss-codex add a size prop to DsfrButton');
    expect(handoff.events['laruiss-codex']).toMatch(CUE);

    const result = await post(AGENTS['laruiss-codex'], 'Done: feat(DsfrButton): add size prop. @laruiss-claude');
    expect(result.result.enqueued).toEqual(['laruiss-claude']);
    expect(result.events['laruiss-claude']).not.toMatch(CUE);

    const thanks = await post(AGENTS['laruiss-claude'], 'Reviewed, looks right. Thanks @laruiss-codex');
    expect(thanks.result.enqueued).toEqual(['laruiss-codex']);
    expect(thanks.events['laruiss-codex']).not.toMatch(CUE);
  });

  test('a person mentioning an agent gets no handoff cue', async () => {
    const { events } = await post(HUMAN, '@laruiss-claude review the PR');
    expect(events['laruiss-claude']).toBeDefined();
    expect(events['laruiss-claude']).not.toMatch(CUE);
  });

  test('a mention back by another handle for the sender still counts as the answer', async () => {
    // The target answered with the sender's `<agentName>-<instance>` key, not
    // its bare name; both resolve to the sender in this pod.
    posted['u-codex'] = ['all done @laruiss-claude-default'];
    const { events } = await post(AGENTS['laruiss-claude'], 'Thanks @laruiss-codex');
    expect(events['laruiss-codex']).not.toMatch(CUE);
  });

  test('a longer handle that starts with the sender\'s is not a mention of the sender', async () => {
    posted['u-codex'] = ['pinging @laruiss-claude-bot about something else'];
    const { events } = await post(AGENTS['laruiss-claude'], '@laruiss-codex next task');
    expect(events['laruiss-codex']).toMatch(CUE);
  });

  test('a sender that is not installed in the pod cannot be woken by a mention, so it is not named', async () => {
    const outsider = { _id: 'u-out', agentName: 'roaming-bot', instanceId: 'default' };
    const { events } = await post(outsider, '@laruiss-codex take this');
    expect(events['laruiss-codex']).toBeDefined();
    expect(events['laruiss-codex']).not.toMatch(CUE);
  });

  test('a failed check means no cue, and the mention is still delivered', async () => {
    PGMessage.recentContentByAuthor.mockRejectedValue(new Error('pg down'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { result, events } = await post(AGENTS['laruiss-claude'], '@laruiss-codex take this');
    expect(result.enqueued).toEqual(['laruiss-codex']);
    expect(events['laruiss-codex']).not.toMatch(CUE);
    expect(warn).toHaveBeenCalledWith('[handoff-cue] check failed (no cue):', 'pg down');
    warn.mockRestore();
  });

  test('the answer check reads the TARGET\'s messages in this pod within 30 minutes', async () => {
    await post(AGENTS['laruiss-claude'], '@laruiss-codex take this');
    expect(User.findOne).toHaveBeenCalledWith({ username: 'laruiss-codex', isBot: true });
    const [podId, userId, since] = PGMessage.recentContentByAuthor.mock.calls[0];
    expect([podId, userId]).toEqual([POD, 'u-codex']);
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(30 * 60 * 1000 - 1000);
    expect(Date.now() - since.getTime()).toBeLessThanOrEqual(30 * 60 * 1000 + 1000);
  });
});
