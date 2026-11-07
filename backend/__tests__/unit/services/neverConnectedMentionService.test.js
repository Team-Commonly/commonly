// TASK-655 item 3: a person's @mention of a Bring your own agent that has never
// polled gets one system line in the room, at most one per agent per UTC day.

const mockFindUser = jest.fn();
const mockFindInstall = jest.fn();
const mockFindBot = jest.fn();
const mockEmitNotConnected = jest.fn();
const mockHasLineToday = jest.fn();
const mockEmitOffline = jest.fn();
const mockHasOfflineSince = jest.fn();

jest.mock('../../../models/User', () => ({
  findById: (...args) => mockFindUser(...args),
  findOne: (...args) => mockFindBot(...args),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: (...args) => mockFindInstall(...args) },
}));
jest.mock('../../../services/systemActionLineService', () => ({
  emitNotConnectedLine: (...args) => mockEmitNotConnected(...args),
  hasNotConnectedLineToday: (...args) => mockHasLineToday(...args),
  emitOfflineLine: (...args) => mockEmitOffline(...args),
  hasOfflineLineSince: (...args) => mockHasOfflineSince(...args),
}));

const chain = (value) => ({ select: () => ({ lean: async () => value }) });
const leanOnly = (value) => ({ lean: async () => value });

const { noteNeverConnectedMention, noteOfflineMention } = require('../../../services/neverConnectedMentionService');

const NOW = new Date('2026-10-31T20:00:00.000Z');
const byoInstall = {
  agentName: 'nova',
  instanceId: 'default',
  installedBy: 'owner-1',
  status: 'active',
  config: { runtime: { host: 'byo', runtimeType: 'openclaw' } },
  runtimeTokens: [],
};
const botRow = (tokens = []) => ({
  _id: 'bot-1',
  username: 'nova',
  profilePicture: null,
  botMetadata: { displayName: 'Nova', instanceId: 'default' },
  agentRuntimeTokens: tokens,
});
const args = {
  podId: 'pod-1',
  agentName: 'nova',
  instanceId: 'default',
  senderId: 'human-1',
  messageId: '555',
  threadRootId: null,
  now: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUser.mockReturnValue(chain({ isBot: false }));
  mockFindInstall.mockReturnValue(leanOnly(byoInstall));
  mockFindBot.mockReturnValue(chain(botRow([])));
  mockHasLineToday.mockResolvedValue(false);
  mockEmitNotConnected.mockResolvedValue(undefined);
  mockEmitOffline.mockResolvedValue(undefined);
  mockHasOfflineSince.mockResolvedValue(false);
});

it('posts one not-connected line when a person mentions a BYO agent that never polled', async () => {
  const posted = await noteNeverConnectedMention(args);

  expect(posted).toBe(true);
  expect(mockHasLineToday).toHaveBeenCalledWith('pod-1', 'nova:default', NOW);
  expect(mockEmitNotConnected).toHaveBeenCalledTimes(1);
  expect(mockEmitNotConnected.mock.calls[0][0]).toMatchObject({
    podId: 'pod-1',
    actorUserId: 'bot-1',
    agentKey: 'nova:default',
    messageId: '555',
  });
});

it('says nothing with no message to hang it on, since the line is a reply to the mention', async () => {
  const posted = await noteNeverConnectedMention({ ...args, messageId: null });

  expect(posted).toBe(false);
  expect(mockEmitNotConnected).not.toHaveBeenCalled();
});

it('posts the line when the owner is the one who mentions it (TASK-722)', async () => {
  const posted = await noteNeverConnectedMention({ ...args, senderId: byoInstall.installedBy });

  expect(posted).toBe(true);
  expect(mockEmitNotConnected).toHaveBeenCalledTimes(1);
  expect(mockEmitNotConnected.mock.calls[0][0]).toMatchObject({ agentKey: 'nova:default', messageId: '555' });
});

it('stays silent for a bot sender', async () => {
  mockFindUser.mockReturnValue(chain({ isBot: true }));
  expect(await noteNeverConnectedMention(args)).toBe(false);
  expect(mockEmitNotConnected).not.toHaveBeenCalled();
});

