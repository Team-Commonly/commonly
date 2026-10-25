/**
 * Only the sole installer of an agent identity (or an admin) may mint, rotate or
 * revoke its runtime tokens.
 *
 * A runtime token authorizes its identity in every pod where that identity is
 * actively installed (agentRuntimeAuth), whoever installed it. So the token and
 * provision routes apply the daemon routes' sole-installer rule rather than pod
 * membership alone. These tests run the real rule against an in-memory
 * installation set.
 */
const request = require('supertest');
const express = require('express');

let mockCaller = 'user-a';
let mockInstalls = [];

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { _id: mockCaller, id: mockCaller };
  req.userId = mockCaller;
  next();
});

const matches = (doc, filter) => Object.entries(filter).every(([key, want]) => {
  if (want && typeof want === 'object' && '$ne' in want) return doc[key] !== want.$ne;
  return doc[key] === want;
});
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn((filter) => ({
      collation: () => ({ select: () => ({ lean: () => Promise.resolve(mockInstalls.filter((doc) => matches(doc, filter))) }) }),
    })),
    findOne: jest.fn((filter) => {
      const hit = mockInstalls.find((doc) => matches(doc, filter)) || null;
      const chain = {
        collation: () => chain,
        select: () => chain,
        lean: () => Promise.resolve(hit),
      };
      return chain;
    }),
    updateMany: jest.fn().mockResolvedValue({}),
  },
}));

jest.mock('../../../models/Pod', () => ({
  findById: jest.fn(),
  find: jest.fn(() => ({ select: () => ({ lean: () => Promise.resolve([]) }) })),
}));
jest.mock('../../../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentCredential', () => ({ updateOne: jest.fn().mockResolvedValue({}) }));

jest.mock('../../../services/agentIdentityService', () => ({
  resolveAgentType: jest.fn((name) => String(name).toLowerCase()),
  buildAgentUsername: jest.fn((type, instanceId) => `${type}-${instanceId}`),
  getAgentTypeConfig: jest.fn(() => ({ runtime: 'webhook' })),
  isCloudRuntime: jest.fn(() => false),
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1', agentRuntimeTokens: [] }),
  ensureAgentInPod: jest.fn().mockResolvedValue(undefined),
}));

const mockIsAdmin = jest.fn().mockResolvedValue(false);
jest.mock('../../../routes/registry/helpers', () => ({
  getUserId: jest.fn((req) => req.userId),
  isGlobalAdminUser: (...args) => mockIsAdmin(...args),
  resolveInstallation: jest.fn().mockResolvedValue({
    installation: { agentName: 'quire', status: 'active', config: { runtime: {} }, runtimeTokens: [] },
    instanceId: 'default',
  }),
  resolveRuntimeInstanceId: jest.fn().mockReturnValue('default'),
  serializeRuntimeTokens: jest.fn(() => []),
  normalizeConfigMap: jest.fn((c) => c),
  normalizeRuntimeAuthProfiles: jest.fn(),
  normalizeSkillEnvEntries: jest.fn(),
  buildOpenClawIntegrationChannels: jest.fn(),
  userHasPodAccess: jest.fn(),
  resolveGatewayForRequest: jest.fn(),
  resolveGatewayForInstallation: jest.fn(),
}));

const mockRevoke = jest.fn().mockResolvedValue([]);
const mockRevokeOne = jest.fn().mockResolvedValue(undefined);
const mockIssue = jest.fn().mockResolvedValue({ token: 'cm_agent_new' });
jest.mock('../../../routes/registry/tokens', () => ({
  normalizeScopes: jest.fn((s) => s || []),
  revokeRuntimeTokensForAgent: (...args) => mockRevoke(...args),
  revokeRuntimeTokenEverywhere: (...args) => mockRevokeOne(...args),
  issueRuntimeTokenForAgent: (...args) => mockIssue(...args),
  issueUserTokenForInstallation: jest.fn(),
}));

const Pod = require('../../../models/Pod');
const User = require('../../../models/User');
const AgentIdentityService = require('../../../services/agentIdentityService');
const agentTokensRouter = require('../../../routes/registry/agent-tokens');
const provisionRouter = require('../../../routes/registry/provision');

const app = express();
app.use(express.json());
app.use('/api/registry', agentTokensRouter);
app.use('/api/registry', provisionRouter);

const install = (installedBy, podId) => ({ agentName: 'quire', instanceId: 'default', status: 'active', installedBy, podId });

