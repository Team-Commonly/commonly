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
jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: jest.fn().mockResolvedValue(false),
}));

jest.mock('../../../middleware/auth', () => (_req, _res, next) => next());

jest.mock('../../../services/globalModelConfigService', () => ({
  getConfig: jest.fn(),
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
  // The real classifier, not a copy, so this file tests the rule the route runs.
  isCloudRuntime: jest.requireActual('../../../services/agentIdentityService').isCloudRuntime,
}));

jest.mock('../../../services/globalModelConfigService', () => ({
  getConfig: jest.fn(),
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
const { podHasOutsiderWritableGrant } = require('../../../services/nativeOutsiderGrantPolicy');
const GlobalModelConfigService = require('../../../services/globalModelConfigService');
const FirstContactService = require('../../../services/firstContactService');
const AgentMessageService = require('../../../services/agentMessageService');
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

  // The manifest fixture is round-tripped through the REAL model rather than
  // hand-written, and that is the point. TASK-043: these tests asserted a
  // fallback reading `manifest.runtime.runtimeType` while ManifestRuntimeSchema
  // had no such path — `strict: true` dropped the field on every production
  // write — so a hand-written object proved a path that could not survive a
  // save. Delete the schema path and the fixture loses the field too.
  const { AgentRegistry: RealAgentRegistry } = jest.requireActual('../../../models/AgentRegistry');
  const persistedManifest = (manifest) => new RealAgentRegistry({
    agentName: 'sample-agent',
    displayName: 'Sample Agent',
    description: 'x',
    manifest,
  }).toObject().manifest;

  beforeEach(() => {
    jest.clearAllMocks();
    podHasOutsiderWritableGrant.mockResolvedValue(false);

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
    GlobalModelConfigService.getConfig.mockResolvedValue({ openclaw: { devAgentIds: ['theo'] } });

    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([]),
      }),
    });
    Activity.create.mockResolvedValue(true);
  });

  it('copies manifest.runtime.runtimeType into the installation when the caller omits runtimeType', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Native first-party app',
      latestVersion: '1.0.0',
      manifest: persistedManifest({
        name: 'sample-agent',
        version: '1.0.0',
        context: { required: [] },
        runtime: {
          type: 'standalone',
          runtimeType: 'native',
        },
      }),
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

  // ADR-018 D8.1: the route stores the wake default for an agent a person
  // brings in (wakeDefaultService.test.js covers the rule itself).
  describe('an agent a person brings in wakes on every human message', () => {
    const ownAgentInstall = async (extraConfig = {}) => {
      AgentRegistry.getByName.mockResolvedValue({
        agentName: 'sample-agent',
        displayName: 'Sample Agent',
        description: 'BYO agent',
        latestVersion: '1.0.0',
        manifest: persistedManifest({ name: 'sample-agent', version: '1.0.0', context: { required: [] } }),
      });
      const req = {
        body: {
          agentName: 'sample-agent', podId: 'pod-1', version: '1.0.0', config: { runtime: { runtimeType: 'webhook' }, ...extraConfig }, scopes: [],
        },
        user: { id: 'user-1', username: 'installer' },
        userId: 'user-1',
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await installHandler(req, res);
      return AgentInstallation.install.mock.calls[0][2].config;
    };

    it('stores wakeOnMessage (human-only) and board wakes off', async () => {
      const config = await ownAgentInstall();
      expect(config.runtime).toEqual(expect.objectContaining({ runtimeType: 'webhook', host: 'byo' }));
      expect(config.wakeOnMessage).toEqual(expect.objectContaining({ enabled: true, humanOnly: true }));
      expect(config.boardWake).toEqual({ enabled: false });
    });

    it('keeps an explicit wakeOnMessage from the request', async () => {
      const config = await ownAgentInstall({ wakeOnMessage: { enabled: false } });
      expect(config.wakeOnMessage).toEqual({ enabled: false });
      expect(config).not.toHaveProperty('boardWake');
    });
  });

  it('preserves opencode as an open driver identity through the registry model and install route', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'OpenCode BYO agent',
      latestVersion: '1.0.0',
      manifest: persistedManifest({
        name: 'sample-agent',
        version: '1.0.0',
        context: { required: [] },
        runtime: {
          type: 'standalone',
          runtimeType: 'opencode',
        },
      }),
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
            runtimeType: 'opencode',
          }),
        }),
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
  });

  it('refuses a non-native install into a protected pod before any installation or membership write', async () => {
    podHasOutsiderWritableGrant.mockResolvedValue(true);
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent', displayName: 'Sample Agent', latestVersion: '1.0.0',
      manifest: persistedManifest({
        name: 'sample-agent', version: '1.0.0', context: { required: [] },
        runtime: { type: 'standalone', runtimeType: 'opencode' },
      }),
    });
    const req = {
      body: { agentName: 'sample-agent', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [] },
      user: { id: 'user-1', username: 'installer' }, userId: 'user-1',
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await installHandler(req, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'outsider_grant_non_native_agent_join',
      message: expect.stringContaining('Use a separate pod'),
    }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
    expect(AgentIdentityService.ensureAgentInPod).not.toHaveBeenCalled();
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

  it('passes a hire\'s description to the identity service, trimmed and capped (#1649)', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent', displayName: 'Sample Agent', description: 'Native first-party app', latestVersion: '1.0.0',
      manifest: persistedManifest({
        name: 'sample-agent',
        version: '1.0.0',
        context: { required: [] },
        runtime: { type: 'standalone', runtimeType: 'hosted' },
      }),
    });
    const req = {
      body: { agentName: 'sample-agent', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [], displayName: 'Scout', description: `  Your first teammate.   Answers how things work here. ${'x'.repeat(200)}` },
      user: { id: 'user-1', username: 'installer' }, userId: 'user-1',
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    await installHandler(req, res);
    const passed = AgentIdentityService.getOrCreateAgentUser.mock.calls.find(([name]) => name === 'sample-agent')[1].description;
    expect(passed.startsWith('Your first teammate. Answers how things work here. xxx')).toBe(true);
    expect(passed).toHaveLength(160);
  });

  it('grants GitHub issue writes only to configured OpenClaw dev seats', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'openclaw',
      displayName: 'OpenClaw',
      description: 'Cloud runtime',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await installHandler({
      body: {
        agentName: 'openclaw',
        podId: 'pod-1',
        version: '1.0.0',
        instanceId: 'theo',
        config: { runtime: { runtimeType: 'moltbot' } },
        scopes: [],
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    }, res);

    expect(AgentInstallation.install).toHaveBeenCalledWith(
      'openclaw',
      'pod-1',
      expect.objectContaining({ githubIssueWrite: true }),
    );
  });

  it('keeps GitHub issue writes off for every non-dev seat, ignoring caller intent', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'openclaw',
      displayName: 'OpenClaw',
      description: 'Cloud runtime',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await installHandler({
      body: {
        agentName: 'openclaw',
        podId: 'pod-1',
        version: '1.0.0',
        instanceId: 'community-seat',
        config: { runtime: { runtimeType: 'moltbot' } },
        scopes: [],
        githubIssueWrite: true,
      },
      user: { id: 'user-1', username: 'installer' },
      userId: 'user-1',
    }, res);

    expect(AgentInstallation.install).toHaveBeenCalledWith(
      'openclaw',
      'pod-1',
      expect.objectContaining({ githubIssueWrite: false }),
    );
  });

  it('keeps install successful when the first-contact trigger fails', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Community marketplace app',
      latestVersion: '1.0.0',
      manifest: {
        context: { required: [] },
        runtime: { type: 'standalone' },
      },
    });
    FirstContactService.maybeFireFirstContact.mockRejectedValueOnce(new Error('marker unavailable'));

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
    await Promise.resolve();

    expect(FirstContactService.maybeFireFirstContact).toHaveBeenCalledWith({
      agentName: 'sample-agent',
      instanceId: 'default',
      podId: 'pod-1',
      installedByUserId: 'user-1',
      installerIsAgent: false,
    });
    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('seeds a new identity from the normalized per-instance template icon', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'sample-agent',
      displayName: 'Sample Agent',
      description: 'Community marketplace app',
      iconUrl: 'https://api.commonly.me/api/uploads/registry.png',
      latestVersion: '1.0.0',
      manifest: {
        context: { required: [] },
        runtime: { type: 'standalone' },
      },
    });
    AgentTemplate.find.mockReturnValue({
      select: jest.fn().mockReturnValue({
        lean: jest.fn().mockResolvedValue([{
          displayName: 'Aria',
          iconUrl: 'https://api-dev.commonly.me/api/uploads/aria.png',
          createdBy: 'user-1',
          visibility: 'private',
        }]),
      }),
    });
    const req = {
      body: {
        agentName: 'sample-agent',
        podId: 'pod-1',
        version: '1.0.0',
        displayName: 'Aria',
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

    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalledWith(
      'sample-agent',
      expect.objectContaining({
        displayName: 'Aria',
        profilePicture: '/api/uploads/aria.png',
      }),
    );
  });

  describe('install intro in a solo pod (TASK-223)', () => {
    // The handler reads the pod twice: `.lean()` for the access check and
    // `.select(...).lean()` for the intro. The fixture must answer both.
    const SoloPod = (name) => {
      const doc = { _id: 'pod-1', name, createdBy: 'user-1', members: ['user-1'], type: 'chat' };
      Pod.findById.mockReturnValue({
        lean: jest.fn().mockResolvedValue(doc),
        select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(doc) }),
      });
    };
    const runInstall = async () => {
      AgentRegistry.getByName.mockResolvedValue({
        agentName: 'sample-agent',
        displayName: 'Sample Agent',
        description: 'Community marketplace app',
        latestVersion: '1.0.0',
        manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
      });
      const req = {
        body: { agentName: 'sample-agent', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [] },
        user: { id: 'user-1', username: 'installer' },
        userId: 'user-1',
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
      await installHandler(req, res);
      await new Promise((resolve) => setImmediate(resolve));
    };

    it('posts the intro in the installer\'s own solo My Workspace', async () => {
      SoloPod('My Workspace');
      await runInstall();

      expect(AgentMessageService.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ podId: 'pod-1' }),
      );
    });

    it('stays silent in a solo pod that is not a My Workspace', async () => {
      SoloPod('Side project');
      await runInstall();

      expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    });
  });
});
