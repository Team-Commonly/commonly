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

const mockSecret = { hash: jest.fn(), randomSecret: jest.fn() };
jest.mock('../../../utils/secret', () => mockSecret);

const mockUserFindOne = jest.fn();
const mockInstallationFindOne = jest.fn();
const mockInstallationFind = jest.fn();
const mockInstallationUpdateOne = jest.fn();

jest.mock('../../../models/User', () => {
  function User() {}
  User.findOne = (...args) => mockUserFindOne(...args);
  return User;
});
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
  mockSecret.hash.mockReset();
  mockSecret.hash.mockReturnValue('hashed-token');
  mockUserFindOne.mockReset();
  mockInstallationFindOne.mockReset();
  mockInstallationFind.mockReset();
  mockInstallationUpdateOne.mockReset();
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
});
