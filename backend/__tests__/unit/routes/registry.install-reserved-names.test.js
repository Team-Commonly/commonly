// Self-serve installs (Bring your own runtime, Run it here, On my computer)
// create a new identity under a chosen name, so a built-in agent's name is
// refused for them (2026-10-14). Harness copied from
// registry.cloud-entitlement-gate.test.js.
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
  getAgentTypeConfig: jest.fn((name) => (
    ['openclaw', 'claude-code'].includes(String(name).toLowerCase()) ? { runtime: 'moltbot' } : null
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

jest.mock('../../../services/firstContactService', () => ({
  maybeFireFirstContact: jest.fn().mockResolvedValue(undefined),
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


const officialRow = (agentName) => ({
  agentName,
  displayName: agentName,
  description: 'Built-in',
  latestVersion: '1.0.0',
  registry: 'commonly-official',
  manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
});

const installAs = async ({ role = 'user', agentName, runtimeType }) => {
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
  await installHandler(req, res);
  return res;
};

const reservedCalls = (res) => res.json.mock.calls.filter(([body]) => body && body.code === 'agent_name_reserved');

let installHandler;

describe('registry install — built-in names are reserved for self-serve installs', () => {
  beforeAll(() => { installHandler = getInstallHandler(); });

  beforeEach(() => {
    jest.clearAllMocks();
    Pod.findById.mockReturnValue(buildLeanChain({ _id: 'pod-1', createdBy: 'user-1', members: ['user-1'], type: 'chat' }));
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
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  test.each([
    ['webhook', 'claude-code'],
    ['hosted', 'scout'],
    ['wrapper', 'openclaw'],
  ])('a %s install named after a built-in agent (%s) is refused, and nothing is installed', async (runtimeType, agentName) => {
    AgentRegistry.getByName.mockResolvedValue(officialRow(agentName));
    const res = await installAs({ agentName, runtimeType });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(reservedCalls(res)).toHaveLength(1);
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  test('an admin is not refused (operators place built-in agents)', async () => {
    AgentRegistry.getByName.mockResolvedValue(officialRow('claude-code'));
    const res = await installAs({ role: 'admin', agentName: 'claude-code', runtimeType: 'webhook' });
    expect(reservedCalls(res)).toHaveLength(0);
  });

  test('installing the built-in agent itself (not a self-serve seat) is not this gate', async () => {
    AgentRegistry.getByName.mockResolvedValue(officialRow('openclaw'));
    const res = await installAs({ agentName: 'openclaw' });
    expect(reservedCalls(res)).toHaveLength(0);
  });

  test('a community-published agent installed self-serve is not reserved', async () => {
    AgentRegistry.getByName.mockResolvedValue({ ...officialRow('standup-bot'), registry: 'commonly-community' });
    const res = await installAs({ agentName: 'standup-bot', runtimeType: 'webhook' });
    expect(reservedCalls(res)).toHaveLength(0);
  });
});
