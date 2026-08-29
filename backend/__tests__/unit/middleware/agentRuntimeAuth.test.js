// agentRuntimeAuth path 2 (legacy installation-token) needs to surface ALL
// active AgentInstallation rows for the same (agentName, instanceId), not
// just the one whose runtimeTokens.tokenHash matches. Otherwise the /events
// endpoint silently filters out events for pods the token wasn't originally
// minted for — exact bug we hit when Cody's token from her old install
// couldn't see events from a new pod she'd been freshly installed into.
//
// jest.mock() factories may only reference variables whose name starts with
// `mock` (Jest's hoisting-safety allow-list), so every mock binding here is
// prefixed accordingly.

jest.mock('../../../middleware/auth', () => ({ touchLastActive: jest.fn() }));
const mockSecret = { hash: jest.fn(), randomSecret: jest.fn() };
jest.mock('../../../utils/secret', () => mockSecret);

const mockUserFindOne = jest.fn();
const mockUserUpdateOne = jest.fn();
const mockInstallationFindOne = jest.fn();
const mockInstallationFind = jest.fn();
const mockInstallationUpdateOne = jest.fn();
const mockInstallationUpdateMany = jest.fn();
const mockCompleteStarterTask = jest.fn();

jest.mock('../../../services/globalModelConfigService', () => ({
  getConfig: jest.fn(),
}));

jest.mock('../../../services/starterTaskService', () => ({
  completeConnectAgentStarterTask: (...args) => mockCompleteStarterTask(...args),
}));

jest.mock('../../../models/User', () => {
  function User() {}
  User.findOne = (...args) => mockUserFindOne(...args);
  User.updateOne = (...args) => mockUserUpdateOne(...args);
  return User;
});
// ADR-026 Phase 0: the middleware consults AgentCredential before the
// legacy paths. Default to no credential row — these tests exercise the
// legacy fallback; the credential paths have their own suite
// (agentCredential.substrate.test.js on mongodb-memory-server).
jest.mock('../../../models/AgentCredential', () => ({
  findOne: jest.fn().mockResolvedValue(null),
  findById: jest.fn().mockResolvedValue(null),
  updateOne: jest.fn().mockResolvedValue({}),
}));

jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => mockInstallationFindOne(...args),
    find: (...args) => mockInstallationFind(...args),
    updateOne: (...args) => mockInstallationUpdateOne(...args),
    updateMany: (...args) => mockInstallationUpdateMany(...args),
  },
}));
jest.mock('../../../models/Pod', () => ({
  find: () => ({ select: () => ({ lean: async () => [] }) }),
}));

const agentRuntimeAuth = require('../../../middleware/agentRuntimeAuth').default;
const GlobalModelConfigService = require('../../../services/globalModelConfigService');

const buildReq = (token) => {
  const headers = { authorization: `Bearer ${token}` };
  return {
    headers,
    header: (name) => headers[String(name).toLowerCase()],
  };
};
const buildRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  mockSecret.hash.mockReset();
  mockSecret.hash.mockReturnValue('hashed-token');
  mockUserFindOne.mockReset();
  mockUserUpdateOne.mockReset();
  mockUserUpdateOne.mockResolvedValue({});
  mockInstallationFindOne.mockReset();
  mockInstallationFind.mockReset();
  mockInstallationUpdateOne.mockReset();
  mockInstallationUpdateMany.mockReset();
  mockInstallationUpdateMany.mockResolvedValue({ modifiedCount: 0 });
  GlobalModelConfigService.getConfig.mockReset();
  GlobalModelConfigService.getConfig.mockResolvedValue({ openclaw: { devAgentIds: ['theo'] } });
  mockCompleteStarterTask.mockReset();
  mockCompleteStarterTask.mockResolvedValue(undefined);
});

