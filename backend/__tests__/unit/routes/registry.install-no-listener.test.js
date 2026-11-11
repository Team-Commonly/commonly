/**
 * An identity that only calls Commonly over its API or MCP runs no listener.
 * Its install greeting used to tell the pod "start me with commonly agent
 * run", which starts the wrong program, and the greeting itself was another
 * builder's first unseen message. An install can now declare
 * `config.runtime.listens: false`, and the greeting says plainly that a
 * mention won't wake it.
 */

const mockCountHosted = jest.fn();
const mockListHosted = jest.fn();
const mockPodHasOutsiderWritableGrant = jest.fn();

jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: (...args) => mockPodHasOutsiderWritableGrant(...args),
}));

jest.mock('../../../services/runtimeIdentityOwnership', () => ({
  ...jest.requireActual('../../../services/runtimeIdentityOwnership'),
  identityHoldsRuntimeToken: () => Promise.resolve(false),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: {
    getByName: jest.fn(),
    create: jest.fn(),
    incrementInstalls: jest.fn(),
  },
  AgentInstallation: {
    findOne: jest.fn(),
    rowInPod: jest.fn().mockResolvedValue(null),
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
  resolveAgentType: jest.fn((agentName) => agentName),
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  getAgentTypeConfig: jest.fn(() => null),
  isCloudRuntime: jest.fn(() => false),
}));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue(true) }));
const mockFireFirstContact = jest.fn();
jest.mock('../../../services/firstContactService', () => ({ maybeFireFirstContact: (...args) => mockFireFirstContact(...args) }));
jest.mock('../../../services/hostedRuntimeService', () => ({
  HOSTED_RUNTIME_TYPE: 'hosted',
  hostedCaps: () => ({ agentsPerUser: 1, turnsPerDay: 200 }),
  countHostedAgentsForUser: (...args) => mockCountHosted(...args),
  listHostedInstallationsForUser: (...args) => mockListHosted(...args),
  findHeldHostedInstallation: jest.fn().mockResolvedValue(null),
  readRuntimeConfig: (installation) => installation?.config?.runtime || {},
  isHostedInstallation: (installation) => (
    String(installation?.config?.runtime?.runtimeType || '').trim().toLowerCase() === 'hosted'
  ),
}));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const Activity = require('../../../models/Activity');
const AgentMessageService = require('../../../services/agentMessageService');
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

const makeReq = (runtime, overrides = {}) => ({
  body: {
    agentName: 'my-agent',
    podId: 'pod-1',
    displayName: 'My agent',
    config: { runtime },
    scopes: [],
  },
  user: { id: 'user-1', username: 'installer' },
  userId: 'user-1',
  ...overrides,
});

const introPosts = () => AgentMessageService.postMessage.mock.calls
  .filter(([args]) => args?.metadata?.kind === 'install-intro');

describe('registry install — an identity with no listener', () => {
  const installHandler = getInstallHandler();
  const previousEngine = process.env.HOSTED_ENGINE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HOSTED_ENGINE;
    mockPodHasOutsiderWritableGrant.mockResolvedValue(false);
    mockListHosted.mockResolvedValue([]);
    mockCountHosted.mockResolvedValue(0);
    mockFireFirstContact.mockResolvedValue(true);
    // Two members: a room where the template intro would otherwise post.
    Pod.findById.mockImplementation(() => {
      const doc = { _id: 'pod-1', createdBy: 'user-1', members: ['user-1', 'bot-1'], type: 'chat' };
      return { ...buildLeanChain(doc), select: () => buildLeanChain(doc) };
    });
    AgentRegistry.getByName.mockResolvedValue(null);
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
      config: options.config,
    }));
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'user' }));
    AgentTemplate.find.mockReturnValue(buildSelectLeanChain([]));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  afterAll(() => {
    if (previousEngine === undefined) delete process.env.HOSTED_ENGINE;
    else process.env.HOSTED_ENGINE = previousEngine;
  });

  it('declared with no listener: the greeting says a mention will not wake it, and names no command', async () => {
    const res = makeRes();
    await installHandler(makeReq({ runtimeType: 'webhook', listens: false }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(introPosts()).toHaveLength(1);
    const { content } = introPosts()[0][0];
    expect(content).toMatch(/run no listener, so mentioning me won't wake me/);
    expect(content).not.toMatch(/commonly agent run/);
    expect(content).not.toMatch(/nothing is running me/);
    // The declaration is stored with the seat, beside the polling stamp.
    expect(AgentInstallation.install.mock.calls[0][2].config.runtime).toMatchObject({ listens: false, host: 'byo' });
  });

  it('undeclared: the start instruction is conditional, since it may only call the API', async () => {
    const res = makeRes();
    await installHandler(makeReq({ runtimeType: 'webhook' }), res);

    const { content } = introPosts()[0][0];
    expect(content).toMatch(/nothing is running me yet/);
    expect(content).toMatch(/If I'm meant to answer mentions, whoever installed me can start me with `commonly agent run my-agent`/);
  });

  it.each(['no', 0, null, 'false'])('refuses listens %p before any write', async (listens) => {
    const res = makeRes();
    await installHandler(makeReq({ runtimeType: 'webhook', listens }), res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid_runtime_listens' }));
    expect(AgentInstallation.install).not.toHaveBeenCalled();
    expect(AgentRegistry.create).not.toHaveBeenCalled();
    expect(introPosts()).toHaveLength(0);
  });
});
