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
const mockCredentialFindOne = jest.fn();
const mockCredentialFindById = jest.fn();

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
  findOne: (...args) => mockCredentialFindOne(...args),
  findById: (...args) => mockCredentialFindById(...args),
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
  mockCredentialFindOne.mockReset().mockResolvedValue(null);
  mockCredentialFindById.mockReset();
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

  test('a refused first legacy call does not consume first-use completion; an allowed call completes it once', async () => {
    const installation = setupLegacy();
    installation.installedBy = 'human-a';
    installation.runtimeTokens[0].lastUsedAt = undefined;
    mockInstallationUpdateOne.mockImplementation(async () => {
      installation.runtimeTokens[0].lastUsedAt = new Date();
    });
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/agent-dm' }, params: {} });
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockInstallationUpdateOne).not.toHaveBeenCalled();
    expect(mockMarkByoConnectionAttempt).not.toHaveBeenCalled();
    expect(mockCompleteStarterTask).not.toHaveBeenCalled();

    req.route.path = '/pods/:podId/messages';
    req.params.podId = 'pod-a';
    await agentRuntimeAuth(req, res, next);
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(mockMarkByoConnectionAttempt).toHaveBeenCalledTimes(1);
    expect(mockCompleteStarterTask).toHaveBeenCalledTimes(1);
  });

  test('a refused first User-row call leaves its starter completion for an allowed call', async () => {
    const bot = {
      _id: 'bot-a', isBot: true,
      botMetadata: { agentName: 'codex', instanceId: 'rivet' },
      agentRuntimeTokens: [{ tokenHash: 'hashed-token' }],
    };
    mockUserFindOne.mockResolvedValue(bot);
    mockUserUpdateOne.mockImplementation(async () => {
      bot.agentRuntimeTokens[0].lastUsedAt = new Date();
    });
    mockInstallationFind.mockReturnValue({ lean: async () => [{
      podId: { toString: () => 'pod-a' }, installedBy: 'human-a', status: 'active',
    }] });
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/agent-dm' }, params: {} });
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(mockUserUpdateOne).not.toHaveBeenCalled();
    expect(mockMarkByoConnectionAttempt).not.toHaveBeenCalled();
    expect(mockCompleteStarterTask).not.toHaveBeenCalled();

    req.route.path = '/pods/:podId/messages';
    req.params.podId = 'pod-a';
    await agentRuntimeAuth(req, res, next);
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(mockMarkByoConnectionAttempt).toHaveBeenCalledTimes(1);
    expect(mockCompleteStarterTask).toHaveBeenCalledTimes(1);
  });

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

  test('failed route pod lookup refuses a write even when one grant pod is known', async () => {
    setupLegacy();
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    mockEnsembleFindById.mockReturnValue({ select: () => ({ lean: async () => {
      throw new Error('ensemble DB unavailable');
    } }) });
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/pods',
      route: { path: '/:podId/ensemble/response' }, params: { podId: 'pod-a' },
      body: { ensembleId: 'ensemble-a', content: 'write' } });
    const res = buildRes();
    const next = jest.fn();
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await agentRuntimeAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
        code: 'outsider_grant_runtime_narrowed', routeClass: 'unknown',
      }));
      expect(next).not.toHaveBeenCalled();
    } finally { log.mockRestore(); }
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

  test('two grant pods still permit a private-only memory update', async () => {
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
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('spawn maintenance and event acknowledgement remain available across two grant pods', async () => {
    setupLegacy();
    mockInstallationFind.mockResolvedValue([
      { podId: { toString: () => 'pod-a' } },
      { podId: { toString: () => 'pod-b' } },
    ]);
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a', 'pod-b']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime/spawn-credentials',
      route: { path: '/' }, params: {} });
    const res = buildRes();
    const next = jest.fn();
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    req.baseUrl = '/api/agents/runtime';
    req.route.path = '/events/:id/ack';
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(res.status).not.toHaveBeenCalled();
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

  const narrowedRoute = () => {
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/agent-dm' }, params: {} });
    mockInstallationFind.mockReturnValue({
      lean: async () => [{ podId: { toString: () => 'pod-workspace' }, status: 'active' }],
    });
    mockNarrowedPods.mockResolvedValue(new Set(['pod-workspace']));
    return req;
  };

  test('refuses an outward call for an embedded User agent token', async () => {
    const bot = buildAgentUser(new Date('2026-08-12T00:00:00Z'));
    mockUserFindOne.mockResolvedValue(bot);
    const req = narrowedRoute();
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(req.agentUser).toBe(bot);
    expect(req.agentCredential).toBeNull();
    expect(mockInstallationFindOne).not.toHaveBeenCalled();
    expect(mockNarrowedPods).toHaveBeenCalledWith(['pod-workspace']);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'outsider_grant_runtime_narrowed' }));
    expect(next).not.toHaveBeenCalled();
  });

  test('refuses an outward call for a spawn-scoped AgentCredential row', async () => {
    const bot = { ...buildAgentUser(null), agentRuntimeTokens: [] };
    const child = { _id: 'credential-child', kind: 'runtime', status: 'active',
      parentId: 'credential-parent', scopes: ['spawn'], agentUserId: bot._id };
    mockCredentialFindOne.mockResolvedValue(child);
    mockCredentialFindById.mockReturnValue({ select: () => ({ lean: async () => ({ status: 'active' }) }) });
    mockUserFindOne.mockResolvedValueOnce(null).mockResolvedValueOnce(bot);
    const req = narrowedRoute();
    const res = buildRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(req.agentUser).toBe(bot);
    expect(req.agentCredential).toBe(child);
    expect(mockInstallationFindOne).not.toHaveBeenCalled();
    expect(mockNarrowedPods).toHaveBeenCalledWith(['pod-workspace']);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'outsider_grant_runtime_narrowed' }));
    expect(next).not.toHaveBeenCalled();
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
