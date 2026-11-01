// These unit cases isolate runtime identity behavior. The deletion fence is
// exercised with real models in service/accountDeletion.test.js.
jest.mock('../../../services/accountDeletionState', () => ({ isAccountDeleting: jest.fn().mockResolvedValue(false) }));
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
const mockRecordByoEvent = jest.fn();
const mockNarrowedPods = jest.fn();
const mockEnsembleFindById = jest.fn();
const mockMessageFindById = jest.fn();
const mockCredentialFindOne = jest.fn();
const mockCredentialFindById = jest.fn();

jest.mock('../../../models/AgentEnsembleState', () => ({
  findById: (...args) => mockEnsembleFindById(...args),
}));
jest.mock('../../../models/pg/Message', () => ({
  findById: (...args) => mockMessageFindById(...args),
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
jest.mock('../../../services/byoTelemetry', () => ({
  recordByoEvent: (...args) => mockRecordByoEvent(...args),
  seatRegisteredKey: () => `seat-registered:${'a'.repeat(64)}`,
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
const { touchLastActive } = require('../../../middleware/auth');
const { agentAuthRefusalCounts, resetAgentAuthRefusalsForTest } = require('../../../services/agentAuthRefusals');

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
  mockMessageFindById.mockReset();
  mockCredentialFindOne.mockReset().mockResolvedValue(null);
  mockCredentialFindById.mockReset();
  require('../../../models/AgentCredential').updateOne.mockClear();
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

  test('a refused legacy call leaves the seat\'s last-active time alone', async () => {
    setupLegacy();
    touchLastActive.mockClear();
    mockUserFindOne.mockImplementation(async (query) => (query?.['botMetadata.agentName'] ? { _id: 'bot-rivet' } : null));
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/pods/:podId/messages' }, params: { podId: 'pod-b' } });
    const next = jest.fn();
    await agentRuntimeAuth(req, buildRes(), next);
    expect(next).not.toHaveBeenCalled();
    expect(touchLastActive).not.toHaveBeenCalled();
    req.params.podId = 'pod-a';
    await agentRuntimeAuth(req, buildRes(), next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(touchLastActive).toHaveBeenCalledWith('bot-rivet');
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

  test('two grant pods refuse private memory metadata visible to other agents', async () => {
    setupLegacy();
    mockInstallationFind.mockResolvedValue([
      { podId: { toString: () => 'pod-a' } },
      { podId: { toString: () => 'pod-b' } },
    ]);
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a', 'pod-b']));
    for (const [method, routePath, mode] of [
      ['PUT', '/memory', undefined],
      ['POST', '/memory/sync', 'patch'],
    ]) {
      const req = buildReq('cm_agent_test');
      Object.assign(req, { method, baseUrl: '/api/agents/runtime',
        route: { path: routePath }, params: {},
        body: { sections: { long_term: { visibility: 'private', content: 'x' } },
          sourceRuntime: 'caller-controlled', ...(mode ? { mode } : {}) } });
      const res = buildRes();
      const next = jest.fn();
      await agentRuntimeAuth(req, res, next);
      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    }
  });

  test('claim release uses the stored message pod despite a forged body pod', async () => {
    setupLegacy();
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'DELETE', baseUrl: '/api/agents/runtime',
      route: { path: '/messages/:messageId/claim' },
      params: { messageId: 'message-b' }, body: { podId: 'pod-a' } });
    const res = buildRes();
    const next = jest.fn();
    mockMessageFindById.mockResolvedValue({ pod_id: 'pod-b' });
    await agentRuntimeAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
    mockMessageFindById.mockResolvedValueOnce({ pod_id: 'pod-a' });
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test.each(['legacy', 'User-row'])('refused %s credential calls do not mark the credential used', async (shape) => {
    setupLegacy();
    if (shape === 'User-row') {
      mockUserFindOne.mockResolvedValue({
        _id: 'bot-a', isBot: true,
        botMetadata: { agentName: 'codex', instanceId: 'rivet' },
        agentRuntimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date() }],
      });
      mockInstallationFind.mockReturnValue({ lean: async () => [{
        podId: { toString: () => 'pod-a' }, status: 'active',
      }] });
    }
    mockCredentialFindOne.mockResolvedValue({ _id: 'credential-a', kind: 'runtime', status: 'active' });
    mockNarrowedPods.mockResolvedValue(new Set(['pod-a']));
    const req = buildReq('cm_agent_test');
    Object.assign(req, { method: 'POST', baseUrl: '/api/agents/runtime',
      route: { path: '/agent-dm' }, params: {} });
    const res = buildRes();
    const next = jest.fn();
    const credentialUpdate = require('../../../models/AgentCredential').updateOne;
    await agentRuntimeAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(credentialUpdate).not.toHaveBeenCalled();
    req.route.path = '/pods/:podId/messages';
    req.params.podId = 'pod-a';
    await agentRuntimeAuth(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(credentialUpdate).toHaveBeenCalledWith(
      { _id: 'credential-a' }, { $set: { lastUsedAt: expect.any(Date) } },
    );
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
  test('a default-instance legacy token enumerates older installations with no stored instanceId', async () => {
    mockUserFindOne.mockResolvedValue(null);
    const matched = { _id: 'install-a', agentName: 'scout', instanceId: 'default',
      podId: { toString: () => 'pod-a' }, runtimeTokens: [{ tokenHash: 'hashed-token', lastUsedAt: new Date() }] };
    const older = { _id: 'install-b', agentName: 'scout',
      podId: { toString: () => 'pod-b' }, runtimeTokens: [] };
    mockInstallationFindOne.mockResolvedValue(matched);
    mockInstallationFind.mockResolvedValue([matched, older]);
    mockInstallationUpdateOne.mockResolvedValue({});
    const req = buildReq('cm_agent_test');
    const next = jest.fn();
    await agentRuntimeAuth(req, buildRes(), next);
    expect(mockInstallationFind).toHaveBeenCalledWith({
      agentName: 'scout', $or: [{ instanceId: 'default' }, { instanceId: null }], status: 'active',
    });
    expect(req.agentAuthorizedPodIds).toEqual(['pod-a', 'pod-b']);
    expect(next).toHaveBeenCalled();
  });

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
    // Backend-side seat-registered row, written once for the first use of the token.
    expect(mockRecordByoEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordByoEvent).toHaveBeenCalledWith('human-a', 'seat-registered', {}, expect.stringMatching(/^seat-registered:[0-9a-f]{64}$/));
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
    expect(mockRecordByoEvent).not.toHaveBeenCalled();
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

  test('default-instance User token includes legacy installation pods in its grant census', async () => {
    mockUserFindOne.mockResolvedValue(buildAgentUser(new Date('2026-08-12T00:00:00Z')));
    mockInstallationFind.mockReturnValue({ lean: async () => [
      { podId: { toString: () => 'pod-a' }, instanceId: 'default' },
      { podId: { toString: () => 'pod-b' } },
    ] });
    const next = jest.fn();
    await agentRuntimeAuth(buildReq('cm_agent_test'), buildRes(), next);
    expect(mockInstallationFind).toHaveBeenCalledWith({
      agentName: 'my-byo-agent', $or: [{ instanceId: 'default' }, { instanceId: null }], status: 'active',
    });
    expect(mockNarrowedPods).toHaveBeenCalledWith(['pod-a', 'pod-b']);
    expect(next).toHaveBeenCalled();
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
    touchLastActive.mockClear();
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
    // A refused call is not activity.
    expect(touchLastActive).not.toHaveBeenCalled();
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
    expect(mockRecordByoEvent).toHaveBeenCalledWith('human-1', 'seat-registered', {}, expect.stringMatching(/^seat-registered:[0-9a-f]{64}$/));
  });

  test('stamps lastUsedAt but never lastListenedAt — a tool call is not a listener check-in', async () => {
    mockUserFindOne.mockResolvedValue(buildAgentUser(new Date('2026-08-12T00:00:00Z')));
    mockInstallationFind.mockReturnValue({
      lean: async () => [
        { podId: { toString: () => 'pod-workspace' }, status: 'active' },
      ],
    });

    await agentRuntimeAuth(buildReq('cm_agent_test'), buildRes(), jest.fn());

    expect(mockUserUpdateOne).toHaveBeenCalled();
    const written = JSON.stringify(mockUserUpdateOne.mock.calls);
    expect(written).toContain('lastUsedAt');
    expect(written).not.toContain('lastListenedAt');
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
    expect(mockRecordByoEvent).not.toHaveBeenCalled();
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

// TASK-712: every refusal branch logs one reason line and counts it, and the
// token never appears in what is logged.
describe('agentRuntimeAuth refusals are logged and counted (TASK-712)', () => {
  const TOKEN = 'cm_agent_secret-token-value-do-not-log';
  const FINGERPRINT_HASH = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  let warn;

  const refusalLines = () => warn.mock.calls
    .filter(([tag]) => tag === '[agent-auth-refused]')
    .map(([, json]) => JSON.parse(json));
  const allLoggedText = () => warn.mock.calls.map((args) => args.map(String).join(' ')).join('\n');

  beforeEach(() => {
    resetAgentAuthRefusalsForTest();
    mockSecret.hash.mockReturnValue(FINGERPRINT_HASH);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockCredentialFindOne.mockResolvedValue(null);
  });
  afterEach(() => warn.mockRestore());

  const agentUser = (overrides = {}) => ({
    _id: 'bot-user-1',
    username: 'my-byo-agent',
    isBot: true,
    botMetadata: { agentName: 'my-byo-agent', instanceId: 'default', displayName: 'My BYO Agent' },
    agentRuntimeTokens: [{ tokenHash: FINGERPRINT_HASH }],
    ...overrides,
  });

  test('a missing token is refused, logged as missing_token with no fingerprint, and counted', async () => {
    const res = buildRes();
    const req = {
      headers: {}, header: () => undefined, method: 'GET', baseUrl: '/api/agents/runtime',
    };
    await agentRuntimeAuth(req, res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing agent token' });
    expect(refusalLines()).toEqual([expect.objectContaining({
      reason: 'missing_token', route: '/api/agents/runtime', method: 'GET', fingerprint: 'none',
    })]);
    expect(agentAuthRefusalCounts().counts.missing_token).toBe(1);
  });

  test('an unknown token is refused as invalid_token, with the first 8 hex of its hash as fingerprint', async () => {
    mockUserFindOne.mockResolvedValue(null);
    mockInstallationFindOne.mockResolvedValue(null);
    const res = buildRes();
    await agentRuntimeAuth(buildReq(TOKEN), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid agent token' });
    expect(refusalLines()).toEqual([expect.objectContaining({ reason: 'invalid_token', fingerprint: 'a1b2c3d4' })]);
    expect(agentAuthRefusalCounts().counts.invalid_token).toBe(1);
  });

  test('a User-row token with no active installation is refused as agent_not_installed', async () => {
    mockUserFindOne.mockResolvedValue(agentUser());
    mockInstallationFind.mockReturnValue({ lean: async () => [] });
    const res = buildRes();
    await agentRuntimeAuth(buildReq(TOKEN), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Agent not installed' });
    expect(refusalLines()).toEqual([
      expect.objectContaining({ reason: 'agent_not_installed', fingerprint: 'a1b2c3d4' }),
    ]);
  });

  test('a User-row token past its own expiry is refused as session_expired', async () => {
    mockUserFindOne.mockResolvedValue(agentUser({
      agentRuntimeTokens: [{ tokenHash: FINGERPRINT_HASH, expiresAt: new Date('2020-01-01T00:00:00Z') }],
    }));
    const res = buildRes();
    await agentRuntimeAuth(buildReq(TOKEN), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Session token expired' });
    expect(refusalLines()).toEqual([expect.objectContaining({ reason: 'session_expired' })]);
  });

  test('a revoked credential is refused with its own reason, token_revoked', async () => {
    mockCredentialFindOne.mockResolvedValue({ _id: 'cred-1', kind: 'runtime', status: 'revoked' });
    const res = buildRes();
    await agentRuntimeAuth(buildReq(TOKEN), res, jest.fn());
    expect(res.json).toHaveBeenCalledWith({ message: 'Token revoked' });
    expect(refusalLines()).toEqual([expect.objectContaining({ reason: 'token_revoked', fingerprint: 'a1b2c3d4' })]);
  });

  test('the token text never appears in any logged output, on any token-bearing refusal branch', async () => {
    const branches = [
      ['invalid_token', 'cm_agent_invalid-branch-token', () => {
        mockUserFindOne.mockResolvedValue(null);
        mockInstallationFindOne.mockResolvedValue(null);
      }],
      ['agent_not_installed', 'cm_agent_not-installed-branch-token', () => {
        mockUserFindOne.mockResolvedValue(agentUser());
        mockInstallationFind.mockReturnValue({ lean: async () => [] });
      }],
      ['session_expired', 'cm_agent_expired-branch-token', () => {
        mockUserFindOne.mockResolvedValue(agentUser({
          agentRuntimeTokens: [{ tokenHash: FINGERPRINT_HASH, expiresAt: new Date('2020-01-01T00:00:00Z') }],
        }));
      }],
      ['token_revoked', 'cm_agent_revoked-branch-token', () => {
        mockCredentialFindOne.mockResolvedValue({ _id: 'cred-1', kind: 'runtime', status: 'revoked' });
      }],
    ];
    await branches.reduce((previous, [, token, arrange]) => previous.then(() => {
      arrange();
      return agentRuntimeAuth(buildReq(token), buildRes(), jest.fn());
    }), Promise.resolve());
    expect(refusalLines().map((line) => line.reason)).toEqual(branches.map(([reason]) => reason));
    branches.forEach(([, token]) => {
      expect(allLoggedText()).not.toContain(token);
      expect(allLoggedText()).not.toContain(token.slice('cm_agent_'.length));
    });
  });

  test('a repeated refusal from the same client is logged once and counted every time', async () => {
    mockUserFindOne.mockResolvedValue(null);
    mockInstallationFindOne.mockResolvedValue(null);
    await [1, 2, 3, 4, 5].reduce((previous) => previous.then(
      () => agentRuntimeAuth(buildReq(TOKEN), buildRes(), jest.fn()),
    ), Promise.resolve());
    expect(refusalLines()).toHaveLength(1);
    expect(agentAuthRefusalCounts().counts.invalid_token).toBe(5);
  });
});