it('stays silent once the agent has a live credential use', async () => {
  mockFindBot.mockReturnValue(chain(botRow([{ lastListenedAt: new Date(NOW.getTime() - 60 * 1000) }])));
  expect(await noteNeverConnectedMention(args)).toBe(false);
  expect(mockEmitNotConnected).not.toHaveBeenCalled();
});

it('stays silent when a line for this agent already sits in the pod today', async () => {
  mockHasLineToday.mockResolvedValue(true);
  expect(await noteNeverConnectedMention(args)).toBe(false);
  expect(mockEmitNotConnected).not.toHaveBeenCalled();
});

it('stays silent when there is no active install', async () => {
  mockFindInstall.mockReturnValue(leanOnly(null));
  expect(await noteNeverConnectedMention(args)).toBe(false);
  expect(mockEmitNotConnected).not.toHaveBeenCalled();
});

it('posts one line when the same agent is mentioned twice at once', async () => {
  const [a, b] = await Promise.all([
    noteNeverConnectedMention(args),
    noteNeverConnectedMention(args),
  ]);
  expect([a, b].filter(Boolean)).toHaveLength(1);
  expect(mockEmitNotConnected).toHaveBeenCalledTimes(1);
});

describe('a mention of a Bring your own agent that went offline (F300)', () => {
  const lastSeen = (ms) => mockFindBot.mockReturnValue(
    chain(botRow([{ lastListenedAt: new Date(NOW.getTime() - ms) }])),
  );
  const FIVE_HOURS = 5 * 60 * 60 * 1000;

  it('posts one line, as a reply to the mention, once the agent has stopped checking in', async () => {
    lastSeen(FIVE_HOURS);
    expect(await noteOfflineMention({ ...args, threadRootId: '77' })).toBe(true);
    expect(mockEmitOffline).toHaveBeenCalledTimes(1);
    expect(mockEmitOffline.mock.calls[0][0]).toMatchObject({
      podId: 'pod-1',
      actorUserId: 'bot-1',
      agentKey: 'nova:default',
      messageId: '555',
      threadRootId: '77',
    });
  });

  it('says nothing while the agent is listening', async () => {
    lastSeen(60 * 1000);
    expect(await noteOfflineMention(args)).toBe(false);
    expect(mockEmitOffline).not.toHaveBeenCalled();
  });

  it('leaves an agent that never connected to its own line', async () => {
    expect(await noteOfflineMention(args)).toBe(false);
    expect(mockEmitOffline).not.toHaveBeenCalled();
  });

  it('says it once a UTC day', async () => {
    lastSeen(FIVE_HOURS);
    mockHasOfflineSince.mockResolvedValue(true);
    expect(await noteOfflineMention(args)).toBe(false);
    expect(mockEmitOffline).not.toHaveBeenCalled();
    expect(mockHasOfflineSince).toHaveBeenCalledWith('pod-1', 'nova:default', new Date('2026-10-31T00:00:00.000Z'));
  });

  it('says it once when two mentions race', async () => {
    lastSeen(FIVE_HOURS);
    const results = await Promise.all([noteOfflineMention(args), noteOfflineMention(args)]);
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('tells a person only: an agent does not get told', async () => {
    lastSeen(FIVE_HOURS);
    mockFindUser.mockReturnValue(chain({ isBot: true }));
    expect(await noteOfflineMention(args)).toBe(false);
    expect(mockEmitOffline).not.toHaveBeenCalled();
  });

  it('says nothing with no message to reply to', async () => {
    lastSeen(FIVE_HOURS);
    expect(await noteOfflineMention({ ...args, messageId: null })).toBe(false);
    expect(mockEmitOffline).not.toHaveBeenCalled();
  });

  it('says nothing about a webhook or hosted agent, which has no listener to lose', async () => {
    lastSeen(FIVE_HOURS);
    mockFindInstall.mockReturnValue(leanOnly({
      ...byoInstall, config: { runtime: { runtimeType: 'webhook', host: 'byo', webhookUrl: 'https://x.test/hook' } },
    }));
    expect(await noteOfflineMention(args)).toBe(false);
    expect(mockEmitOffline).not.toHaveBeenCalled();
  });
});
