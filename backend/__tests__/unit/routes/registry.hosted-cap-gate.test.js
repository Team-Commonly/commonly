// ADR-023 D3.1: a hosted (Commonly-run) install is open to every authenticated
// user and METERED, not entitlement-gated. This exercises the self-serve
// synth path (no registry row) with runtimeType 'hosted' and the per-user cap.
// Mirrors the harness in registry.cloud-entitlement-gate.test.js.
const mockCountHosted = jest.fn();

jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn(),
    create: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    findOne: jest.fn(),
    find: jest.fn(),
    install: jest.fn(),
  },
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn() }));
jest.mock('../../../models/User', () => ({ findOne: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/AgentProfile', () => ({ findOneAndUpdate: jest.fn() }));
jest.mock('../../../models/AgentTemplate', () => ({ find: jest.fn() }));
jest.mock('../../../models/Activity', () => ({ create: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  getAgentTypeConfig: jest.fn(() => null),
  isCloudRuntime: jest.fn(() => false),
}));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/firstContactService', () => ({ maybeFireFirstContact: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../../services/hostedRuntimeService', () => ({
  HOSTED_RUNTIME_TYPE: 'hosted',
  hostedCaps: () => ({ agentsPerUser: 1, turnsPerDay: 200 }),
  countHostedAgentsForUser: (...args) => mockCountHosted(...args),
}));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const Activity = require('../../../models/Activity');
const installRouter = require('../../../routes/registry/install');

const getInstallHandler = () => {
  const layer = installRouter.stack.find((entry) => (
    entry.route && entry.route.path === '/install' && entry.route.methods.post
  ));
  if (!layer) throw new Error('Install route handler not found');
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const buildLeanChain = (result) => ({ lean: jest.fn().mockResolvedValue(result) });
const buildSelectLeanChain = (result) => ({
  select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(result) }),
});
const makeRes = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

const makeReq = (runtimeType, overrides = {}) => ({
  body: {
    agentName: 'my-agent',
    podId: 'pod-1',
    displayName: 'My agent',
    config: { runtime: { runtimeType } },
    scopes: [],
  },
  user: { id: 'user-1', username: 'installer' },
  userId: 'user-1',
  ...overrides,
});

describe('registry install — hosted runtime cap gate', () => {
  const installHandler = getInstallHandler();

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue(buildLeanChain({
      _id: 'pod-1', createdBy: 'user-1', members: ['user-1'], type: 'chat',
    }));
    AgentRegistry.getByName.mockResolvedValue(null); // no manifest → self-serve synth path
    AgentRegistry.create.mockImplementation(async (doc) => ({
      ...doc, latestVersion: '1.0.0', manifest: { ...doc.manifest, context: { required: [] } },
    }));
    AgentRegistry.incrementInstalls.mockResolvedValue({ acknowledged: true });
    AgentInstallation.findOne.mockResolvedValue(null);
    AgentInstallation.find.mockReturnValue(buildLeanChain([]));
    AgentInstallation.install.mockImplementation(async (agentName, _podId, options) => ({
      _id: { toString: () => 'install-1' },
      agentName,
      instanceId: options.instanceId || 'default',
      displayName: options.displayName || 'Agent',
      version: options.version,
      status: 'active',
      scopes: options.scopes || [],
    }));
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'user' }));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  it('synthesizes an ephemeral row for runtimeType hosted (no entitlement needed) when under cap', async () => {
    mockCountHosted.mockResolvedValue(0);
    const res = makeRes();
    await installHandler(makeReq('hosted'), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(AgentRegistry.create).toHaveBeenCalledWith(expect.objectContaining({ agentName: 'my-agent', ephemeral: true }));
    expect(mockCountHosted).toHaveBeenCalledWith('user-1');
    expect(AgentInstallation.install).toHaveBeenCalledWith('my-agent', 'pod-1', expect.objectContaining({
      config: expect.objectContaining({ runtime: expect.objectContaining({ runtimeType: 'hosted' }) }),
    }));
  });

  it('403s hosted_cap_reached at the cap, before any row is written', async () => {
    mockCountHosted.mockResolvedValue(1);
    const res = makeRes();
    await installHandler(makeReq('hosted'), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'hosted_cap_reached', used: 1, cap: 1 }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  it('lets an admin past the cap', async () => {
    mockCountHosted.mockResolvedValue(5);
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'admin', role: 'admin' }));
    const res = makeRes();
    await installHandler(makeReq('hosted'), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(mockCountHosted).not.toHaveBeenCalled();
    expect(AgentInstallation.install).toHaveBeenCalled();
  });

  it('still 404s an unknown agent whose runtimeType is neither webhook nor hosted', async () => {
    const res = makeRes();
    await installHandler(makeReq('claude-code'), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(AgentRegistry.create).not.toHaveBeenCalled();
    expect(mockCountHosted).not.toHaveBeenCalled();
  });
});
