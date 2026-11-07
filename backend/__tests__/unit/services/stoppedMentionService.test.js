// F297: a person who @s an agent its owner stopped gets one quiet line. Growth's
// Hosted Stop walk: no reply in 45s and nothing in the pod, which to anyone but
// the owner reads as being ignored.

const mockEffectiveInstall = jest.fn();
const mockFindBot = jest.fn();
const mockEmitStopped = jest.fn();
const mockHasLineSince = jest.fn();
const mockEmitRemoved = jest.fn();
const mockHasRemovedSince = jest.fn();

jest.mock('../../../models/User', () => ({ findOne: (...args) => mockFindBot(...args) }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { distinct: () => ({ collation: async () => [] }) },
}));
jest.mock('../../../services/agentEventService', () => ({
  resolveEffectiveInstallation: (...args) => mockEffectiveInstall(...args),
}));
jest.mock('../../../services/systemActionLineService', () => ({
  emitStoppedLine: (...args) => mockEmitStopped(...args),
  hasStoppedLineSince: (...args) => mockHasLineSince(...args),
  emitRemovedLine: (...args) => mockEmitRemoved(...args),
  hasRemovedLineSince: (...args) => mockHasRemovedSince(...args),
}));

const { noteStoppedMention, noteUnreachableAgentDm } = require('../../../services/stoppedMentionService');

const NOW = new Date('2026-11-06T20:00:00.000Z');
const STOPPED_AT = new Date('2026-11-06T19:00:00.000Z');
const hostedInstall = (hosted = { engine: 'native', provisionedAt: null, deprovisionedAt: STOPPED_AT }) => ({
  agentName: 'nova',
  instanceId: 'default',
  status: 'active',
  config: { runtime: { runtimeType: 'hosted' }, hosted },
});
const botRow = (botMetadata = {}) => ({
  _id: 'bot-1',
  username: 'nova',
  profilePicture: null,
  botMetadata: { displayName: 'Nova', instanceId: 'default', ...botMetadata },
});
const args = {
  podId: 'pod-1', agentName: 'nova', instanceId: 'default', messageId: '555', threadRootId: null, now: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEffectiveInstall.mockResolvedValue(hostedInstall());
  mockFindBot.mockReturnValue({ select: () => ({ lean: async () => botRow() }) });
  mockHasLineSince.mockResolvedValue(false);
  mockEmitStopped.mockResolvedValue(undefined);
  mockEmitRemoved.mockResolvedValue(undefined);
  mockHasRemovedSince.mockResolvedValue(false);
});

it('posts one line, as a reply to the mention, naming the agent', async () => {
  expect(await noteStoppedMention({ ...args, threadRootId: '77' })).toBe(true);
  expect(mockEmitStopped).toHaveBeenCalledTimes(1);
  expect(mockEmitStopped.mock.calls[0][0]).toMatchObject({
    podId: 'pod-1',
    actorUserId: 'bot-1',
    agentLabel: 'Nova',
    agentKey: 'nova:default',
    messageId: '555',
    threadRootId: '77',
  });
});

it('a running agent gets nothing and costs no line read', async () => {
  mockEffectiveInstall.mockResolvedValue(
    hostedInstall({ engine: 'native', provisionedAt: NOW, deprovisionedAt: STOPPED_AT }),
  );
  expect(await noteStoppedMention(args)).toBe(false);
  expect(mockHasLineSince).not.toHaveBeenCalled();
  expect(mockEmitStopped).not.toHaveBeenCalled();
});

it('a hosted row that was never provisioned has no stop to report', async () => {
  mockEffectiveInstall.mockResolvedValue(hostedInstall({ engine: 'native', provisionedAt: null }));
  expect(await noteStoppedMention(args)).toBe(false);
  expect(mockEmitStopped).not.toHaveBeenCalled();
});

it('a daemon seat sharing the identity is still running, so nothing says it stopped', async () => {
  mockFindBot.mockReturnValue({ select: () => ({ lean: async () => botRow({ machineId: 'machine-1' }) }) });
  expect(await noteStoppedMention(args)).toBe(false);
  expect(mockEmitStopped).not.toHaveBeenCalled();
});

it('no active install here: nothing', async () => {
  mockEffectiveInstall.mockResolvedValue(null);
  expect(await noteStoppedMention(args)).toBe(false);
  expect(mockEmitStopped).not.toHaveBeenCalled();
});

