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
// agentsRuntime mounts its upload route at module load. This test exercises
// the message route only, so isolate the upload stack (and its JWT/native
// dependency chain) rather than making this route contract test depend on it.
jest.mock('../../../routes/uploads', () => ({
  uploadSingle: () => (req, res, next) => next(),
  handleUpload: jest.fn(),
}));
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

  // answeringMessageId tells the answer rule which message a post answers
  // (agentAnswerService): it completes "Give your agent its first task" and
  // suppresses a needs-you row. Only the native runtime sets it, from its run's
  // own trigger. A CAP request (and every MCP tool, which posts through this
  // route) cannot name one, or any agent could close someone's onboarding card.
  it('never forwards answeringMessageId from a request body', async () => {
    const handler = getRouteHandler('/pods/:podId/messages', 'post');
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    const installation = {
      podId: 'pod-1', agentName: 'openclaw', instanceId: 'tarik', displayName: 'Tarik', config: {},
    };
    const req = {
      params: { podId: 'pod-1' },
      body: { content: 'hello', messageType: 'text', answeringMessageId: '78385' },
      agentInstallation: installation,
      agentInstallations: [installation],
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage.mock.calls[0][0]).not.toHaveProperty('answeringMessageId');
  });
});
