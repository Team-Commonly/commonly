// A refused identity must not leave an installation row behind (TASK-133 b,
// wren 73987/73988).
//
// The install route probed the identity LAST and swallowed any failure with a
// console.warn, so a refusal answered 2xx with an `AgentInstallation` row (and an
// `AgentProfile`) already written and no agent User row behind them. The probe
// now runs before those writes, and a refusal is the one error in the block that
// is not best-effort.

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

// The identity service is mocked at the boundary the route calls. The error
// class comes from the same factory so `instanceof` inside the route sees the
// class this test throws — the shape and the typed fields mirror
// `services/agentIdentityService.ts`.
jest.mock('../../../services/agentIdentityService', () => {
  class AgentUsernameConflictError extends Error {
    constructor(username, existingUserId) {
      super(`refusing to adopt the existing non-agent account "${username}" (${existingUserId}) as an agent identity`);
      this.name = 'AgentUsernameConflictError';
      this.code = 'agent_username_conflict';
      this.status = 409;
      this.username = username;
      this.existingUserId = existingUserId;
    }
  }
  return {
    AgentUsernameConflictError,
    AGENT_USERNAME_CONFLICT_CODE: 'agent_username_conflict',
    buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
      instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
    )),
    getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
    ensureAgentInPod: jest.fn().mockResolvedValue(true),
    getAgentTypeConfig: jest.fn(() => null),
    isCloudRuntime: jest.fn(() => true),
  };
});

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

describe('registry install identity refusal', () => {
  const installHandler = getInstallHandler();

  const buildRequest = () => ({
    body: {
      agentName: 'sample-agent',
      podId: 'pod-1',
      version: '1.0.0',
      config: {},
      scopes: [],
    },
    user: { id: 'user-1', username: 'installer' },
    userId: 'user-1',
  });

  const buildResponse = () => ({
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  });

  const seedAgent = () => AgentRegistry.getByName.mockResolvedValue({
    agentName: 'sample-agent',
    displayName: 'Sample Agent',
    description: 'Native first-party app',
    latestVersion: '1.0.0',
    manifest: {
      name: 'sample-agent',
      version: '1.0.0',
      context: { required: [] },
      runtime: { type: 'standalone', runtimeType: 'native' },
    },
  });

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
    // Admin, so the cloud-agent entitlement gate passes and the request reaches
    // the identity probe under test.
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'admin' }));

    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
    Activity.create.mockResolvedValue(true);

    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: 'bot-1' });
    AgentIdentityService.ensureAgentInPod.mockResolvedValue(true);
  });

  it('installs when the identity is free (control for the refusal below)', async () => {
    seedAgent();
    const res = buildResponse();

    await installHandler(buildRequest(), res);

    // The fixture really does reach the identity step, so the refusal test
    // cannot pass because some earlier gate rejected the request.
    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalledWith(
      'sample-agent',
      expect.objectContaining({ instanceId: 'default' }),
    );
    expect(AgentInstallation.install).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalledWith(409);
  });

  it('answers 409 and writes nothing when the identity is refused (TASK-133 b)', async () => {
    seedAgent();
    AgentIdentityService.getOrCreateAgentUser.mockRejectedValue(
      new AgentIdentityService.AgentUsernameConflictError('sample-agent', 'person-id'),
    );
    const res = buildResponse();

    await installHandler(buildRequest(), res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'agent_username_conflict',
      username: 'sample-agent',
    }));
    // The reason the probe moved above the writes: nothing is left behind.
    expect(AgentInstallation.install).not.toHaveBeenCalled();
    expect(AgentProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });
});
