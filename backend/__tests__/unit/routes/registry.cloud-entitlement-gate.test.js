// Gate test: cloud (hosted) agent installs require admin OR the cloudAgents
// entitlement; BYO/webhook installs stay open. Mirrors the harness in
// registry.install-runtime-type.test.js.
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
    install: jest.fn(),
  },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
}));

jest.mock('../../../models/User', () => ({
  findOne: jest.fn(),
  findById: jest.fn(),
}));

jest.mock('../../../models/AgentProfile', () => ({
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../../models/Activity', () => ({
  create: jest.fn(),
}));

// Real-ish taxonomy so the gate exercises the actual decision logic; only the
// AGENT_TYPES lookup is stubbed (openclaw → moltbot, others unknown).
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  getAgentTypeConfig: jest.fn((name) => (
    String(name).toLowerCase() === 'openclaw' ? { runtime: 'moltbot' } : null
  )),
  isCloudRuntime: jest.fn(({ runtimeType, host } = {}) => {
    const rt = String(runtimeType || '').toLowerCase();
    const h = String(host || '').toLowerCase();
    if (h === 'byo') return false;
    if (rt === 'webhook' || rt === 'claude-code') return false;
    if (['moltbot', 'internal', 'native', 'managed-agents'].includes(rt)) return true;
    if (rt === 'codex') return true;
    return false;
  }),
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue(true),
}));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const Activity = require('../../../models/Activity');
const installRouter = require('../../../routes/registry/install');

const getInstallHandler = () => {
  const layer = installRouter.stack.find((entry) => (
    entry.route
    && entry.route.path === '/install'
    && entry.route.methods.post
  ));
  if (!layer) throw new Error('Install route handler not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const buildLeanChain = (result) => ({ lean: jest.fn().mockResolvedValue(result) });
const buildSelectLeanChain = (result) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
});

const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

describe('registry install — cloud-agent entitlement gate', () => {
  const installHandler = getInstallHandler();

  beforeEach(() => {
    jest.clearAllMocks();

    Pod.findById.mockReturnValue(buildLeanChain({
      _id: 'pod-1',
      createdBy: 'user-1',
      members: ['user-1'],
      type: 'chat',
    }));

    AgentInstallation.findOne.mockResolvedValue(null);
    AgentInstallation.find.mockReturnValue(buildLeanChain([]));
    AgentInstallation.install.mockImplementation(async (_agentName, _podId, options) => ({
      _id: { toString: () => 'install-1' },
      agentName: _agentName,
      instanceId: options.instanceId || 'default',
      displayName: options.displayName || 'Agent',
      version: options.version,
      status: 'active',
      scopes: options.scopes || [],
    }));
    AgentRegistry.incrementInstalls.mockResolvedValue({ acknowledged: true });

    // botMetadata displayName lookup → none.
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));

    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  it('403s a non-admin, non-entitled installer on a cloud (moltbot) agent', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'openclaw',
      displayName: 'Cuz',
      description: 'OpenClaw',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    // Installer: plain user, no entitlement.
    User.findById.mockReturnValue(buildSelectLeanChain({
      username: 'installer', role: 'user', entitlements: { cloudAgents: false },
    }));

    const req = {
      body: {
        agentName: 'openclaw', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [],
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    };
    const res = makeRes();
    await installHandler(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'cloud_agents_not_entitled',
    }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  it('allows an entitled (non-admin) installer on a cloud (moltbot) agent', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'openclaw',
      displayName: 'Cuz',
      description: 'OpenClaw',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    User.findById.mockReturnValue(buildSelectLeanChain({
      username: 'installer', role: 'user', entitlements: { cloudAgents: true },
    }));

    const req = {
      body: {
        agentName: 'openclaw', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [],
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    };
    const res = makeRes();
    await installHandler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(AgentInstallation.install).toHaveBeenCalled();
  });

  it('allows an admin installer on a cloud (moltbot) agent', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'openclaw',
      displayName: 'Cuz',
      description: 'OpenClaw',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    User.findById.mockReturnValue(buildSelectLeanChain({
      username: 'admin', role: 'admin',
    }));

    const req = {
      body: {
        agentName: 'openclaw', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [],
      },
      user: { id: 'user-1', username: 'admin' },
      userId: 'user-1',
    };
    const res = makeRes();
    await installHandler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(AgentInstallation.install).toHaveBeenCalled();
  });

  it('does NOT gate a BYO/webhook install for a non-admin, non-entitled user', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'my-bot',
      displayName: 'My Bot',
      description: 'BYO webhook bot',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    // No entitlement — but webhook is BYO, so the gate must not fire and
    // User.findById must not even be consulted for the gate.
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'user' }));

    const req = {
      body: {
        agentName: 'my-bot',
        podId: 'pod-1',
        version: '1.0.0',
        config: { runtime: { runtimeType: 'webhook' } },
        scopes: [],
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    };
    const res = makeRes();
    await installHandler(req, res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(AgentInstallation.install).toHaveBeenCalled();
  });
});
