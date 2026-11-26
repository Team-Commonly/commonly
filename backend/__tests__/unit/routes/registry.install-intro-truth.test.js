/**
 * F651: the install intro tells the truth about whether the agent is running,
 * and stays out of the way.
 *
 * Observed on prod 11-26: Codex installed into a new pod auto-posted, as
 * Codex, "As I post this, nothing is running me yet..." plus a copy-paste
 * `agent run` command, before Codex had run at all. In a second pod a short
 * intro sat above the shell's "is connected now" line. The installer already
 * gets the start command on their own surfaces (the pod roster's fixCommand,
 * which only the installer receives), so the room gets either one hello from
 * an agent that is really there, or nothing.
 */

const mockCountHosted = jest.fn();
const mockListHosted = jest.fn();
const mockPodHasOutsiderWritableGrant = jest.fn();

// F584: a real pod id now reaches the route's outsider-grant checks, which
// returned "clear" early for this suite's old non-id fixture. They stay clear
// here; their own suites cover them.
jest.mock('../../../services/outsiderGrantNarrowingPreview', () => ({
  ...jest.requireActual('../../../services/outsiderGrantNarrowingPreview'),
  previewInstallNarrowing: jest.fn().mockResolvedValue({ status: 'clear' }),
}));
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
    podId: 'a0000000000000000000000a',
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

const { deriveAgentState } = require('../../../services/agentStateService');

// The bot row the intro derives liveness from; every other User lookup is empty.
const botRowWith = (tokens) => (query) => {
  const isBotLookup = query && query['botMetadata.agentName'];
  return buildSelectLeanChain(isBotLookup ? { agentRuntimeTokens: tokens } : null);
};

const SETUP_TEXT = /nothing is running me|agent run|As I post this|never updates|may not reach me/;

describe('registry install — the intro tells the truth (F651)', () => {
  const installHandler = getInstallHandler();
  const previousEngine = process.env.HOSTED_ENGINE;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.HOSTED_ENGINE;
    mockPodHasOutsiderWritableGrant.mockResolvedValue(false);
    mockListHosted.mockResolvedValue([]);
    mockCountHosted.mockResolvedValue(0);
    mockFireFirstContact.mockResolvedValue(true);
    Pod.findById.mockImplementation(() => {
      const doc = { _id: 'a0000000000000000000000a', createdBy: 'user-1', members: ['user-1', 'user-2'], type: 'chat' };
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
      installedBy: 'user-1',
      version: options.version,
      status: 'active',
      scopes: options.scopes || [],
      config: options.config,
    }));
    User.findOne.mockImplementation(botRowWith([]));
    User.findById.mockReturnValue(buildSelectLeanChain({ username: 'installer', role: 'user' }));
    AgentTemplate.find.mockReturnValue(buildSelectLeanChain([]));
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    Activity.create.mockResolvedValue(true);
  });

  afterAll(() => {
    if (previousEngine === undefined) delete process.env.HOSTED_ENGINE;
    else process.env.HOSTED_ENGINE = previousEngine;
  });

  it('connected at install: one hello, no setup text, marked so the shell adds no "connected now" line', async () => {
    User.findOne.mockImplementation(botRowWith([{ lastListenedAt: new Date() }]));
    const res = makeRes();
    await installHandler(makeReq({ runtimeType: 'webhook' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(introPosts()).toHaveLength(1);
    const [{ content, payload, authorKind }] = introPosts()[0];
    expect(content).toMatch(/Mention me with @my-agent when you need me\./);
    expect(content).not.toMatch(SETUP_TEXT);
    expect(authorKind).toBe('kernel');
    // The shell's F509 "is connected now" line skips a note in listening form.
    expect(payload).toEqual({ kind: 'install-intro', introState: 'listening' });
  });

  it('not connected: nothing is posted as the agent, and the installer still gets the command', async () => {
    const res = makeRes();
    await installHandler(makeReq({ runtimeType: 'webhook' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(introPosts()).toHaveLength(0);
    AgentMessageService.postMessage.mock.calls.forEach(([args]) => {
      expect(String(args?.content || '')).not.toMatch(SETUP_TEXT);
    });
    // The installer's surfaces (pod roster, agent inspector, composer warning,
    // Your Team) read fixCommand from this derivation, for the installer only.
    const installation = await AgentInstallation.install.mock.results[0].value;
    const owner = deriveAgentState(installation, [], 'user-1');
    expect(owner.state).toBe('never-connected');
    expect(owner.fixCommand).toMatch(/agent run my-agent/);
    expect(deriveAgentState(installation, [], 'user-2').fixCommand).toBeUndefined();
  });

  it('gone dark at install: no hedged "may not reach me" note either', async () => {
    User.findOne.mockImplementation(botRowWith([{ lastListenedAt: new Date(Date.now() - 7 * 24 * 3600 * 1000) }]));
    const res = makeRes();
    await installHandler(makeReq({ runtimeType: 'webhook' }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(introPosts()).toHaveLength(0);
  });

  it('no double post: an install posts at most one intro and never a setup line, whatever the state', async () => {
    const states = [[], [{ lastListenedAt: new Date() }]];
    for (const tokens of states) {
      jest.clearAllMocks();
      User.findOne.mockImplementation(botRowWith(tokens));
      // eslint-disable-next-line no-await-in-loop
      await installHandler(makeReq({ runtimeType: 'webhook' }), makeRes());
      expect(introPosts().length).toBeLessThanOrEqual(1);
      const contents = AgentMessageService.postMessage.mock.calls.map(([args]) => String(args?.content || ''));
      expect(contents.filter((c) => SETUP_TEXT.test(c))).toHaveLength(0);
    }
  });
});
