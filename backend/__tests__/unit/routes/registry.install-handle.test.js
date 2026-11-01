/**
 * The install intro names the handle that routes to the new install in its
 * pod, read through the install route itself. Fixture: display name, instance
 * id and username all differ, so an intro built from the wrong one fails here.
 * Mention routing is the real agentMentionService over the pod's rows.
 */

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
jest.mock('../../../models/AgentProfile', () => ({ findOneAndUpdate: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/AgentTemplate', () => ({ find: jest.fn() }));
jest.mock('../../../models/Activity', () => ({ create: jest.fn() }));
jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: jest.fn((agentName) => agentName),
  // The real username rule, so the handle the route and routing derive is the
  // one production derives.
  buildAgentUsername: jest.requireActual('../../../services/agentIdentityService').buildAgentUsername,
  resolveAgentDisplayLabel: jest.requireActual('../../../services/agentIdentityService').resolveAgentDisplayLabel,
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  getAgentTypeConfig: jest.fn(() => null),
  isCloudRuntime: jest.fn(() => false),
}));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/firstContactService', () => ({ maybeFireFirstContact: jest.fn().mockResolvedValue(false) }));

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

const AGENT = 'acme-bot';
const makeReq = (instanceId, displayName) => ({
  body: {
    agentName: AGENT, podId: 'pod-1', instanceId, displayName, config: { runtime: { runtimeType: 'webhook' } }, scopes: [],
  },
  user: { id: 'user-1', username: 'installer' },
  userId: 'user-1',
});

const introText = () => {
  const posts = AgentMessageService.postMessage.mock.calls
    .filter(([args]) => args?.metadata?.kind === 'install-intro');
  expect(posts).toHaveLength(1);
  return posts[0][0].content;
};

describe('registry install: the intro names the handle that routes in this pod', () => {
  const installHandler = getInstallHandler();
  // The pod's active installs after this install lands, as mention routing reads them.
  let podInstalls;

  beforeEach(() => {
    jest.clearAllMocks();
    podInstalls = [];
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
    AgentInstallation.find.mockImplementation((filter = {}) => buildLeanChain(
      (filter.podId?.$eq ?? filter.podId) === 'pod-1' && filter.status === 'active' ? podInstalls : [],
    ));
    AgentInstallation.install.mockImplementation(async (agentName, podId, options) => {
      const installation = {
        _id: { toString: () => 'install-1' },
        agentName,
        podId,
        instanceId: options.instanceId || 'default',
        displayName: options.displayName || 'Agent',
        version: options.version,
        status: 'active',
        scopes: options.scopes || [],
        config: options.config,
      };
      podInstalls.push(installation);
      return installation;
    });
    AgentProfile.find.mockReturnValue(buildLeanChain([]));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    User.findOne.mockImplementation(() => buildSelectLeanChain(null));
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'user' }));
    AgentTemplate.find.mockReturnValue(buildSelectLeanChain([]));
    Activity.create.mockResolvedValue(true);
  });

  it('names the username, not the display name or the bare instance id', async () => {
    const res = makeRes();
    await installHandler(makeReq('swe-dogfood', 'Rivet'), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const intro = introText();
    expect(intro).toContain('@acme-bot-swe-dogfood');
    expect(intro).not.toMatch(/@rivet\b/i);
    expect(intro).not.toMatch(/@swe-dogfood\b/);
  });

  // The default install's username is the bare agent name, which routes only
  // while it is the pod's one install of that agent.
  it('names a default install beside a sibling by its agent-instance key, since its bare name routes nowhere', async () => {
    podInstalls.push({
      agentName: AGENT, podId: 'pod-1', instanceId: 'swe-dogfood', displayName: 'Rivet', status: 'active',
    });
    const res = makeRes();
    await installHandler(makeReq('default', 'Default bot'), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const intro = introText();
    expect(intro).toContain('@acme-bot-default');
    expect(intro).not.toMatch(/@acme-bot(?![-\w])/);
  });
});
