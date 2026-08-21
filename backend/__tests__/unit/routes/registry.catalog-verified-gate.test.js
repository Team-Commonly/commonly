/**
 * ADR-022 Phase 0 — the hire catalog's verified gate.
 *
 * 31 of 45 active registry rows are smoke seats, fleet internals, and
 * personal wrappers; the verified flag is the curation boundary already
 * present in the data. Non-admins get verified-only REGARDLESS of query
 * params — passing ?verified=false must not reopen the leak. Admins keep the
 * full view for registry ops. Role loads from the DB because JWT sessions
 * carry req.user = { id } only (the #1065 lesson).
 */

jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => {
  req.userId = 'caller-1';
  req.user = { id: 'caller-1' };
  next();
}));
jest.mock('../../../models/Pod', () => ({}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentRegistry: { search: jest.fn() },
  AgentInstallation: { find: jest.fn(), getInstalledAgents: jest.fn() },
}));
jest.mock('../../../models/User', () => ({
  findById: jest.fn(),
  findOne: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  getAgentTypeConfig: jest.fn(),
  buildAgentUsername: jest.fn(() => 'bot-x'),
  default: { getAgentTypeConfig: jest.fn() },
}));
jest.mock('../../../services/agentProvisionerService', () => ({
  listOpenClawBundledSkills: jest.fn().mockResolvedValue([]),
}));
jest.mock('../../../routes/registry/helpers', () => ({
  parseVerifiedFilter: jest.fn((v) => {
    if (v === 'true' || v === true) return true;
    if (v === 'false' || v === false) return false;
    return null;
  }),
  resolveGatewayForRequest: jest.fn(),
  userHasPodAccess: jest.fn(),
}));

const { AgentRegistry } = require('../../../models/AgentRegistry');
const User = require('../../../models/User');
const AgentIdentityService = require('../../../services/agentIdentityService');
const catalogRouter = require('../../../routes/registry/catalog');

const getHandler = (method, path) => {
  const router = catalogRouter.default || catalogRouter;
  const layer = router.stack.find((entry) => (
    entry.route && entry.route.path === path && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`${method.toUpperCase()} ${path} handler not found`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

const response = () => ({
  status: jest.fn().mockReturnThis(),
  json: jest.fn(),
});

const roleLookup = (role) => {
  User.findById.mockReturnValue({
    select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(role ? { role } : null) }),
  });
};

const listAgents = getHandler('get', '/agents');

describe('hire catalog verified gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    AgentRegistry.search.mockResolvedValue([]);
    AgentIdentityService.getAgentTypeConfig.mockReturnValue(null);
    roleLookup('user');
  });

  it('defaults a regular user to verified-only when no param is passed', async () => {
    await listAgents({ query: {}, userId: 'caller-1' }, response());
    expect(AgentRegistry.search).toHaveBeenCalledWith(undefined,
      expect.objectContaining({ verified: true }));
  });

  it('a regular user passing verified=false must NOT reopen the leak', async () => {
    await listAgents({ query: { verified: 'false' }, userId: 'caller-1' }, response());
    expect(AgentRegistry.search).toHaveBeenCalledWith(undefined,
      expect.objectContaining({ verified: true }));
  });

  it('an admin may list unverified rows for registry ops', async () => {
    roleLookup('admin');
    await listAgents({ query: { verified: 'false' }, userId: 'caller-1' }, response());
    expect(AgentRegistry.search).toHaveBeenCalledWith(undefined,
      expect.objectContaining({ verified: false }));
  });

  it('an explicit verified=true request skips the role lookup entirely', async () => {
    await listAgents({ query: { verified: 'true' }, userId: 'caller-1' }, response());
    expect(User.findById).not.toHaveBeenCalled();
    expect(AgentRegistry.search).toHaveBeenCalledWith(undefined,
      expect.objectContaining({ verified: true }));
  });

  it('parked moltbot rows stay excluded even when verified', async () => {
    AgentRegistry.search.mockResolvedValue([
      { agentName: 'newshound', verified: true },
      { agentName: 'claude-code', verified: true },
    ]);
    AgentIdentityService.getAgentTypeConfig.mockImplementation((name) => (
      name === 'newshound' ? { runtime: 'moltbot' } : null
    ));
    const res = response();
    await listAgents({ query: {}, userId: 'caller-1' }, res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.agents.map((a) => a.name)).toEqual(['claude-code']);
  });
});
