/**
 * POST /api/agents/runtime/threads/:threadId/comments carries the wrapper's
 * onlyIfUnanswered through to the service (F225). It is what stops a reply the
 * seat already posted through a tool from being posted twice, and a route that
 * dropped it would lose that with no error anywhere.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallation = { agentName: 'seat', instanceId: 'default', scopes: [] };
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
jest.mock('../../../models/Pod', () => ({ findOne: jest.fn(), find: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn().mockResolvedValue(null), find: jest.fn() },
}));
jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: new Set(['agent-room', 'agent-dm']),
  buildAgentUsername: jest.fn((a) => a),
}));
jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({ postComment: jest.fn() }));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: jest.fn().mockResolvedValue({}),
}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));

const express = require('express');
const request = require('supertest');
const router = require('../../../routes/agentsRuntime');
const Post = require('../../../models/Post');
const AgentThreadService = require('../../../services/agentThreadService');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

beforeEach(() => {
  jest.clearAllMocks();
  Post.findById.mockReturnValue({
    select: () => ({ lean: async () => ({ _id: 'post-1', podId: null }) }),
  });
  AgentThreadService.postComment.mockResolvedValue({ success: true, duplicate: true });
});

const postComment = (body) => request(app).post('/api/agents/runtime/threads/post-1/comments').send(body);

test('passes onlyIfUnanswered to the service, and returns its answer', async () => {
  const res = await postComment({ content: 'hi', replyToCommentId: 'c1', onlyIfUnanswered: true });
  expect(res.status).toBe(200);
  expect(res.body).toEqual({ success: true, duplicate: true });
  expect(AgentThreadService.postComment).toHaveBeenCalledWith(expect.objectContaining({
    threadId: 'post-1', content: 'hi', replyToCommentId: 'c1', onlyIfUnanswered: true,
  }));
});

test('a tool call that leaves it out keeps today\'s behaviour', async () => {
  await postComment({ content: 'hi', replyToCommentId: 'c1' });
  expect(AgentThreadService.postComment).toHaveBeenCalledWith(expect.objectContaining({ onlyIfUnanswered: false }));
});

test('content that isn\'t text is a bad request, not a server error', async () => {
  const res = await postComment({ content: { text: 'hi' } });
  expect(res.status).toBe(400);
  expect(res.body).toEqual({ message: 'content must be a string' });
  expect(AgentThreadService.postComment).not.toHaveBeenCalled();
});
