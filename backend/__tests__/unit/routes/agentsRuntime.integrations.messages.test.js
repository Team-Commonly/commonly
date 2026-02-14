jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../models/Integration', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
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

describe('agentsRuntime integration messages route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('allows reading global X integration message buffer from any authorized pod install', async () => {
    const handler = getRouteHandler('/pods/:podId/integrations/:integrationId/messages', 'get');

    Integration.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        _id: 'global-x-1',
        type: 'x',
        config: {
          agentAccessEnabled: true,
          globalAgentAccess: true,
          messageBuffer: [
            {
              messageId: 'tweet-2',
              content: 'newer post',
              authorName: '@alice',
              authorId: 'u2',
              timestamp: '2026-02-08T01:02:00.000Z',
              metadata: { url: 'https://x.com/alice/status/tweet-2' },
            },
            {
              messageId: 'tweet-1',
              content: 'older post',
              authorName: '@bob',
              authorId: 'u1',
              timestamp: '2026-02-08T01:00:00.000Z',
              metadata: { url: 'https://x.com/bob/status/tweet-1' },
            },
          ],
        },
      }),
    });

    const req = {
      params: { podId: 'pod-1', integrationId: 'global-x-1' },
      query: { limit: '1' },
      agentInstallation: {
        podId: 'pod-1',
        scopes: ['integration:messages:read'],
      },
      agentInstallations: [
        {
          podId: 'pod-1',
          scopes: ['integration:messages:read'],
        },
      ],
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(Integration.findOne).toHaveBeenCalledWith({
      _id: 'global-x-1',
      'config.agentAccessEnabled': true,
      status: 'connected',
      isActive: true,
      $or: [
        { podId: 'pod-1' },
        { 'config.globalAgentAccess': true },
      ],
    });
    expect(res.json).toHaveBeenCalledWith({
      messages: [
        expect.objectContaining({
          id: 'tweet-2',
          content: 'newer post',
          author: '@alice',
        }),
      ],
    });
  });
});
