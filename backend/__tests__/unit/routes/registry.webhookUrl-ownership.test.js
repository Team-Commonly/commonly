/**
 * Setting an agent's push webhook (`config.runtime.webhookUrl`) takes the
 * sole-installer rule the runtime-token routes apply, admins exempt.
 *
 * What the webhook returns with `outcome: 'posted'` is posted as the agent
 * identity, so the URL is a credential for that identity. Both writers are
 * covered: POST /install (supplying one at install time) and
 * PATCH /pods/:podId/agents/:name (setting or changing one later). The real
 * rule (services/runtimeIdentityOwnership) runs against an in-memory
 * installation set.
 */
const request = require('supertest');
const express = require('express');

let mockCaller = 'installer-1';
let mockInstalls = [];
let mockPrimary = null;

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { id: mockCaller };
  req.userId = mockCaller;
  next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => next());

// The ownership rule queries with `installedBy` (and a collation chain); every
// other lookup in the two routes is answered by `mockPrimary`. The result is
// awaitable directly, as the routes use it, and as a chain, as the rule does.
const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => {
  if (want && typeof want === 'object' && '$ne' in want) return doc[key] !== want.$ne;
  return doc[key] === want;
});
const queryResult = (value) => {
  const chain = {
    collation: () => chain,
    select: () => chain,
    sort: () => chain,
    lean: () => Promise.resolve(value),
    then: (resolve, reject) => Promise.resolve(value).then(resolve, reject),
  };
  return chain;
};
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { getByName: jest.fn(), incrementInstalls: jest.fn() },
  AgentInstallation: {
    findOne: jest.fn((filter) => queryResult(
      'installedBy' in filter ? (mockInstalls.find((doc) => matches(doc, filter)) || null) : mockPrimary,
    )),
    find: jest.fn((filter) => (
      filter.status === 'active' ? queryResult(mockInstalls) : queryResult([mockPrimary])
    )),
    install: jest.fn(),
  },
}));
jest.mock('../../../models/Pod', () => ({ findById: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentProfile', () => ({ updateMany: jest.fn(), findOneAndUpdate: jest.fn() }));
jest.mock('../../../models/AgentTemplate', () => ({ find: jest.fn() }));
jest.mock('../../../models/Activity', () => ({ create: jest.fn() }));
jest.mock('../../../services/agentNameReservation', () => ({ reservedAgentNameRefusal: jest.fn().mockResolvedValue(null) }));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn().mockResolvedValue(true),
  getAgentTypeConfig: jest.fn(() => null),
  isCloudRuntime: jest.fn(() => false),
}));
jest.mock('../../../services/agentMessageService', () => ({ postMessage: jest.fn().mockResolvedValue(true) }));
jest.mock('../../../services/firstContactService', () => ({ maybeFireFirstContact: jest.fn().mockResolvedValue(undefined) }));

const { AgentRegistry, AgentInstallation } = require('../../../models/AgentRegistry');
const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentProfile = require('../../../models/AgentProfile');
const AgentTemplate = require('../../../models/AgentTemplate');
const registryRoutes = require('../../../routes/registry');

const app = express();
app.use(express.json());
app.use('/api/registry', registryRoutes);

const INSTALLER = 'installer-1';
const OTHER = 'other-installer';
const MEMBER = 'member-1';
const ADMIN = 'admin-1';
const STORED_URL = 'https://hooks.example.test/stored';
const NEW_URL = 'https://hooks.example.test/new';

const activeInstall = (installedBy, podId) => ({
  agentName: 'relay', instanceId: 'default', status: 'active', installedBy, podId,
});

// `User.findById(...).select(...).lean()` serves both admin lookups.
const setCallerRole = (role) => {
  User.findById.mockReturnValue({ select: () => ({ lean: () => Promise.resolve({ _id: mockCaller, role }) }) });
};

const setPod = () => {
  Pod.findById.mockReturnValue({
    lean: () => Promise.resolve({
      _id: 'pod-1',
      createdBy: 'pod-owner',
      members: [{ userId: INSTALLER }, { userId: MEMBER }, { userId: ADMIN }],
    }),
  });
};

beforeEach(() => {
  jest.clearAllMocks();
  mockCaller = INSTALLER;
  mockInstalls = [];
  mockPrimary = null;
  setCallerRole('user');
  setPod();
  Pod.find.mockReturnValue(queryResult([]));
});

