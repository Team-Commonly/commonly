// The install route writes an AgentInstallation only after ensureAgentInPod
// has put the agent in the pod. ensureAgentInPod answers null rather than
// throwing when it adds nobody (a DM that holds two others, a pod gone since it
// was read), so the route refuses on null before the row is written.
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

jest.mock('../../../models/AgentTemplate', () => ({
  find: jest.fn(),
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
  resolveAgentType: jest.fn((name) => String(name).toLowerCase()),
  getAgentTypeConfig: jest.fn((name) => (
    ['openclaw', 'claude-code'].includes(String(name).toLowerCase()) ? { runtime: 'moltbot' } : null
  )),
  // The real classifier, not a copy, so this file tests the rule the route runs.
  isCloudRuntime: jest.requireActual('../../../services/agentIdentityService').isCloudRuntime,
}));

jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../../services/firstContactService', () => ({
  maybeFireFirstContact: jest.fn().mockResolvedValue(undefined),
}));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const Activity = require('../../../models/Activity');
const installRouter = require('../../../routes/registry/install');

let installHandler;

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

const makeRes = () => ({
  statusCode: 200,
  locals: {},
  status: jest.fn(function status(code) { this.statusCode = code; return this; }),
  json: jest.fn(),
});

const officialRow = (agentName) => ({
  agentName,
  displayName: agentName,
  description: 'Built-in',
  latestVersion: '1.0.0',
  registry: 'commonly-official',
  manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
});

const installAs = async ({
  role = 'user', agentName, runtimeType, recordRefusal = false, 
}) => {
  User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role, entitlements: { cloudAgents: true } }));
  const req = {
    body: {
      agentName,
      podId: 'pod-1',
      version: '1.0.0',
      config: runtimeType ? { runtime: { runtimeType } } : {},
      scopes: [],
    },
    user: { id: 'user-1', username: 'installer' },
    userId: 'user-1',
  };
  const res = makeRes();
  if (recordRefusal) {
    const layer = installRouter.stack.find((entry) => entry.route?.path === '/install');
    layer.route.stack[0].handle(req, res, () => {});
  }
  await installHandler(req, res);
  return res;
};

const AgentIdentityService = require('../../../services/agentIdentityService');

const install = (agentName = 'standup-bot') => installAs({ agentName });

describe('registry install refuses when the agent is not added to the pod', () => {
  beforeAll(() => { installHandler = getInstallHandler(); });

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue(buildLeanChain({
      _id: 'pod-1', createdBy: 'user-1', members: ['user-1'], type: 'chat', 
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
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'standup-bot',
      displayName: 'standup-bot',
      description: 'Community',
      latestVersion: '1.0.0',
      registry: 'commonly-community',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    AgentRegistry.incrementInstalls.mockResolvedValue({ acknowledged: true });
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
    AgentIdentityService.ensureAgentInPod.mockResolvedValue({ _id: 'pod-1' });
  });

  test('the agent joins, so the installation is written', async () => {
    const res = await install();
    expect(AgentInstallation.install).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBeLessThan(300);
  });

  test('a pod that is gone by then answers 404 and writes no installation', async () => {
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(null);
    const res = await install();
    expect(res.status).toHaveBeenCalledWith(404);
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  test('a private conversation that does not take the agent answers 403 and writes no installation', async () => {
    // Past the personal-pod gate (the bot reads as a member), so only the
    // null answer stands between this install and an orphan row.
    Pod.findById.mockReturnValue(buildLeanChain({
      _id: 'pod-1', createdBy: 'user-1', members: ['user-1', 'bot-1'], type: 'agent-admin',
    }));
    User.findOne.mockImplementation(() => buildSelectLeanChain({ _id: 'bot-1' }));
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(null);
    const res = await install();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'dm_membership_refused' }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });
});
