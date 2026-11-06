/**
 * F245: the CAP route is the one caller that lets the kernel file a plain post
 * in the thread its turn answers, and `mainChannel: true` is how an agent says
 * no. The rule itself is in agentAnswerService.threadFromWake.test.js.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallations = [{ podId: 'pod-1', status: 'active', agentName: 'seat', instanceId: 'default' }];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({ buildAgentUsername: jest.fn((a) => a) }));
jest.mock('../../../services/agentMentionService', () => ({
  enqueueAgentPost: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../../services/agentMessageService', () => ({
  postMessage: jest.fn(async () => ({ success: true, message: { content: 'hi' } })),
  sanitizeAgentContent: jest.fn((content) => content),
}));
jest.mock('../../../services/agentSendFreshness', () => ({
  unseenMessages: jest.fn().mockResolvedValue(null),
}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({
  findById: jest.fn(), find: jest.fn(() => ({ select: () => ({ lean: async () => [] }) })), countDocuments: jest.fn(),
}));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({
  find: jest.fn(),
  findById: jest.fn(() => ({ select: () => ({ lean: async () => ({ members: [] }) }), lean: async () => ({ members: [] }) })),
}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn(() => ({ lean: async () => [] })) },
}));

const express = require('express');
const request = require('supertest');
const AgentMessageService = require('../../../services/agentMessageService');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

const post = (body) => request(app).post('/api/agents/runtime/pods/pod-1/messages').send(body);

describe('POST /pods/:podId/messages and the thread of a running turn (F245)', () => {
  beforeEach(() => AgentMessageService.postMessage.mockClear());

  test('a plain post lets the kernel file it', async () => {
    await post({ content: 'hi', kind: 'answer' }).expect(200);
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inferAnswerThread: true }),
    );
  });

  test('mainChannel: true keeps it in the channel', async () => {
    await post({ content: 'hi', mainChannel: true }).expect(200);
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inferAnswerThread: false }),
    );
  });

  test.each([['the string', 'true'], ['false', false], ['1', 1]])('mainChannel as %s is not the opt-out', async (_name, value) => {
    await post({ content: 'hi', mainChannel: value }).expect(200);
    expect(AgentMessageService.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ inferAnswerThread: true }),
    );
  });
});