describe('agentRuntimeAuth path 2 (install-bound token) — #66 fix', () => {
  test('surfaces ALL active installations for the same (agentName, instanceId), not just the matched one', async () => {
    mockUserFindOne.mockResolvedValue(null);
    const matchedInstall = {
      _id: 'install-a',
      agentName: 'codex',
      instanceId: 'cody',
      podId: { toString: () => 'pod-a' },
      runtimeTokens: [{ tokenHash: 'hashed-token' }],
    };
    const otherInstall = {
      _id: 'install-b',
      agentName: 'codex',
      instanceId: 'cody',
      podId: { toString: () => 'pod-b' },
      runtimeTokens: [{ tokenHash: 'different-hash' }],
    };
    mockInstallationFindOne.mockResolvedValue(matchedInstall);
    mockInstallationFind.mockResolvedValue([matchedInstall, otherInstall]);
    mockInstallationUpdateOne.mockResolvedValue({});

    const req = buildReq('cm_agent_test');
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(mockInstallationFind).toHaveBeenCalledWith({
      agentName: 'codex',
      instanceId: 'cody',
      status: 'active',
    });
    expect(req.agentInstallations).toHaveLength(2);
    expect(req.agentAuthorizedPodIds).toEqual(['pod-a', 'pod-b']);
    expect(req.agentInstallation).toBe(matchedInstall);
    expect(next).toHaveBeenCalled();
    // The matched token had no lastUsedAt → first-ever use → the
    // connect-agent starter task fires for every authorized pod (#916).
    expect(mockCompleteStarterTask).toHaveBeenCalledWith({
      podIds: ['pod-a', 'pod-b'],
      agentLabel: 'codex',
    });
  });

  test('does not fire the starter hook when the token was used before (#916)', async () => {
    mockUserFindOne.mockResolvedValue(null);
    mockInstallationFindOne.mockResolvedValue({
      _id: 'install-a',
      agentName: 'codex',
      instanceId: 'cody',
      podId: { toString: () => 'pod-a' },
      runtimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date('2026-08-01T00:00:00Z') }],
    });
    mockInstallationFind.mockResolvedValue([]);
    mockInstallationUpdateOne.mockResolvedValue({});

    await agentRuntimeAuth(buildReq('cm_agent_test'), buildRes(), jest.fn());

    expect(mockCompleteStarterTask).not.toHaveBeenCalled();
  });

  test('backfills a configured dev seat on the legacy installation-token path too', async () => {
    mockUserFindOne.mockResolvedValue(null);
    const matchedInstall = {
      _id: 'install-theo',
      agentName: 'openclaw',
      instanceId: 'theo',
      podId: { toString: () => 'pod-workspace' },
      githubIssueWrite: false,
      runtimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date('2026-08-01T00:00:00Z') }],
    };
    mockInstallationFindOne.mockResolvedValue(matchedInstall);
    mockInstallationFind.mockResolvedValue([matchedInstall]);
    mockInstallationUpdateOne.mockResolvedValue({});

    const req = buildReq('cm_agent_legacy_dev');
    await agentRuntimeAuth(req, buildRes(), jest.fn());

    expect(mockInstallationUpdateMany).toHaveBeenCalledWith(
      {
        agentName: 'openclaw',
        instanceId: 'theo',
        status: 'active',
        githubIssueWrite: { $ne: true },
      },
      { $set: { githubIssueWrite: true } },
    );
    expect(req.agentUser).toBeUndefined();
    expect(req.agentInstallations).toEqual([
      expect.objectContaining({ githubIssueWrite: true }),
    ]);
  });
});

