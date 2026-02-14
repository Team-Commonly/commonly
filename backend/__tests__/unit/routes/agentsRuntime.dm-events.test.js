jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({
  list: jest.fn(),
}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
  getOrCreateAgentUser: jest.fn(),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../services/dmService', () => ({
  getOrCreateAgentDM: jest.fn(),
}));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
}));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: {
    find: jest.fn(),
    findOne: jest.fn(),
  },
}));

const AgentEventService = require('../../../services/agentEventService');
const AgentIdentityService = require('../../../services/agentIdentityService');
const DMService = require('../../../services/dmService');
const Pod = require('../../../models/Pod');
const { AgentInstallation } = require('../../../models/AgentRegistry');
const router = require('../../../routes/agentsRuntime');

const getRouteHandler = (path, method) => {
  const layer = router.stack.find((entry) => (
    entry.route
    && entry.route.path === path
    && entry.route.methods[method]
  ));
  if (!layer) throw new Error(`Route not found: ${method.toUpperCase()} ${path}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
};

describe('agentsRuntime DM and event pod coverage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes agent-admin DM pod ids in GET /events polling scope', async () => {
    const handler = getRouteHandler('/events', 'get');

    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([{ _id: 'dm-pod-1' }]),
    });
    AgentEventService.list.mockResolvedValue([]);

    const req = {
      query: {},
      agentInstallation: { agentName: 'openclaw', instanceId: 'liz', podId: 'pod-1' },
      agentInstallations: [{ podId: 'pod-1' }],
      agentUser: { _id: 'bot-user-1', username: 'openclaw-liz' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(AgentEventService.list).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'liz',
      podIds: ['pod-1', 'dm-pod-1'],
    }));
    expect(res.json).toHaveBeenCalledWith({ events: [] });
  });

  it('creates or returns DM pod via POST /dm', async () => {
    const handler = getRouteHandler('/dm', 'post');

    AgentInstallation.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([
        {
          agentName: 'openclaw',
          instanceId: 'liz',
          podId: 'pod-1',
          installedBy: 'user-1',
        },
      ]),
    });
    Pod.find.mockReturnValue({
      select: jest.fn().mockReturnThis(),
      lean: jest.fn().mockResolvedValue([]),
    });
    AgentIdentityService.getOrCreateAgentUser.mockResolvedValue({ _id: 'bot-user-1' });
    DMService.getOrCreateAgentDM.mockResolvedValue({ _id: 'dm-pod-1', type: 'agent-admin' });

    const req = {
      userId: 'user-1',
      body: { agentName: 'openclaw', instanceId: 'liz' },
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(AgentInstallation.find).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'liz',
      status: 'active',
    }));
    expect(AgentIdentityService.getOrCreateAgentUser).toHaveBeenCalledWith('openclaw', 'liz');
    expect(DMService.getOrCreateAgentDM).toHaveBeenCalledWith('bot-user-1', 'user-1', {
      agentName: 'openclaw',
      instanceId: 'liz',
    });
    expect(res.json).toHaveBeenCalledWith({ dmPod: { _id: 'dm-pod-1', type: 'agent-admin' } });
  });
});
