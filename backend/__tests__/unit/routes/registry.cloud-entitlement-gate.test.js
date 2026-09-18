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

  // A runtimeType a PUBLISHED manifest declares is subject to the same gate as
  // one the caller sends. That is load-bearing, because publish is plain `auth`
  // — any owner can declare `runtimeType: 'native'` — and install copies the
  // manifest value BEFORE the gate reads it (Wren, TASK-043 shape read). If
  // these stop refusing, a manifest becomes an entitlement bypass.
  //
  // The fixture comes from the REAL schema, so this also guards the schema path
  // itself: drop `runtimeType` from ManifestRuntimeSchema and the manifest
  // carries nothing, the effective runtimeType falls through to AGENT_TYPES
  // (null for these names), and the 403 never arrives.
  const { AgentRegistry: RealAgentRegistry } = jest.requireActual('../../../models/AgentRegistry');
  const manifestWithRuntimeType = (runtimeType) => new RealAgentRegistry({
    agentName: 'manifest-declared',
    displayName: 'Manifest Declared',
    description: 'x',
    manifest: { name: 'manifest-declared', version: '1.0.0', runtime: { runtimeType } },
  }).toObject().manifest;

  it('403s an unentitled installer when a COMMUNITY row declares native', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'manifest-declared',
      displayName: 'Manifest Declared',
      description: 'x',
      latestVersion: '1.0.0',
      registry: 'commonly-community',
      verified: false,
      manifest: manifestWithRuntimeType('native'),
    });
    User.findById.mockReturnValue(buildSelectLeanChain({
      username: 'installer', role: 'user', entitlements: { cloudAgents: false },
    }));

    const req = {
      body: {
        agentName: 'manifest-declared', podId: 'pod-1', version: '1.0.0', config: {}, scopes: [],
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

  it('lets an explicit caller runtimeType win over the manifest, so a manifest edit cannot re-shape a live install', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'manifest-declared',
      displayName: 'Manifest Declared',
      description: 'x',
      latestVersion: '1.0.0',
      manifest: manifestWithRuntimeType('native'),
    });
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'user' }));

    const req = {
      body: {
        agentName: 'manifest-declared',
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
    expect(AgentInstallation.install.mock.calls[0][2].config.runtime.runtimeType).toBe('webhook');
  });
});

// --- First-party native exemption (Wren 69361, Sam 69359) -------------------
//
// A native app whose registry row is commonly-official + verified is the
// first-teammate path and is exempt from the cloudAgents gate. The key is the
// ROW, never manifest content: publish is plain `auth`, so an exemption earned
// by declaring `native` would hand any publisher in-process compute for free.
describe('registry install — first-party native exemption', () => {
  const installHandler = getInstallHandler();
  const { AgentRegistry: RealRegistry } = jest.requireActual('../../../models/AgentRegistry');
  const officialNativeManifest = () => new RealRegistry({
    agentName: 'first-party-native',
    displayName: 'First Party',
    description: 'x',
    manifest: { name: 'first-party-native', version: '1.0.0', runtime: { runtimeType: 'native' } },
  }).toObject().manifest;

  const unentitledInstaller = () => User.findById.mockReturnValue(buildSelectLeanChain({
    username: 'installer', role: 'user', entitlements: { cloudAgents: false },
  }));

  const installReq = (config = {}) => ({
    body: {
      agentName: 'first-party-native', podId: 'pod-1', version: '1.0.0', config, scopes: [],
    },
    user: { id: 'user-1', username: 'installer' },
    userId: 'user-1',
  });

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
    AgentRegistry.incrementInstalls.mockResolvedValue({ acknowledged: true });
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  it('installs an official + verified native app for a non-admin without the entitlement, persisting runtimeType', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'first-party-native',
      displayName: 'First Party',
      description: 'x',
      latestVersion: '1.0.0',
      registry: 'commonly-official',
      verified: true,
      manifest: officialNativeManifest(),
    });
    unentitledInstaller();

    const res = makeRes();
    await installHandler(installReq(), res);

    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(AgentInstallation.install).toHaveBeenCalled();
    // The whole point of TASK-043: the fallback now lands a runtimeType the
    // event router can actually dispatch on, instead of null.
    expect(AgentInstallation.install.mock.calls[0][2].config.runtime.runtimeType).toBe('native');
  });

  it('does NOT exempt an official row that does not itself declare native', async () => {
    // Otherwise an explicit `runtimeType: 'native'` would borrow an official
    // row's provenance and skip the gate for another tier's install.
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'first-party-native',
      displayName: 'First Party',
      description: 'x',
      latestVersion: '1.0.0',
      registry: 'commonly-official',
      verified: true,
      manifest: { name: 'first-party-native', version: '1.0.0' },
    });
    unentitledInstaller();

    const res = makeRes();
    await installHandler(installReq({ runtime: { runtimeType: 'native' } }), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'cloud_agents_not_entitled',
    }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });

  it('does NOT exempt an unverified official row', async () => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'first-party-native',
      displayName: 'First Party',
      description: 'x',
      latestVersion: '1.0.0',
      registry: 'commonly-official',
      verified: false,
      manifest: officialNativeManifest(),
    });
    unentitledInstaller();

    const res = makeRes();
    await installHandler(installReq(), res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(AgentInstallation.install).not.toHaveBeenCalled();
  });
});