describe('PATCH /pods/:podId/agents/:name — setting the webhook URL', () => {
  const row = () => ({
    agentName: 'relay',
    podId: 'pod-1',
    instanceId: 'default',
    status: 'active',
    installedBy: INSTALLER,
    config: new Map(Object.entries({ runtime: { runtimeType: 'webhook', webhookUrl: STORED_URL } })),
    save: jest.fn().mockResolvedValue(true),
  });
  const patch = (config) => request(app)
    .patch('/api/registry/pods/pod-1/agents/relay')
    .send({ instanceId: 'default', config });
  const storedUrlOf = (installation) => installation.config.get('runtime').webhookUrl;

  test('the sole installer can change it', async () => {
    mockPrimary = row();
    mockInstalls = [activeInstall(INSTALLER, 'pod-1')];

    const res = await patch({ runtime: { runtimeType: 'webhook', webhookUrl: NEW_URL } });

    expect(res.status).toBe(200);
    expect(mockPrimary.save).toHaveBeenCalledTimes(1);
    expect(storedUrlOf(mockPrimary)).toBe(NEW_URL);
  });

  test('this row\'s installer is refused when another user also has the agent installed, and nothing is written', async () => {
    mockPrimary = row();
    mockInstalls = [activeInstall(INSTALLER, 'pod-1'), activeInstall(OTHER, 'pod-9')];

    const res = await patch({ runtime: { runtimeType: 'webhook', webhookUrl: NEW_URL } });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('another_installer');
    expect(mockPrimary.save).not.toHaveBeenCalled();
    expect(storedUrlOf(mockPrimary)).toBe(STORED_URL);
    expect(AgentProfile.updateMany).not.toHaveBeenCalled();
  });

  test('a pod member who did not install the agent is refused, and nothing is written', async () => {
    mockCaller = MEMBER;
    mockPrimary = row();
    mockInstalls = [activeInstall(INSTALLER, 'pod-1')];

    const res = await patch({ runtime: { runtimeType: 'webhook', webhookUrl: NEW_URL } });

    // Refused by the installer gate (#1746) that runs ahead of this rule.
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('installer_only');
    expect(mockPrimary.save).not.toHaveBeenCalled();
    expect(storedUrlOf(mockPrimary)).toBe(STORED_URL);
  });

  test('an admin can change it on a shared agent', async () => {
    mockCaller = ADMIN;
    setCallerRole('admin');
    mockPrimary = row();
    mockInstalls = [activeInstall(INSTALLER, 'pod-1'), activeInstall(OTHER, 'pod-9')];

    const res = await patch({ runtime: { runtimeType: 'webhook', webhookUrl: NEW_URL } });

    expect(res.status).toBe(200);
    expect(storedUrlOf(mockPrimary)).toBe(NEW_URL);
  });

  test('resending the stored URL is not a change, so a shared agent\'s installer can still patch its config', async () => {
    mockPrimary = row();
    mockInstalls = [activeInstall(INSTALLER, 'pod-1'), activeInstall(OTHER, 'pod-9')];

    const res = await patch({ runtime: { runtimeType: 'webhook', webhookUrl: STORED_URL }, note: 'renamed' });

    expect(res.status).toBe(200);
    expect(mockPrimary.save).toHaveBeenCalledTimes(1);
    expect(mockPrimary.config.get('note')).toBe('renamed');
  });
});

describe('POST /install — supplying a webhook URL', () => {
  const install = (config) => request(app).post('/api/registry/install').send({
    agentName: 'relay',
    podId: 'pod-1',
    instanceId: 'default',
    version: '1.0.0',
    scopes: [],
    config,
  });
  const webhookConfig = { runtime: { runtimeType: 'webhook', webhookUrl: NEW_URL } };

  beforeEach(() => {
    AgentRegistry.getByName.mockResolvedValue({
      agentName: 'relay',
      displayName: 'Relay',
      latestVersion: '1.0.0',
      manifest: { context: { required: [] }, runtime: { type: 'standalone' } },
    });
    AgentRegistry.incrementInstalls.mockResolvedValue({ acknowledged: true });
    AgentInstallation.find.mockImplementation(() => {
      let ownershipRead = false;
      const chain = {
        collation: () => { ownershipRead = true; return chain; },
        select: () => chain,
        lean: () => Promise.resolve(ownershipRead ? mockInstalls : []),
      };
      return chain;
    });
    AgentInstallation.install.mockImplementation(async (agentName, podId, options) => ({
      _id: { toString: () => 'install-1' },
      agentName,
      instanceId: options.instanceId,
      status: 'active',
      scopes: [],
      config: options.config,
    }));
    User.findOne.mockReturnValue({ select: () => ({ lean: () => Promise.resolve(null) }) });
    AgentProfile.findOneAndUpdate.mockResolvedValue(true);
    AgentTemplate.find.mockReturnValue({ select: () => ({ lean: () => Promise.resolve([]) }) });
  });

  test('a first installer can supply one, and it is stored', async () => {
    mockInstalls = [];

    const res = await install(webhookConfig);

    expect(res.status).toBe(200);
    expect(AgentInstallation.install).toHaveBeenCalledTimes(1);
    expect(AgentInstallation.install.mock.calls[0][2].config.runtime.webhookUrl).toBe(NEW_URL);
  });

  test('a caller who already solely installs the agent elsewhere can supply one', async () => {
    mockInstalls = [activeInstall(INSTALLER, 'pod-7')];

    const res = await install(webhookConfig);

    expect(res.status).toBe(200);
    expect(AgentInstallation.install).toHaveBeenCalledTimes(1);
  });

  test('a member is refused while another user has the agent installed, and nothing is written', async () => {
    mockCaller = MEMBER;
    mockInstalls = [activeInstall(OTHER, 'pod-9')];

    const res = await install(webhookConfig);

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('another_installer');
    expect(AgentInstallation.install).not.toHaveBeenCalled();
    expect(AgentProfile.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('the same member can install the same agent without a webhook URL', async () => {
    // The rule binds the webhook, not the install: the refusal above is about
    // the URL, and this is the control that shows the fixture reaches install.
    mockCaller = MEMBER;
    mockInstalls = [activeInstall(OTHER, 'pod-9')];

    const res = await install({ runtime: { runtimeType: 'webhook' } });

    expect(res.status).toBe(200);
    expect(AgentInstallation.install).toHaveBeenCalledTimes(1);
  });

  test('an admin can supply one while another user has the agent installed', async () => {
    mockCaller = ADMIN;
    setCallerRole('admin');
    mockInstalls = [activeInstall(OTHER, 'pod-9')];

    const res = await install(webhookConfig);

    expect(res.status).toBe(200);
    expect(AgentInstallation.install).toHaveBeenCalledTimes(1);
  });
});
