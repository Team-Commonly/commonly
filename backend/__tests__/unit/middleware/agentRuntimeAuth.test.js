// agentRuntimeAuth path 2 (legacy installation-token) needs to surface ALL
// active AgentInstallation rows for the same (agentName, instanceId), not
// just the one whose runtimeTokens.tokenHash matches. Otherwise the /events
// endpoint silently filters out events for pods the token wasn't originally
// minted for — exact bug we hit when Cody's token from her old install
// couldn't see events from a new pod she'd been freshly installed into.

const cryptoMock = { hash: jest.fn(), randomSecret: jest.fn() };
jest.mock('../../../utils/crypto', () => cryptoMock);

const userFindOneMock = jest.fn();
const installationFindOneMock = jest.fn();
const installationFindMock = jest.fn();
const installationUpdateOneMock = jest.fn();

jest.mock('../../../models/User', () => {
  function User() {}
  User.findOne = (...args) => userFindOneMock(...args);
  return User;
});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    findOne: (...args) => installationFindOneMock(...args),
    find: (...args) => installationFindMock(...args),
    updateOne: (...args) => installationUpdateOneMock(...args),
  },
}));
jest.mock('../../../models/Pod', () => ({
  find: () => ({ select: () => ({ lean: async () => [] }) }),
}));

const agentRuntimeAuth = require('../../../middleware/agentRuntimeAuth').default;

const mockReq = (token) => ({
  headers: { authorization: `Bearer ${token}` },
});
const mockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

beforeEach(() => {
  cryptoMock.hash.mockReset();
  cryptoMock.hash.mockReturnValue('hashed-token');
  userFindOneMock.mockReset();
  installationFindOneMock.mockReset();
  installationFindMock.mockReset();
  installationUpdateOneMock.mockReset();
});

describe('agentRuntimeAuth path 2 (install-bound token) — #66 fix', () => {
  test('surfaces ALL active installations for the same (agentName, instanceId), not just the matched one', async () => {
    // No User-row token match → path 2 fires
    userFindOneMock.mockResolvedValue(null);
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
    installationFindOneMock.mockResolvedValue(matchedInstall);
    installationFindMock.mockResolvedValue([matchedInstall, otherInstall]);
    installationUpdateOneMock.mockResolvedValue({});

    const req = mockReq('cm_agent_test');
    const res = mockRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(installationFindMock).toHaveBeenCalledWith({
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
    userFindOneMock.mockResolvedValue(null);
    installationFindOneMock.mockResolvedValue(null);

    const req = mockReq('cm_agent_bogus');
    const res = mockRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
