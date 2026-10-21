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
const mockCompleteStarterTask = jest.fn();
const mockMarkByoConnectionAttempt = jest.fn();
const mockNarrowedPods = jest.fn();
const mockEnsembleFindById = jest.fn();

jest.mock('../../../models/AgentEnsembleState', () => ({
  findById: (...args) => mockEnsembleFindById(...args),
}));

jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podsWithOutsiderWritableGrants: (...args) => mockNarrowedPods(...args),
}));

jest.mock('../../../services/starterTaskService', () => ({
  completeConnectAgentStarterTask: (...args) => mockCompleteStarterTask(...args),
}));
jest.mock('../../../services/onboardingMarks', () => ({
  markByoConnectionAttempt: (...args) => mockMarkByoConnectionAttempt(...args),
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
  },
}));
jest.mock('../../../models/Pod', () => ({
  find: () => ({ select: () => ({ lean: async () => [] }) }),
}));

const agentRuntimeAuth = require('../../../middleware/agentRuntimeAuth').default;

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
  mockNarrowedPods.mockReset().mockResolvedValue(new Set());
  mockEnsembleFindById.mockReset();
  mockSecret.hash.mockReset();
  mockSecret.hash.mockReturnValue('hashed-token');
  mockUserFindOne.mockReset();
  mockUserUpdateOne.mockReset();
  mockUserUpdateOne.mockResolvedValue({});
  mockInstallationFindOne.mockReset();
  mockInstallationFind.mockReset();
  mockInstallationUpdateOne.mockReset();
  mockCompleteStarterTask.mockReset();
  mockCompleteStarterTask.mockResolvedValue(undefined);
  mockMarkByoConnectionAttempt.mockReset();
});

describe('TASK-213 runtime token narrowing', () => {
  const setupLegacy = () => {
    mockUserFindOne.mockResolvedValue(null);
    const installation = {
      _id: 'install-a', agentName: 'codex', instanceId: 'rivet',
      podId: { toString: () => 'pod-a' }, runtimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date() }],
    };
    mockInstallationFindOne.mockResolvedValue(installation);
    mockInstallationFind.mockResolvedValue([installation]);
    mockInstallationUpdateOne.mockResolvedValue({});
    return installation;
  };

  test('allows a write into the one grant pod and refuses another pod', async () => {
    setupLegacy();
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/pods/:podId/messages' }, params: { podId: 'pod-b' } });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'outsider_grant_runtime_narrowed' }));
    req.params.podId = 'pod-a';
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('unknown GET fails closed, but listed read passes', async () => {
    setupLegacy();
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'GET', baseUrl: '/api/agents/runtime',
      route: { path: '/future-read' }, params: {} });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    req.route.path = '/installations';
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('a post without a pod and an outward DM are refused', async () => {
    setupLegacy();
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/posts' }, params: {}, body: { content: 'x' } });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    req.route.path = '/agent-dm';
    await agentRuntimeAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledTimes(2);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('ensemble path in P cannot write into an ensemble stored in Q', async () => {
    setupLegacy();
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    mockEnsembleFindById.mockReturnValue({ select: () => ({ lean: async () => ({ podId: 'pod-b' }) }) });
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/pods',
      route: { path: '/:podId/ensemble/response' }, params: { podId: 'pod-a' },
      body: { ensembleId: 'ensemble-b', content: 'cross-pod' } });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(mockEnsembleFindById).toHaveBeenCalledWith('ensemble-b');
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  test('failed grant census narrows the agent', async () => {
    setupLegacy();
    mockNarrowedPods.mockRejectedValue(new Error('grant DB unavailable'));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/agent-dm' }, params: {} });
    const res = buildRes();
    const next = jest.fn();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await agentRuntimeAuth(req, res, next);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    } finally { log.mockRestore(); }
  });

  test('two grant pods refuse even a contained write, while revocation lifts the gate', async () => {
    setupLegacy();
    mockInstallationFind.mockResolvedValue([
      { podId: { toString: () => 'pod-a' } },
      { podId: { toString: () => 'pod-b' } },
    ]);
    mockNarrowedPods.mockResolvedValueOnce(new Set(['pod-a', 'pod-b']))
      .mockResolvedValueOnce(new Set());
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/pods/:podId/messages' }, params: { podId: 'pod-a' } });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'outsider_grant_runtime_narrowed', podIds: ['pod-a', 'pod-b'],
    }));
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('two grant pods refuse a private memory write too', async () => {
    setupLegacy();
    mockInstallationFind.mockResolvedValue([
      { podId: { toString: () => 'pod-a' } },
      { podId: { toString: () => 'pod-b' } },
    ]);
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a', 'pod-b']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'PUT', baseUrl: '/api/agents/runtime',
      route: { path: '/memory' }, params: {},
      body: { sections: { long_term: { visibility: 'private', content: 'x' } } } });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('spawn maintenance is available in one grant pod, but not across two', async () => {
    setupLegacy();
    mockInstallationFind.mockResolvedValue([
      { podId: { toString: () => 'pod-a' } },
      { podId: { toString: () => 'pod-b' } },
    ]);
    mockNarrowedPods.mockResolvedValueOnce(new Set(['pod-a']))
      .mockResolvedValueOnce(new Set(['pod-a', 'pod-b']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime/spawn-credentials',
      route: { path: '/' }, params: {} });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe('agentRuntimeAuth path 2 (install-bound token) — #66 fix', () => {
  test('surfaces ALL active installations for the same (agentName, instanceId), not just the matched one', async () => {
    mockUserFindOne.mockResolvedValue(null);
    const matchedInstall = {
      _id: 'install-a',
      agentName: 'codex',
      instanceId: 'cody',
      installedBy: 'human-a',
      podId: { toString: () => 'pod-a' },
      config: { runtime: { host: 'byo', runtimeType: 'webhook' } },
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
    expect(mockMarkByoConnectionAttempt).toHaveBeenCalledWith('human-a', matchedInstall);
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
        {
          podId: { toString: () => 'pod-workspace' },
          status: 'active',
          installedBy: 'human-1',
          config: { runtime: { host: 'byo', runtimeType: 'webhook' } },
        },
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
    expect(mockMarkByoConnectionAttempt).toHaveBeenCalledWith(
      'human-1',
      expect.objectContaining({ podId: expect.anything(), installedBy: 'human-1' }),
    );
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

  test('rejects a User-row token left by an older uninstall with no active installations', async () => {
    mockUserFindOne.mockResolvedValue(buildAgentUser(new Date('2026-08-12T00:00:00Z')));
    mockInstallationFind.mockReturnValue({ lean: async () => [] });
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(buildReq('cm_agent_test'), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
