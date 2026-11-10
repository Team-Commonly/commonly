/**
 * F390 part A: a person's ask to an agent that can't run is handed to the pod's
 * host (Scout), addressed, once.
 *
 * Earned 11-06 and 11-07 in My Workspace: a person @mentioned an agent whose
 * computer had stopped checking in. The room said so, and then nothing: Scout
 * read the message as addressed to someone else and stood down.
 *
 * Through enqueueMentions, with the reasons faked at deriveAgentState and the
 * stop timestamp (their own suites cover those verdicts):
 *  - never connected, offline or stopped: the existing notice runs once, and
 *    Scout gets one chat.mention marked addressed and framed with the reason,
 *    and no second ambient wake;
 *  - a runnable agent: no hand-off, and Scout's turn is what it was;
 *  - no Scout in the pod, a mention of Scout itself, or an agent sender: nothing.
 */
jest.mock('../../../services/agentEventService', () => ({
  enqueue: jest.fn(),
  resolveEffectiveInstallation: jest.fn(),
}));
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
jest.mock('../../../models/pg/Message', () => ({
  findById: jest.fn(async () => null),
  findPreviousTopLevel: jest.fn(async () => null),
}));
jest.mock('../../../models/pg/ThreadUserState', () => ({
  followByParticipation: jest.fn().mockResolvedValue(true),
}));
jest.mock('../../../services/stoppedMentionService', () => ({
  noteStoppedMention: jest.fn().mockResolvedValue(false),
  noteUnreachableAgentDm: jest.fn(),
}));
jest.mock('../../../services/neverConnectedMentionService', () => ({
  noteNeverConnectedMention: jest.fn().mockResolvedValue(false),
  noteOfflineMention: jest.fn().mockResolvedValue(false),
  isNeverConnectedAgent: jest.fn().mockResolvedValue(false),
  agentReach: jest.fn(),
}));
jest.mock('../../../services/agentStateService', () => ({
  ...jest.requireActual('../../../services/agentStateService'),
  deriveAgentState: jest.fn(),
}));
jest.mock('../../../services/hostedEngine', () => ({
  ...jest.requireActual('../../../services/hostedEngine'),
  hostedStoppedAt: jest.fn(() => null),
}));

const AgentMentionService = require('../../../services/agentMentionService');
const AgentEventService = require('../../../services/agentEventService');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const AgentProfile = require('../../../models/AgentProfile');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentEvent = require('../../../models/AgentEvent');
const { noteNeverConnectedMention, noteOfflineMention, agentReach } = require('../../../services/neverConnectedMentionService');
const { noteStoppedMention } = require('../../../services/stoppedMentionService');
const { deriveAgentState } = require('../../../services/agentStateService');
const { hostedStoppedAt } = require('../../../services/hostedEngine');
const { handOffToHost, hostInstallFor, resetHandoffsForTest } = require('../../../services/askFallbackService');

const human = { _id: 'user-1', username: 'priya', isBot: false };
const nova = {
  _id: 'bot-1', username: 'nova', isBot: true, botMetadata: { agentName: 'nova', instanceId: 'default', displayName: 'Nova' },
};
const scout = {
  _id: 'bot-9', username: 'scout', isBot: true, botMetadata: { agentName: 'scout', instanceId: 'u-1' },
};
const novaInstall = {
  agentName: 'nova', instanceId: 'default', displayName: 'Nova', status: 'active', 
};
const scoutInstall = {
  agentName: 'scout', instanceId: 'u-1', displayName: 'Scout', status: 'active', config: { wakeOnMessage: { enabled: true } },
};

const chain = (value) => ({
  select: jest.fn().mockReturnThis(),
  sort: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  lean: jest.fn().mockResolvedValue(value),
});

let installs = [];
const useInstalls = (rows) => {
  installs = rows;
  // The mention fan-out reads every install; the host lookup asks for scout only.
  AgentInstallation.find.mockImplementation((q) => chain(q?.agentName ? rows.filter((i) => i.agentName === q.agentName) : rows));
  AgentEventService.resolveEffectiveInstallation.mockImplementation(
    async (agentName) => rows.find((i) => i.agentName === agentName) || null,
  );
};