beforeEach(() => {
  jest.clearAllMocks();
  mockCaller = 'user-a';
  mockInstalls = [];
  mockIsAdmin.mockResolvedValue(false);
  // The caller is a member of the pod in every case: membership is not the question.
  Pod.findById.mockReturnValue({ lean: () => Promise.resolve({ _id: 'pod-a', createdBy: 'user-a', members: ['user-a'] }) });
  User.findOne.mockResolvedValue({ _id: 'bot-1', agentRuntimeTokens: [{ _id: 'tok-1', tokenHash: 'hash-1' }], save: jest.fn() });
});

const mint = (body = {}) => request(app).post('/api/registry/pods/pod-a/agents/quire/runtime-tokens').send(body);

describe('minting a runtime token needs the sole-installer rule, not pod membership', () => {
  test('a pod member who did not install the agent cannot mint or rotate its token', async () => {
    mockInstalls = [install('user-b', 'pod-a')];
    const res = await mint({ force: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('owner_installation_missing');
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockIssue).not.toHaveBeenCalled();
  });

  test('installing it yourself is not enough when another user also has it installed', async () => {
    mockInstalls = [install('user-a', 'pod-a'), install('user-b', 'pod-b')];
    const res = await mint({ force: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('another_installer');
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockIssue).not.toHaveBeenCalled();
  });

  test('the sole installer can mint, and force still rotates', async () => {
    mockInstalls = [install('user-a', 'pod-a'), install('user-a', 'pod-a2')];
    const res = await mint({ force: true });
    expect(res.status).toBe(200);
    expect(mockRevoke).toHaveBeenCalledTimes(1);
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test('an admin can mint for a shared identity (operators renew fleet seats)', async () => {
    mockIsAdmin.mockResolvedValue(true);
    mockInstalls = [install('user-b', 'pod-a'), install('user-c', 'pod-c')];
    const res = await mint();
    expect(res.status).toBe(200);
    expect(mockIssue).toHaveBeenCalledTimes(1);
  });

  test('an installation with no recorded installer blocks minting until repaired', async () => {
    mockInstalls = [install('user-a', 'pod-a'), { ...install(undefined, 'pod-x') }];
    const res = await mint();
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('unknown_installer');
  });
});

describe('revoking a runtime token needs the same rule', () => {
  test('a pod member who does not own the identity cannot revoke its tokens', async () => {
    mockInstalls = [install('user-b', 'pod-a')];
    const res = await request(app).delete('/api/registry/pods/pod-a/agents/quire/runtime-tokens/tok-1');
    expect(res.status).toBe(403);
    expect(User.findOne).not.toHaveBeenCalled();
  });

  test('the sole installer can revoke, and the revoke goes by the token hash', async () => {
    mockInstalls = [install('user-a', 'pod-a')];
    const res = await request(app).delete('/api/registry/pods/pod-a/agents/quire/runtime-tokens/tok-1');
    expect(res.status).toBe(200);
    // Every stored copy shares the hash, not the listed id (runtimeTokenRevoke.test.js).
    expect(mockRevokeOne).toHaveBeenCalledWith('hash-1');
  });
});

describe('provisioning mints a token, so it needs the same rule', () => {
  test('a pod member who does not solely own the identity cannot provision it', async () => {
    mockInstalls = [install('user-a', 'pod-a'), install('user-b', 'pod-b')];
    const res = await request(app).post('/api/registry/pods/pod-a/agents/quire/provision').send({ force: true });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('another_installer');
    expect(AgentIdentityService.getOrCreateAgentUser).not.toHaveBeenCalled();
    expect(mockRevoke).not.toHaveBeenCalled();
    expect(mockIssue).not.toHaveBeenCalled();
  });
});


describe('API user-token force rotation follows identity ownership', () => {
  test.each(['other-owner', 'shared'])('refuses %s without touching the credential', async (kind) => {
    mockInstalls = kind === 'shared'
      ? [install('user-a', 'pod-a'), install('user-b', 'pod-b')]
      : [install('user-b', 'pod-a')];
    const issue = require('../../../routes/registry/tokens').issueUserTokenForInstallation;
    const response = await request(app).post('/api/registry/pods/pod-a/agents/quire/user-token').send({ force: true });
    expect(response.status).toBe(403);
    expect(issue).not.toHaveBeenCalled();
    expect(User.findOne).not.toHaveBeenCalled();
  });
});