it('a line already there covers the next mention', async () => {
  mockHasLineSince.mockResolvedValue(true);
  expect(await noteStoppedMention(args)).toBe(false);
  expect(mockEmitStopped).not.toHaveBeenCalled();
});

it('a stop today is checked from the stop, so stopping again says so again', async () => {
  await noteStoppedMention(args);
  expect(mockHasLineSince).toHaveBeenCalledWith('pod-1', 'nova:default', STOPPED_AT);
});

it('a stop on an earlier day is checked from midnight, so a new day says so once', async () => {
  mockEffectiveInstall.mockResolvedValue(hostedInstall({
    engine: 'native', provisionedAt: null, deprovisionedAt: new Date('2026-11-01T10:00:00.000Z'),
  }));
  await noteStoppedMention(args);
  expect(mockHasLineSince).toHaveBeenCalledWith('pod-1', 'nova:default', new Date('2026-11-06T00:00:00.000Z'));
});

it('two mentions racing in one process post one line', async () => {
  let release;
  mockHasLineSince.mockReturnValue(new Promise((resolve) => { release = resolve; }));
  const first = noteStoppedMention(args);
  await new Promise((resolve) => { setImmediate(resolve); });
  const second = await noteStoppedMention(args);
  release(false);
  expect(second).toBe(false);
  expect(await first).toBe(true);
  expect(mockEmitStopped).toHaveBeenCalledTimes(1);
});

it('a stop whose time is unreadable still tells the room, checked from midnight', async () => {
  mockEffectiveInstall.mockResolvedValue(hostedInstall({
    engine: 'native', provisionedAt: null, deprovisionedAt: 'not a date',
  }));
  expect(await noteStoppedMention(args)).toBe(true);
  expect(mockHasLineSince.mock.calls[0][2]).toEqual(new Date('2026-11-06T00:00:00.000Z'));
});

it('asks what routing asks, so a row with no runtime of its own reads as its source does', async () => {
  await noteStoppedMention(args);
  expect(mockEffectiveInstall).toHaveBeenCalledWith('nova', 'default', 'pod-1');
});

it('a comment on a post has no message to answer, so nothing is asked', async () => {
  expect(await noteStoppedMention({ ...args, messageId: null })).toBe(false);
  expect(mockEffectiveInstall).not.toHaveBeenCalled();
  expect(mockEmitStopped).not.toHaveBeenCalled();
});

describe('a DM to an agent nobody has installed any more (F270)', () => {
  it('posts one line, as a reply to the message, naming the agent', async () => {
    expect(await noteUnreachableAgentDm({ ...args, threadRootId: '77' })).toBe(true);
    expect(mockEmitRemoved.mock.calls).toHaveLength(1);
    expect(mockEmitRemoved.mock.calls[0][0]).toMatchObject({
      podId: 'pod-1',
      actorUserId: 'bot-1',
      agentLabel: 'Nova',
      agentKey: 'nova:default',
      messageId: '555',
      threadRootId: '77',
    });
  });

  it('says it once a UTC day, so a person who keeps typing hears it once', async () => {
    mockHasRemovedSince.mockResolvedValue(true);
    expect(await noteUnreachableAgentDm(args)).toBe(false);
    expect(mockEmitRemoved).not.toHaveBeenCalled();
    expect(mockHasRemovedSince).toHaveBeenCalledWith('pod-1', 'nova:default', new Date('2026-11-06T00:00:00.000Z'));
  });

  it('stays quiet with no message to reply to', async () => {
    expect(await noteUnreachableAgentDm({ ...args, messageId: null })).toBe(false);
    expect(mockEmitRemoved).not.toHaveBeenCalled();
  });

  it('stays quiet when the agent has no user row to speak as', async () => {
    mockFindBot.mockReturnValue({ select: () => ({ lean: async () => null }) });
    expect(await noteUnreachableAgentDm(args)).toBe(false);
    expect(mockEmitRemoved).not.toHaveBeenCalled();
  });

  it('says it once when two messages race', async () => {
    const [first, second] = await Promise.all([noteUnreachableAgentDm(args), noteUnreachableAgentDm(args)]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(mockEmitRemoved).toHaveBeenCalledTimes(1);
  });
});
