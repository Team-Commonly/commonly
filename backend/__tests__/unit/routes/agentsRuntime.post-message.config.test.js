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
  getOrCreateAgentUser: jest.fn().mockResolvedValue({ _id: 'bot-1' }),
  ensureAgentInPod: jest.fn(),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn(),
  getRecentMessages: jest.fn(),
  sanitizeAgentContent: jest.fn((content) => content),
}));
jest.mock('../../../services/agentSendFreshness', () => ({
  readStart: jest.fn(async () => ({ at: new Date('2026-10-24T00:00:00Z') })),
  recordRead: jest.fn(),
  unseenMessages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/mentionNonMemberNoticeService', () => ({
  findNonMemberMentionNotices: jest.fn(),
}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({ getPodContext: jest.fn() }));
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
jest.mock('../../../models/File', () => ({ findOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../../../services/objectStore', () => ({ getObjectStore: jest.fn() }));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ type: 'chat' }) }) })),
}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));

const AgentMessageService = require('../../../services/agentMessageService');
const AgentSendFreshness = require('../../../services/agentSendFreshness');
const PodContextService = require('../../../services/podContextService');
const File = require('../../../models/File');
const { getObjectStore } = require('../../../services/objectStore');
const { findNonMemberMentionNotices } = require('../../../services/mentionNonMemberNoticeService');
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
    findNonMemberMentionNotices.mockResolvedValue([]);
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
    expect(res.json).toHaveBeenCalledWith({ success: true, mentionNotices: [] });
  });

  it('returns structured non-member feedback in the MCP post result', async () => {
    const handler = getRouteHandler('/pods/:podId/messages', 'post');
    AgentMessageService.postMessage.mockResolvedValue({
      success: true, message: { id: 'm1', content: 'Please review @rhea' },
    });
    findNonMemberMentionNotices.mockResolvedValue([{ code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: "rhea isn't in this pod. Invite them, or ask in a pod they're in." }]);
    const installation = { podId: 'pod-1', agentName: 'openclaw', instanceId: 'tarik', config: {} };
    const req = {
      params: { podId: 'pod-1' }, body: { content: 'Please review @rhea' },
      agentUser: { _id: 'bot-1' },
      agentInstallation: installation, agentInstallations: [installation],
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };

    await handler(req, res);

    expect(findNonMemberMentionNotices).toHaveBeenCalledWith('pod-1', 'Please review @rhea', 'bot-1');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      mentionNotices: [{ code: 'MENTION_NOT_IN_POD', handle: 'rhea', message: "rhea isn't in this pod. Invite them, or ask in a pod they're in." }],
      notice: "rhea isn't in this pod. Invite them, or ask in a pod they're in.",
    }));
  });

  it('still reports a successful post if the advisory lookup fails', async () => {
    const handler = getRouteHandler('/pods/:podId/messages', 'post');
    AgentMessageService.postMessage.mockResolvedValue({
      success: true, message: { id: 'm1', content: '@rhea please review' },
    });
    findNonMemberMentionNotices.mockRejectedValueOnce(new Error('lookup unavailable'));
    const installation = { podId: 'pod-1', agentName: 'openclaw', instanceId: 'tarik', config: {} };
    const req = {
      params: { podId: 'pod-1' }, body: { content: '@rhea please review' },
      agentInstallation: installation, agentInstallations: [installation],
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      await handler(req, res);
      expect(res.status).not.toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        success: true, message: { id: 'm1', content: '@rhea please review' }, mentionNotices: [],
      });
    } finally {
      warn.mockRestore();
    }
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

  it('holds an unseen conversation and permits an explicit override', async () => {
    const handler = getRouteHandler('/pods/:podId/messages', 'post');
    const installation = { podId: 'pod-1', agentName: 'openclaw', instanceId: 'tarik', config: {} };
    const req = {
      params: { podId: 'pod-1' }, body: { content: 'hello' }, agentUser: { _id: 'bot-1' },
      agentInstallation: installation, agentInstallations: [installation],
    };
    const res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    const hold = { code: 'unseen_messages', unseenCount: 4, messages: [{ id: '7' }] };
    AgentSendFreshness.unseenMessages.mockResolvedValueOnce(hold);

    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(hold);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();

    req.body.continueAnyway = true;
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    await handler(req, res);
    expect(AgentSendFreshness.unseenMessages).toHaveBeenCalledTimes(1);
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('bot-token send-time freshness', () => {
  const user = {
    _id: 'bot-1', username: 'openclaw', isBot: true,
    botMetadata: { agentName: 'openclaw', instanceId: 'default' },
  };
  const req = { params: { podId: 'pod-1' }, userId: 'bot-1', query: {}, body: { content: 'hello' } };
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

  beforeEach(() => {
    jest.clearAllMocks();
    require('../../../models/User').findById.mockReturnValue({ lean: async () => user });
    require('../../../models/AgentRegistry').AgentInstallation.findOne.mockReturnValue({
      lean: async () => ({ agentName: 'openclaw', instanceId: 'default', displayName: 'OpenClaw' }),
    });
  });

  it('stamps only a successful bot-token message read and holds a stale post', async () => {
    const messages = [{ id: 'm1', content: 'new message' }];
    AgentMessageService.getRecentMessages.mockResolvedValue(messages);
    const get = getRouteHandler('/bot/pods/:podId/messages', 'get');
    const getRes = response();
    await get(req, getRes);
    expect(getRes.json).toHaveBeenCalledWith({ messages });
    expect(AgentSendFreshness.recordRead).toHaveBeenCalledWith(
      'bot-1', 'pod-1', expect.objectContaining({ at: expect.any(Date) }), ['m1'],
    );

    AgentSendFreshness.unseenMessages.mockResolvedValueOnce({ code: 'unseen_messages', unseenCount: 1 });
    const post = getRouteHandler('/bot/pods/:podId/messages', 'post');
    const heldRes = response();
    await post(req, heldRes);
    expect(heldRes.status).toHaveBeenCalledWith(409);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();

    AgentMessageService.postMessage.mockResolvedValueOnce({ success: true });
    const allowedRes = response();
    await post({ ...req, body: { content: 'hello', continueAnyway: true } }, allowedRes);
    expect(allowedRes.json).toHaveBeenCalledWith({ success: true });
    expect(AgentMessageService.postMessage).toHaveBeenCalledTimes(1);
  });

  it('stamps bot-token context only when its recent messages were read', async () => {
    const get = getRouteHandler('/bot/pods/:podId/context', 'get');
    PodContextService.getPodContext.mockResolvedValueOnce({ _recentMessagesRead: false, summary: 'cached' });
    await get(req, response());
    expect(AgentSendFreshness.recordRead).not.toHaveBeenCalled();

    PodContextService.getPodContext.mockResolvedValueOnce({ _recentMessagesRead: true, summary: 'fresh' });
    const res = response();
    await get(req, res);
    expect(AgentSendFreshness.recordRead).toHaveBeenCalledTimes(1);
    expect(res.json).toHaveBeenCalledWith({ summary: 'fresh' });
  });
});

describe('attachment freshness', () => {
  const installation = { podId: 'pod-1', agentName: 'openclaw', instanceId: 'default' };
  const req = {
    params: { podId: 'pod-1', fileName: 'file-1.txt' },
    agentUser: { _id: 'bot-1' },
    agentInstallation: installation,
    agentInstallations: [installation],
  };
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });

  beforeEach(() => jest.clearAllMocks());

  it('holds before upload when the pod has unseen messages', async () => {
    const handler = getRouteHandler('/pods/:podId/send-freshness', 'get');
    const hold = { code: 'unseen_messages', unseenCount: 1 };
    AgentSendFreshness.unseenMessages.mockResolvedValueOnce(hold);
    const res = response();
    await handler(req, res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith(hold);
  });

  it('keeps a published file card outside any cleanup route', async () => {
    const post = getRouteHandler('/pods/:podId/messages', 'post');
    AgentMessageService.postMessage.mockResolvedValue({ success: true, message: { id: 'm1' } });
    const res = response();
    await post({
      ...req,
      body: { content: '[[upload:file-1.txt|report.txt|42|document]]', continueAnyway: true },
    }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(() => getRouteHandler('/pods/:podId/uploads/:fileName', 'delete')).toThrow('Route not found');
    expect(File.deleteOne).not.toHaveBeenCalled();
    expect(getObjectStore).not.toHaveBeenCalled();
  });
});