describe('agentRuntimeAuth path 1 (User-row token) — first-use starter hook (#916)', () => {
  const buildAgentUser = (lastUsedAt) => ({
    _id: 'bot-user-1',
    username: 'my-byo-agent',
    isBot: true,
    botMetadata: { agentName: 'my-byo-agent', instanceId: 'default', displayName: 'My BYO Agent' },
    agentRuntimeTokens: [{ tokenHash: 'hashed-token', ...(lastUsedAt ? { lastUsedAt } : {}) }],
  });

  test('fires once, with the installation podIds and the display label', async () => {
    mockUserFindOne.mockResolvedValue(buildAgentUser(null));
    mockInstallationFind.mockReturnValue({
      lean: async () => [
        { podId: { toString: () => 'pod-workspace' }, status: 'active' },
      ],
    });

    const req = buildReq('cm_agent_test');
    const next = jest.fn();
    await agentRuntimeAuth(req, buildRes(), next);

    expect(next).toHaveBeenCalled();
    expect(mockCompleteStarterTask).toHaveBeenCalledWith({
      podIds: ['pod-workspace'],
      agentLabel: 'My BYO Agent',
    });
  });

  test('stays silent on every subsequent authentication', async () => {
    mockUserFindOne.mockResolvedValue(buildAgentUser(new Date('2026-08-12T00:00:00Z')));
    mockInstallationFind.mockReturnValue({
      lean: async () => [
        { podId: { toString: () => 'pod-workspace' }, status: 'active' },
      ],
    });

    await agentRuntimeAuth(buildReq('cm_agent_test'), buildRes(), jest.fn());

    expect(mockCompleteStarterTask).not.toHaveBeenCalled();
  });

  test('returns 401 when token doesnt match any install OR user', async () => {
    mockUserFindOne.mockResolvedValue(null);
    mockInstallationFindOne.mockResolvedValue(null);

    const req = buildReq('cm_agent_bogus');
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('backfills the server-owned GitHub write grant for an existing configured dev seat before routes inspect it', async () => {
    mockUserFindOne.mockResolvedValue({
      _id: 'bot-user-1',
      username: 'openclaw-theo',
      isBot: true,
      botMetadata: { agentName: 'openclaw', instanceId: 'theo' },
      agentRuntimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date('2026-08-01T00:00:00Z') }],
    });
    mockInstallationFind.mockReturnValue({
      lean: async () => [{
        _id: 'install-theo',
        podId: { toString: () => 'pod-workspace' },
        githubIssueWrite: false,
      }],
    });

    const req = buildReq('cm_agent_dev');
    await agentRuntimeAuth(req, buildRes(), jest.fn());

    expect(mockInstallationUpdateMany).toHaveBeenCalledWith(
      {
        agentName: 'openclaw',
        instanceId: 'theo',
        status: 'active',
        githubIssueWrite: { $ne: true },
      },
      { $set: { githubIssueWrite: true } },
    );
    expect(req.agentInstallations).toEqual([
      expect.objectContaining({ githubIssueWrite: true }),
    ]);
  });

  test('does not backfill GitHub write access for a non-dev OpenClaw seat', async () => {
    mockUserFindOne.mockResolvedValue({
      _id: 'bot-user-1',
      username: 'openclaw-community',
      isBot: true,
      botMetadata: { agentName: 'openclaw', instanceId: 'community' },
      agentRuntimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date('2026-08-01T00:00:00Z') }],
    });
    mockInstallationFind.mockReturnValue({
      lean: async () => [{
        _id: 'install-community',
        podId: { toString: () => 'pod-workspace' },
        githubIssueWrite: false,
      }],
    });

    const req = buildReq('cm_agent_community');
    await agentRuntimeAuth(req, buildRes(), jest.fn());

    expect(mockInstallationUpdateMany).not.toHaveBeenCalled();
    expect(req.agentInstallations).toEqual([
      expect.objectContaining({ githubIssueWrite: false }),
    ]);
  });

  test('does not backfill GitHub write access for a non-OpenClaw identity using a dev-seat label', async () => {
    mockUserFindOne.mockResolvedValue({
      _id: 'bot-user-1',
      username: 'codex-theo',
      isBot: true,
      botMetadata: { agentName: 'codex', instanceId: 'theo' },
      agentRuntimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date('2026-08-01T00:00:00Z') }],
    });
    mockInstallationFind.mockReturnValue({
      lean: async () => [{
        _id: 'install-codex-theo',
        podId: { toString: () => 'pod-workspace' },
        githubIssueWrite: false,
      }],
    });

    const req = buildReq('cm_agent_non_openclaw');
    await agentRuntimeAuth(req, buildRes(), jest.fn());

    expect(mockInstallationUpdateMany).not.toHaveBeenCalled();
    expect(req.agentInstallations).toEqual([
      expect.objectContaining({ githubIssueWrite: false }),
    ]);
  });
});
