/**
 * One post when a hosted agent joins (QA walk, 2026-10-16). A hosted agent on
 * the native engine answers its first contact in the same minute, in its own
 * voice; the template intro beside it was a second post before anyone had
 * spoken. It sees only its mentions, so its greeting carries the handle.
 *
 * Contract under test:
 *  - native engine + a greeting enqueued: no template intro, and the greeting
 *    is asked to name the handle
 *  - no greeting (a reinstall, or a failed trigger): the intro still posts
 *  - on the Durable Object: the intro posts, and no handle is passed
 */

const mockCountHosted = jest.fn();
const mockListHosted = jest.fn();
const mockPodHasOutsiderWritableGrant = jest.fn();

jest.mock('../../../services/nativeOutsiderGrantPolicy', () => ({
  podHasOutsiderWritableGrant: (...args) => mockPodHasOutsiderWritableGrant(...args),
}));

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

const introPosts = () => AgentMessageService.postMessage.mock.calls
  .filter(([args]) => args?.metadata?.kind === 'install-intro');

describe('registry install — a hosted agent joins with one post', () => {
  const installHandler = getInstallHandler();
  const previousEngine = process.env.HOSTED_ENGINE;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HOSTED_ENGINE = 'native';
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

  it('on the native engine with a greeting enqueued, posts no template intro and asks the greeting for the handle', async () => {
    const res = makeRes();
    await installHandler(makeReq('hosted'), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(mockFireFirstContact).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'my-agent', mentionHandle: 'my-agent', hostedAgentUserId: 'bot-1',
    }));
    expect(introPosts()).toHaveLength(0);
  });

  it.each([
    ['the greeting was already sent once (a reinstall)', () => mockFireFirstContact.mockResolvedValue(false)],
    ['the first-contact trigger failed', () => mockFireFirstContact.mockRejectedValue(new Error('marker unavailable'))],
  ])('when %s, the template intro still posts', async (_label, arrange) => {
    arrange();
    const res = makeRes();
    await installHandler(makeReq('hosted'), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(introPosts()).toHaveLength(1);
    expect(introPosts()[0][0].content).toMatch(/@my-agent/);
  });

  it('on the Durable Object, the intro posts and no handle is passed to the greeting', async () => {
    delete process.env.HOSTED_ENGINE;
    const res = makeRes();
    await installHandler(makeReq('hosted'), res);

    expect(mockFireFirstContact).toHaveBeenCalledWith(expect.not.objectContaining({ mentionHandle: expect.anything() }));
    expect(introPosts()).toHaveLength(1);
  });
});