const setup = ({ state = 'listening', withScout = true, scoutRow = scoutInstall } = {}) => {
  useInstalls(withScout ? [novaInstall, scoutRow] : [novaInstall]);
  AgentInstallation.findOne.mockImplementation((q) => chain(installs.find((i) => i.agentName === q?.agentName) || null));
  AgentProfile.find.mockReturnValue({ lean: jest.fn().mockResolvedValue([]) });
  Pod.find.mockReturnValue(chain([]));
  const members = withScout ? [human, nova, scout] : [human, nova];
  User.find.mockImplementation((query) => chain(query?.isBot ? members.filter((m) => m.isBot) : members));
  User.findById.mockImplementation((id) => chain(members.find((m) => m._id === id) || null));
  User.findOne.mockImplementation((q) => chain(members.find((m) => m.botMetadata?.agentName === q?.['botMetadata.agentName']) || null));
  const pod = { _id: 'pod-1', type: 'chat', members: members.map((m) => m._id) };
  Pod.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(pod) }),
    lean: jest.fn().mockResolvedValue(pod),
  });
  AgentEvent.countDocuments.mockResolvedValue(0);
  AgentEventService.enqueue.mockResolvedValue({});
  deriveAgentState.mockReturnValue({ state });
  // agentReach's own suite covers the verdict; here it reads the faked state.
  agentReach.mockImplementation(async ({ agentName }) => {
    const install = installs.find((i) => i.agentName === agentName);
    const agent = members.find((m) => m.botMetadata?.agentName === agentName) || { username: agentName };
    return install ? { agent, state: deriveAgentState(install).state } : null;
  });
};

const mention = ({ sender = human, content = '@nova can you check my deck?', id = '900' } = {}) => (
  AgentMentionService.enqueueMentions({
    podId: 'pod-1',
    message: { _id: id, content, createdAt: new Date() },
    userId: sender._id,
    username: sender.username,
  })
);

const events = (agentName) => AgentEventService.enqueue.mock.calls.map(([e]) => e).filter((e) => e.agentName === agentName);

beforeEach(() => {
  jest.clearAllMocks();
  resetHandoffsForTest();
  hostedStoppedAt.mockReturnValue(null);
});

