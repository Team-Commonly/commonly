// An agent last started without a sandbox answers only in pods that are
// invite-only, not public and not listed. When a pod stops qualifying, or a
// person @mentions such an agent in a pod that doesn't, the pod says so.

const mockFindUserById = jest.fn();
const mockFindBot = jest.fn();
const mockFindPod = jest.fn();
const mockFindInstalls = jest.fn();
const mockFindInstall = jest.fn();
const mockEmit = jest.fn();
const mockHasLine = jest.fn();

jest.mock('../../../models/User', () => ({
  findById: (...args) => mockFindUserById(...args),
  findOne: (...args) => mockFindBot(...args),
}));
jest.mock('../../../models/Pod', () => ({
  findById: (...args) => mockFindPod(...args),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: (...args) => mockFindInstalls(...args),
    findOne: (...args) => mockFindInstall(...args),
  },
}));
jest.mock('../../../services/systemActionLineService', () => ({
  emitUnsandboxedPodLine: (...args) => mockEmit(...args),
  hasUnsandboxedLineSince: (...args) => mockHasLine(...args),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentDisplayLabel: (user, fallback) => user?.botMetadata?.displayName || fallback,
}));

const chain = (value) => ({ select: () => ({ lean: async () => value }) });

const {
  podQualifiesForUnsandboxed, noteUnsandboxedPodSettingsChange, noteUnsandboxedMention,
} = require('../../../services/unsandboxedPodLineService');

const NOW = new Date('2026-11-14T20:00:00.000Z');
const PRIVATE = { publicRead: false, communityListed: false, joinPolicy: 'invite-only' };
const OPEN = { publicRead: false, communityListed: false, joinPolicy: 'open' };
const unconfinedBot = {
  _id: 'bot-1',
  username: 'codex-nova',
  profilePicture: null,
  botMetadata: {
    agentName: 'codex', instanceId: 'nova', displayName: 'Nova', hostUnconfined: true, 
  },
};
const mention = {
  podId: 'pod-1', agentName: 'codex', instanceId: 'nova', senderId: 'human-1', messageId: '555', threadRootId: null, now: NOW,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUserById.mockReturnValue(chain({ isBot: false }));
  mockFindBot.mockReturnValue(chain(unconfinedBot));
  mockFindPod.mockReturnValue(chain(OPEN));
  mockFindInstalls.mockReturnValue(chain([{ agentName: 'codex', instanceId: 'nova' }]));
  mockFindInstall.mockReturnValue(chain({ _id: 'inst-1' }));
  mockHasLine.mockResolvedValue(false);
  mockEmit.mockResolvedValue(undefined);
});

describe('podQualifiesForUnsandboxed', () => {
  it('reads the pod the way the CLI does', () => {
    expect(podQualifiesForUnsandboxed(PRIVATE)).toBe(true);
    expect(podQualifiesForUnsandboxed({ ...PRIVATE, joinPolicy: undefined })).toBe(false);
    expect(podQualifiesForUnsandboxed(OPEN)).toBe(false);
    expect(podQualifiesForUnsandboxed({ ...PRIVATE, publicRead: true })).toBe(false);
    expect(podQualifiesForUnsandboxed({ ...PRIVATE, communityListed: true })).toBe(false);
    expect(podQualifiesForUnsandboxed({ joinPolicy: 'invite-only' })).toBe(true);
    expect(podQualifiesForUnsandboxed(null)).toBe(false);
  });
});

describe('noteUnsandboxedPodSettingsChange', () => {
  it('posts one line per unsandboxed agent once the pod stops qualifying', async () => {
    expect(await noteUnsandboxedPodSettingsChange({ podId: 'pod-1', now: NOW })).toBe(1);
    expect(mockFindBot.mock.calls[0][0]).toMatchObject({
      isBot: true, 'botMetadata.agentName': 'codex', 'botMetadata.instanceId': 'nova', 'botMetadata.hostUnconfined': true,
    });
    expect(mockHasLine).toHaveBeenCalledWith('pod-1', 'codex:nova', new Date('2026-11-14T00:00:00.000Z'));
    expect(mockEmit.mock.calls[0][0]).toMatchObject({
      podId: 'pod-1', actorUserId: 'bot-1', actorIsBot: true, agentLabel: 'Nova', agentKey: 'codex:nova', messageId: null,
    });
  });

  it('says nothing while the pod still qualifies', async () => {
    mockFindPod.mockReturnValue(chain(PRIVATE));
    expect(await noteUnsandboxedPodSettingsChange({ podId: 'pod-1', now: NOW })).toBe(0);
    expect(mockFindInstalls).not.toHaveBeenCalled();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('skips agents that were not started without a sandbox', async () => {
    mockFindBot.mockReturnValue(chain(null));
    expect(await noteUnsandboxedPodSettingsChange({ podId: 'pod-1', now: NOW })).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('says it once a day, however often the owner toggles', async () => {
    mockHasLine.mockResolvedValue(true);
    expect(await noteUnsandboxedPodSettingsChange({ podId: 'pod-1', now: NOW })).toBe(0);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('reads only active installs, and a missing instance is default', async () => {
    mockFindInstalls.mockReturnValue(chain([{ agentName: 'codex' }]));
    await noteUnsandboxedPodSettingsChange({ podId: 'pod-1', now: NOW });
    expect(mockFindInstalls.mock.calls[0][0]).toEqual({ podId: 'pod-1', status: 'active' });
    expect(mockFindBot.mock.calls[0][0]).toMatchObject({ 'botMetadata.instanceId': 'default' });
  });
});

describe('noteUnsandboxedMention', () => {
  it('replies once to a person who mentions it in a pod that does not qualify', async () => {
    expect(await noteUnsandboxedMention(mention)).toBe(true);
    expect(mockEmit.mock.calls[0][0]).toMatchObject({
      podId: 'pod-1', agentKey: 'codex:nova', messageId: '555', threadRootId: null,
    });
    expect(mockFindInstall.mock.calls[0][0]).toEqual({
      podId: 'pod-1', agentName: 'codex', instanceId: 'nova', status: 'active',
    });
  });

  it.each([
    ['no message to reply to', () => {}, { messageId: null }],
    ['the agent was not started without a sandbox', () => mockFindBot.mockReturnValue(chain(null)), {}],
    ['an agent mentioned it', () => mockFindUserById.mockReturnValue(chain({ isBot: true })), {}],
    ['it is not installed here', () => mockFindInstall.mockReturnValue(chain(null)), {}],
    ['the pod qualifies', () => mockFindPod.mockReturnValue(chain(PRIVATE)), {}],
    ['a line already went out today', () => mockHasLine.mockResolvedValue(true), {}],
  ])('says nothing when %s', async (_why, arrange, override) => {
    arrange();
    expect(await noteUnsandboxedMention({ ...mention, ...override })).toBe(false);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('reads the pod first, so a mention in a pod that qualifies costs one read', async () => {
    mockFindPod.mockReturnValue(chain(PRIVATE));
    await noteUnsandboxedMention(mention);
    expect(mockFindPod).toHaveBeenCalledTimes(1);
    expect(mockFindBot).not.toHaveBeenCalled();
    expect(mockFindUserById).not.toHaveBeenCalled();
  });
});
