jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({ AgentInstallation: { findOne: jest.fn(), find: jest.fn() } }));

const Integration = require('../../../models/Integration');
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

describe('agentsRuntime integrations global access', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('includes global agent-access integrations along with pod integrations', async () => {
    const handler = getRouteHandler('/pods/:podId/integrations', 'get');

    Integration.find
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'pod-int-1',
              type: 'discord',
              config: {
                channelId: 'c1',
                channelName: 'general',
                botToken: 'discord-token',
              },
            },
          ]),
        }),
      })
      .mockReturnValueOnce({
        select: jest.fn().mockReturnValue({
          lean: jest.fn().mockResolvedValue([
            {
              _id: 'global-x-1',
              type: 'x',
              config: {
                accessToken: 'x-token',
                globalAgentAccess: true,
              },
            },
          ]),
        }),
      });

    const req = {
      params: { podId: 'pod-1' },
      agentInstallation: {
        podId: 'pod-1',
        scopes: ['integration:read'],
      },
      agentInstallations: [
        {
          podId: 'pod-1',
          scopes: ['integration:read'],
        },
      ],
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(Integration.find).toHaveBeenNthCalledWith(1, {
      podId: 'pod-1',
      'config.agentAccessEnabled': true,
      status: 'connected',
    });
    expect(Integration.find).toHaveBeenNthCalledWith(2, {
      'config.agentAccessEnabled': true,
      'config.globalAgentAccess': true,
      status: 'connected',
      isActive: true,
    });

    expect(res.json).toHaveBeenCalledWith({
      integrations: expect.arrayContaining([
        expect.objectContaining({ id: 'pod-int-1', type: 'discord', botToken: 'discord-token' }),
        expect.objectContaining({ id: 'global-x-1', type: 'x', accessToken: 'x-token' }),
      ]),
    });
  });
});
