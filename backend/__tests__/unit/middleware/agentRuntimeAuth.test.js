jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
    updateOne: jest.fn(),
  },
}));

jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  updateOne: jest.fn(),
}));

jest.mock('../../../utils/secret', () => ({
  hash: jest.fn(),
}));

const { AgentInstallation } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const { hash } = require('../../../utils/secret');
const agentRuntimeAuth = require('../../../middleware/agentRuntimeAuth');

describe('agentRuntimeAuth middleware', () => {
  const createRes = () => {
    const res = {};
    res.status = jest.fn().mockReturnValue(res);
    res.json = jest.fn().mockReturnValue(res);
    return res;
  };

  const createReq = (headers = {}) => ({
    header: jest.fn((name) => headers[name]),
  });

  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    hash.mockImplementation((value) => `hashed:${value}`);
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('rejects requests without an agent token prefix', async () => {
    const req = createReq({});
    const res = createRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Missing agent token' });
    expect(next).not.toHaveBeenCalled();
    expect(hash).not.toHaveBeenCalled();
  });

  it('loads shared runtime token state from the user model', async () => {
    const agentUser = {
      _id: 'agent-user-1',
      botMetadata: {
        agentName: 'Commonly-Bot',
        instanceId: 'instance-1',
      },
    };
    const installations = [{ _id: 'install-1' }, { _id: 'install-2' }];
    User.findOne.mockResolvedValue(agentUser);
    User.updateOne.mockResolvedValue({ acknowledged: true });
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue(installations),
    });

    const req = createReq({ Authorization: 'Bearer cm_agent_live-token' });
    const res = createRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(hash).toHaveBeenCalledWith('cm_agent_live-token');
    expect(User.findOne).toHaveBeenCalledWith({
      'agentRuntimeTokens.tokenHash': 'hashed:cm_agent_live-token',
      isBot: true,
    });
    expect(User.updateOne).toHaveBeenCalledWith(
      { _id: 'agent-user-1', 'agentRuntimeTokens.tokenHash': 'hashed:cm_agent_live-token' },
      { $set: { 'agentRuntimeTokens.$.lastUsedAt': expect.any(Date) } },
    );
    expect(AgentInstallation.find).toHaveBeenCalledWith({
      agentName: 'commonly-bot',
      instanceId: 'instance-1',
      status: 'active',
    });
    expect(req.agentUser).toBe(agentUser);
    expect(req.agentInstallations).toEqual(installations);
    expect(req.agentInstallation).toBe(installations[0]);
    expect(next).toHaveBeenCalled();
  });

  it('continues when updating shared token usage fails', async () => {
    User.findOne.mockResolvedValue({
      _id: 'agent-user-1',
      botMetadata: {
        agentType: 'Commonly-Bot',
      },
    });
    User.updateOne.mockRejectedValue(new Error('write failed'));
    AgentInstallation.find.mockReturnValue({
      lean: jest.fn().mockResolvedValue([]),
    });

    const req = createReq({ 'x-commonly-agent-token': 'cm_agent_live-token' });
    const res = createRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(warnSpy).toHaveBeenCalledWith(
      'Failed to update agent token usage on User:',
      'write failed',
    );
    expect(req.agentInstallations).toEqual([]);
    expect(req.agentInstallation).toBeNull();
    expect(next).toHaveBeenCalled();
  });

  it('falls back to legacy installation tokens when no agent user matches', async () => {
    const installation = { _id: 'legacy-install-1' };
    User.findOne.mockResolvedValue(null);
    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentInstallation.updateOne.mockResolvedValue({ acknowledged: true });

    const req = createReq({ Authorization: 'Bearer cm_agent_legacy-token' });
    const res = createRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(AgentInstallation.findOne).toHaveBeenCalledWith({
      'runtimeTokens.tokenHash': 'hashed:cm_agent_legacy-token',
      status: 'active',
    });
    expect(AgentInstallation.updateOne).toHaveBeenCalledWith(
      { _id: 'legacy-install-1', 'runtimeTokens.tokenHash': 'hashed:cm_agent_legacy-token' },
      { $set: { 'runtimeTokens.$.lastUsedAt': expect.any(Date) } },
    );
    expect(req.agentInstallation).toBe(installation);
    expect(req.agentInstallations).toEqual([installation]);
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 for invalid agent tokens', async () => {
    User.findOne.mockResolvedValue(null);
    AgentInstallation.findOne.mockResolvedValue(null);

    const req = createReq({ Authorization: 'Bearer cm_agent_missing' });
    const res = createRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ message: 'Invalid agent token' });
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when lookup throws', async () => {
    User.findOne.mockRejectedValue(new Error('db down'));

    const req = createReq({ Authorization: 'Bearer cm_agent_boom' });
    const res = createRes();
    const next = jest.fn();

    await agentRuntimeAuth(req, res, next);

    expect(errorSpy).toHaveBeenCalledWith('Agent auth error:', expect.any(Error));
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ message: 'Agent auth failed' });
    expect(next).not.toHaveBeenCalled();
  });
});
