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

jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  // Unknown agentName in these tests → no AGENT_TYPES runtime fallback.
  getAgentTypeConfig: jest.fn(() => null),
  // Faithful mirror of the real taxonomy so the entitlement gate behaves.
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
const AgentIdentityService = require('../../../services/agentIdentityService');
const installRouter = require('../../../routes/registry/install');

const getInstallHandler = () => {
  const layer = installRouter.stack.find((entry) => (
    entry.route
    && entry.route.path === '/install'
    && entry.route.methods.post
  ));
  if (!layer) {
    throw new Error('Install route handler not found');
  }
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const buildLeanChain = (result) => ({
  lean: jest.fn().mockResolvedValue(result),
});

const buildSelectLeanChain = (result) => ({
  select: jest.fn().mockReturnValue({
    lean: jest.fn().mockResolvedValue(result),
  }),
});

describe('registry install runtimeType fallback', () => {
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
      agentName: 'sample-agent',
      instanceId: options.instanceId || 'default',
      displayName: options.displayName || 'Sample Agent',
      version: options.version,
      status: 'active',
      scopes: options.scopes || [],
    }));

    AgentRegistry.incrementInstalls.mockResolvedValue({ acknowledged: true });

    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    // Installer is an admin so the cloud-agent entitlement gate passes — these
    // tests install a 'native' runtime (a cloud runtime) and assert the
    // runtimeType fallback, not the gate.
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'admin' }));

    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  it('copies manifest.runtime.runtimeType into the installation when the caller omits runtimeType', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Native first-party app',
      latestVersion: '1.0.0',
      manifest: {
        context: { required: [] },
        runtime: {
          type: 'standalone',
          runtimeType: 'native',
        },
      },
    });

    const req = {
      body: {
        agentName: 'sample-agent',
        podId: 'pod-1',
        version: '1.0.0',
        config: {},
        scopes: [],
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await installHandler(req, res);

    expect(AgentInstallation.install).toHaveBeenCalledWith(
      'sample-agent',
      'pod-1',
      expect.objectContaining({
        config: expect.objectContaining({
          runtime: expect.objectContaining({
            runtimeType: 'native',
          }),
        }),
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('does not copy manifest.runtime.type deployment metadata into runtimeType', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Community marketplace app',
      latestVersion: '1.0.0',
      manifest: {
        context: { required: [] },
        runtime: {
          type: 'standalone',
        },
      },
    });

    const req = {
      body: {
        agentName: 'sample-agent',
        podId: 'pod-1',
        version: '1.0.0',
        config: {},
        scopes: [],
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await installHandler(req, res);

    expect(AgentInstallation.install).toHaveBeenCalledWith(
      'sample-agent',
      'pod-1',
      expect.objectContaining({
        config: {},
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
  });
});
