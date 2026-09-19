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

jest.mock('../../../services/firstContactService', () => ({
  maybeFireFirstContact: jest.fn().mockResolvedValue(undefined),
}));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const Activity = require('../../../models/Activity');
const AgentIdentityService = require('../../../services/agentIdentityService');
const FirstContactService = require('../../../services/firstContactService');
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


// TASK-071, second writer. Vera's review of #1778: the PATCH is NOT the only
// backend writer of `config.environment` — this route takes `config` from the
// body, passes it through `normalizeConfigMap` (a passthrough for a plain
// object) and stores it unchecked. So the same agreement rule has to be applied
// here, and these tests hold that.

describe('registry install environment mcp shape (TASK-071)', () => {
  const installHandler = getInstallHandler();

  const manifest = {
    context: { required: [] },
    runtime: { type: 'standalone', runtimeType: 'native' },
  };

  const installRequest = (environment) => ({
    body: {
      agentName: 'sample-agent',
      podId: 'pod-1',
      version: '1.0.0',
      config: environment === undefined ? {} : { environment },
      scopes: [],
    },
    user: { id: 'user-1', username: 'installer' },
    userId: 'user-1',
  });

  const buildRes = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });

  beforeEach(() => {
    jest.clearAllMocks();

    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Native first-party app',
      latestVersion: '1.0.0',
      manifest,
    });

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
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'admin' }));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
    Activity.create.mockResolvedValue(true);
  });

  it('refuses an install whose mcp entry contradicts its transport', async () => {
    // The same body the PATCH test uses, against the other writer: a hand-built
    // entry carrying both a url and a command. Before this, it stored fine and
    // every adapter resolved it its own way.
    const res = buildRes();
    await installHandler(installRequest({
      mcp: [{
        name: 'commonly', transport: 'http', url: 'https://api.commonly.me/mcp', command: ['node', 'x.js'],
      }],
    }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'invalid_environment_spec',
      fields: expect.arrayContaining([
        expect.objectContaining({ field: 'environment.mcp[0].command' }),
      ]),
    }));
  });

  it('refuses BEFORE the install side effect, not after it', async () => {
    // A 400 that arrives after `AgentInstallation.install` would be a report,
    // not a refusal: the malformed spec would already be stored.
    const res = buildRes();
    await installHandler(installRequest({
      mcp: [{ name: 'commonly', transport: 'stdio', url: 'https://api.commonly.me/mcp' }],
    }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  it('installs a conforming environment and an absent environment alike', async () => {
    // The control: this check refuses a shape, not the feature. An install with
    // no environment at all is the common case and must not be touched.
    const conforming = buildRes();
    await installHandler(installRequest({
      mcp: [
        { name: 'commonly', transport: 'stdio', command: ['node', 'index.js'] },
        { name: 'web', transport: 'http', url: 'https://example.test/mcp' },
      ],
    }), conforming);
    expect(conforming.status).not.toHaveBeenCalledWith(400);
    expect(AgentInstallation.install).toHaveBeenCalled();

    jest.clearAllMocks();
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Native first-party app',
      latestVersion: '1.0.0',
      manifest,
    });
    AgentInstallation.install.mockResolvedValue({ _id: { toString: () => 'install-1' } });
    const absent = buildRes();
    await installHandler(installRequest(undefined), absent);
    expect(absent.status).not.toHaveBeenCalledWith(400);
  });
});