describe('an ask to an agent that can\'t run goes to the host (F390 A)', () => {
  it.each([
    ['never connected', 'never-connected', /it has never connected/],
    ['offline', 'gone-dark', /its computer has stopped checking in/],
  ])('%s: the notice runs once, and Scout gets one addressed ask', async (_label, state, reason) => {
    setup({ state });
    await mention();
    expect(noteNeverConnectedMention).toHaveBeenCalledTimes(1);
    expect(noteOfflineMention).toHaveBeenCalledTimes(1);
    const toScout = events('scout');
    expect(toScout).toHaveLength(1);
    expect(toScout[0]).toMatchObject({ type: 'chat.mention', instanceId: 'u-1', podId: 'pod-1' });
    expect(toScout[0].payload).toMatchObject({
      addressed: true, messageId: '900', userId: 'user-1', mentions: [], handoffFrom: 'nova:default',
    });
    expect(toScout[0].payload.content).toMatch(/^\[Nova can't answer this right now/);
    expect(toScout[0].payload.content).toMatch(reason);
    expect(toScout[0].payload.content).toContain('@nova can you check my deck?');
    // The mention to the agent still queues, for when it can run.
    expect(events('nova').filter((e) => e.type === 'chat.mention')).toHaveLength(1);
  });

  it('stopped by its owner: Scout gets the ask with that reason', async () => {
    setup();
    hostedStoppedAt.mockReturnValue(new Date());
    await mention();
    expect(noteStoppedMention).toHaveBeenCalledTimes(1);
    expect(events('scout')).toHaveLength(1);
    expect(events('scout')[0].payload.content).toMatch(/its owner stopped it/);
  });

  it('a runnable agent: no hand-off, and Scout gets nothing extra', async () => {
    setup({ state: 'listening' });
    await mention();
    // A person addressed someone else, so Scout's ambient turn is a digest, as before.
    expect(events('scout').filter((e) => e.type === 'chat.mention')).toHaveLength(0);
    expect(events('scout').every((e) => e.payload.addressed !== true)).toBe(true);
  });

  it('no Scout in the pod: nothing to hand to', async () => {
    setup({ state: 'gone-dark', withScout: false });
    await mention();
    expect(events('scout')).toHaveLength(0);
  });

  it('two agents that can\'t run in one message: one hand-off', async () => {
    setup({ state: 'gone-dark' });
    useInstalls([novaInstall, { ...novaInstall, agentName: 'milo', displayName: 'Milo' }, scoutInstall]);
    await mention({ content: '@nova @milo anyone?' });
    expect(events('scout')).toHaveLength(1);
  });

  it('one named agent can run: it answers, and Scout is not told to', async () => {
    setup();
    useInstalls([novaInstall, { ...novaInstall, agentName: 'sage', displayName: 'Sage' }, scoutInstall]);
    deriveAgentState.mockImplementation((install) => ({ state: install.agentName === 'sage' ? 'listening' : 'gone-dark' }));
    await mention({ content: '@nova @sage anyone?' });
    expect(events('scout').filter((e) => e.payload?.handoffFrom)).toHaveLength(0);
  });

  it('a Scout whose owner asks first is not handed a stranger\'s ask', async () => {
    setup({
      state: 'gone-dark',
      scoutRow: { ...scoutInstall, installedBy: 'owner-2', config: { ...scoutInstall.config, askBeforeOthers: { enabled: true } } },
    });
    await mention();
    expect(events('scout').filter((e) => e.payload?.handoffFrom)).toHaveLength(0);
  });

  it('a joined row hands the host all the person\'s words', async () => {
    setup({ state: 'gone-dark' });
    await handOffToHost({
      podId: 'pod-1',
      from: { agentName: 'nova' },
      label: 'Nova',
      reason: 'out-of-turns',
      sender: human,
      payload: {
        messageId: '903',
        userId: 'user-1',
        rawContent: '@nova first',
        coalesced: [{ rawContent: 'and second' }, { rawContent: 'not to nova', notAnAsk: true }],
      },
    });
    const [toScout] = events('scout');
    expect(toScout.payload.rawContent).toBe('@nova first\n\nand second');
    expect(toScout.payload.coalesced).toBeUndefined();
  });

  it('with two people\'s guides in the pod, the asker\'s own gets it', async () => {
    setup({ state: 'gone-dark' });
    useInstalls([
      novaInstall,
      { ...scoutInstall, instanceId: 'a-0', installedBy: 'someone-else' },
      { ...scoutInstall, instanceId: 'u-1', installedBy: 'user-1' },
    ]);
    expect((await hostInstallFor('pod-1', 'user-1')).instanceId).toBe('u-1');
    expect((await hostInstallFor('pod-1', 'stranger')).instanceId).toBe('a-0');
  });

  it('a Scout already reached or held by this message is not handed it again', async () => {
    setup({ state: 'gone-dark' });
    const args = {
      podId: 'pod-1', from: { agentName: 'nova' }, label: 'Nova', reason: 'offline', sender: human,
    };
    expect(await handOffToHost({
      ...args, payload: { messageId: '901', userId: 'user-1' }, excludeKeys: new Set(['scout:u-1']),
    })).toBeNull();
    expect(await handOffToHost({ ...args, payload: { messageId: '902', userId: 'user-1' }, excludeKeys: new Set() }))
      .toBe('scout:u-1');
  });

  it('an agent sender: no hand-off, the notices are for people', async () => {
    setup({ state: 'gone-dark' });
    const milo = {
      _id: 'bot-2', username: 'milo', isBot: true, botMetadata: { agentName: 'milo', instanceId: 'default' }, 
    };
    User.findById.mockImplementation((id) => chain(id === 'bot-2' ? milo : null));
    await mention({ sender: milo });
    expect(events('scout').filter((e) => e.payload?.handoffFrom)).toHaveLength(0);
  });

  it('a mention of Scout itself is Scout\'s already', async () => {
    setup({ state: 'gone-dark' });
    await mention({ content: '@scout @nova hello' });
    expect(events('scout').filter((e) => e.payload?.handoffFrom)).toHaveLength(0);
  });
});
