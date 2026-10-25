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
  recordCatchUp: jest.fn(),
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
jest.mock('../../../models/User', () => ({ findById: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentCredential', () => ({ findOne: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/File', () => ({ findOne: jest.fn(), deleteOne: jest.fn() }));
jest.mock('../../../services/objectStore', () => ({ getObjectStore: jest.fn() }));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ type: 'chat' }) }) })),
}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn(), canViewPod: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn(), updateOne: jest.fn() },
}));

const DMService = require('../../../services/dmService');
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

describe('agent card route boundary', () => {
  const installation = { podId: 'pod-1', agentName: 'openclaw', instanceId: 'default', config: {} };
  const payload = { kind: 'ui', v: 1, lang: 'openui@1', source: 'root = Text("hello")' };
  const handler = getRouteHandler('/pods/:podId/messages', 'post');
  const req = (body) => ({ params: { podId: 'pod-1' }, body: { continueAnyway: true, ...body },
    agentInstallation: installation, agentInstallations: [installation] });
  const response = () => ({ status: jest.fn().mockReturnThis(), json: jest.fn() });
  beforeEach(() => { jest.clearAllMocks(); findNonMemberMentionNotices.mockResolvedValue([]); });
  it('forwards a validated UI payload unchanged to the durable message writer', async () => {
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    const res = response();
    await handler(req({ messageType: 'card', payload, content: 'fallback' }), res);
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      messageType: 'card', payload, content: 'fallback',
    }));
    expect(res.status).not.toHaveBeenCalled();
  });
  it.each([
    { ...payload, kind: 'approval' },
    { ...payload, source: 'root = Text("hello")\nq = Query("secret", {})' },
    { ...payload, source: 'root = Unknown("hello")' },
  ])('refuses unsafe cards before persistence or mention fan-out %#', async (badPayload) => {
    const res = response();
    await handler(req({ messageType: 'card', payload: badPayload, content: 'fallback' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
    expect(findNonMemberMentionNotices).not.toHaveBeenCalled();
  });
  it('refuses a fallback that the existing sanitizer suppresses', async () => {
    AgentMessageService.sanitizeAgentContent.mockReturnValueOnce('');
    const res = response();
    await handler(req({ messageType: 'card', payload, content: 'NO_REPLY' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
  });
  it('keeps the pod authorization check ahead of parsing', async () => {
    const res = response();
    await handler({ ...req({ payload }), params: { podId: 'other' } }, res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
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

  it.each(['ui', 'approval'])('validates bot-token card kind %s before writing', async (kind) => {
    const payload = { kind, v: 1, lang: 'openui@1', source: 'root = Text("hello")' };
    AgentMessageService.postMessage.mockResolvedValue({ success: true });
    const res = response();
    await getRouteHandler('/bot/pods/:podId/messages', 'post')({ ...req,
      body: { content: 'fallback', messageType: 'card', payload, continueAnyway: true } }, res);
    if (kind === 'ui') {
      expect(AgentMessageService.postMessage).toHaveBeenCalledWith(expect.objectContaining({
        content: 'fallback', messageType: 'card', payload,
      }));
      expect(res.status).not.toHaveBeenCalled();
    } else {
      expect(res.status).toHaveBeenCalledWith(400);
      expect(AgentMessageService.postMessage).not.toHaveBeenCalled();
      expect(findNonMemberMentionNotices).not.toHaveBeenCalled();
    }
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


describe('explicit catch-up', () => {
  const handler = getRouteHandler('/pods/:podId/catch-up', 'post');
  const installation = { podId: 'pod-1', agentName: 'openclaw' };
  const req = { params: { podId: 'pod-1' }, body: { confirmSkipHistory: true },
    agentUser: { _id: 'bot-1' }, agentInstallation: installation };
  const response = () => ({ status: jest.fn().mockReturnThis(), set: jest.fn(), json: jest.fn() });
  beforeEach(() => {
    jest.clearAllMocks();
    DMService.canViewPod.mockResolvedValue(true);
    AgentMessageService.getRecentMessages.mockResolvedValue([{ id: '1', content: 'tail' }]);
    AgentSendFreshness.recordCatchUp.mockResolvedValue({ skippedCount: 14000 });
  });
  it('requires explicit confirmation and pod authorization before any reads or cursor writes', async () => {
    const noConfirm = response();
    await handler({ ...req, body: {} }, noConfirm);
    expect(noConfirm.status).toHaveBeenCalledWith(400);
    const wrongPod = response();
    await handler({ ...req, params: { podId: 'other' } }, wrongPod);
    expect(wrongPod.status).toHaveBeenCalledWith(403);
    expect(AgentSendFreshness.readStart).not.toHaveBeenCalled();
    expect(AgentSendFreshness.recordCatchUp).not.toHaveBeenCalled();
  });
  it('captures the fence before fetching a bounded tail and reports skipped history', async () => {
    const res = response();
    const original = process.env.PG_HOST;
    delete process.env.PG_HOST;
    try { await handler(req, res); } finally {
      if (original === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = original;
    }
    expect(AgentSendFreshness.readStart.mock.invocationCallOrder[0])
      .toBeLessThan(AgentMessageService.getRecentMessages.mock.invocationCallOrder[0]);
    expect(AgentMessageService.getRecentMessages).toHaveBeenCalledWith('pod-1', 20, 'bot-1');
    expect(AgentSendFreshness.recordCatchUp).toHaveBeenCalledWith('bot-1', 'pod-1', expect.any(Object), ['1']);
    expect(res.json).toHaveBeenCalledWith({ messages: [{ id: '1', content: 'tail' }],
      catchUp: { skippedCount: 14000, through: expect.any(Object) } });
  });
  it('does not acknowledge a Mongo fallback while PostgreSQL is configured', async () => {
    const original = process.env.PG_HOST;
    process.env.PG_HOST = 'configured';
    const res = response();
    try { await handler(req, res); } finally {
      if (original === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = original;
    }
    expect(res.status).toHaveBeenCalledWith(503);
    expect(AgentSendFreshness.recordCatchUp).not.toHaveBeenCalled();
  });
  it('returns a retryable failure instead of a receipt when the cursor write fails', async () => {
    const original = process.env.PG_HOST;
    delete process.env.PG_HOST;
    AgentSendFreshness.recordCatchUp.mockRejectedValueOnce(new Error('cursor unavailable'));
    const res = response();
    try { await handler(req, res); } finally {
      if (original === undefined) delete process.env.PG_HOST;
      else process.env.PG_HOST = original;
    }
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).not.toHaveBeenCalledWith(expect.objectContaining({ catchUp: expect.anything() }));
  });

  it('refuses a scoped token whose canonical agent cannot view the pod, before reading or advancing', async () => {
    DMService.canViewPod.mockResolvedValueOnce(false);
    const res = response();
    await handler(req, res);
    expect(DMService.canViewPod).toHaveBeenCalledWith('bot-1', { type: 'chat' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(AgentSendFreshness.readStart).not.toHaveBeenCalled();
    expect(AgentMessageService.getRecentMessages).not.toHaveBeenCalled();
    expect(AgentSendFreshness.recordCatchUp).not.toHaveBeenCalled();
  });

});


describe('send freshness through real legacy-token HTTP authentication', () => {
  const express = require('express');
  const request = require('supertest');
  const realAuth = jest.requireActual('../../../middleware/agentRuntimeAuth');
  const User = require('../../../models/User');
  const Credential = require('../../../models/AgentCredential');
  const { AgentInstallation } = require('../../../models/AgentRegistry');
  const Identity = require('../../../services/agentIdentityService');
  const { hash } = require('../../../utils/secret');
  const token = 'cm_agent_legacy_fixture';
  const app = express();
  app.get('/api/agents/runtime/pods/:podId/send-freshness', realAuth,
    getRouteHandler('/pods/:podId/send-freshness', 'get'));
  beforeEach(() => {
    jest.clearAllMocks();
    Credential.findOne.mockResolvedValue(null);
    User.findOne.mockResolvedValue(null);
    const installation = { _id: 'legacy-install', podId: 'pod-1', agentName: 'openclaw', instanceId: 'legacy',
      runtimeTokens: [{ tokenHash: hash(token), lastUsedAt: new Date() }] };
    AgentInstallation.findOne.mockResolvedValue(installation);
    AgentInstallation.find.mockResolvedValue([installation]);
    AgentSendFreshness.unseenMessages.mockResolvedValue(null);
  });
  it('resolves a canonical identity when legacy auth has no bot User and returns freshness', async () => {
    await request(app).get('/api/agents/runtime/pods/pod-1/send-freshness')
      .set('Authorization', `Bearer ${token}`).expect(200, { ok: true });
    expect(Identity.getOrCreateAgentUser).toHaveBeenCalledWith('openclaw', {
      instanceId: 'legacy', displayName: undefined,
    });
    expect(AgentSendFreshness.unseenMessages).toHaveBeenCalledWith('bot-1', 'pod-1');
  });
  it('still refuses another pod before canonical identity resolution or freshness lookup', async () => {
    await request(app).get('/api/agents/runtime/pods/other/send-freshness')
      .set('Authorization', `Bearer ${token}`).expect(403);
    expect(Identity.getOrCreateAgentUser).not.toHaveBeenCalled();
    expect(AgentSendFreshness.unseenMessages).not.toHaveBeenCalled();
  });
});
