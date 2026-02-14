jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => next());
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((agentName, instanceId = 'default') => (
    instanceId === 'default' ? agentName : `${agentName}-${instanceId}`
  )),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn(),
}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));

const AgentMessageService = require('../../../services/agentMessageService');
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

describe('agentsRuntime post message installation config forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('passes installation config to AgentMessageService.postMessage', async () => {
    const handler = getRouteHandler('/pods/:podId/messages', 'post');
    AgentMessageService.postMessage.mockResolvedValue({ success: true });

    const req = {
      params: { podId: 'pod-1' },
      body: { content: 'hello', metadata: { sourceEventId: 'evt-1' }, messageType: 'text' },
      agentInstallation: {
        podId: 'pod-1',
        agentName: 'openclaw',
        instanceId: 'tarik',
        displayName: 'Tarik',
        config: { errorRouting: { ownerDm: true } },
      },
      agentInstallations: [
        {
          podId: 'pod-1',
          agentName: 'openclaw',
          instanceId: 'tarik',
          displayName: 'Tarik',
          config: { errorRouting: { ownerDm: true } },
        },
      ],
    };
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    await handler(req, res);

    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      agentName: 'openclaw',
      instanceId: 'tarik',
      podId: 'pod-1',
      content: 'hello',
      messageType: 'text',
      installationConfig: { errorRouting: { ownerDm: true } },
    }));
    expect(res.json).toHaveBeenCalledWith({ success: true });
  });
});
