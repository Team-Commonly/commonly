/**
 * #758 — the agent runtime router must never emit an inline base64 avatar.
 *
 * This mounts the REAL router in an express app (rather than pulling a handler
 * out of the stack) specifically so the router-level middleware runs. The
 * guarantee under test is the choke point itself: individual handlers are
 * allowed to hand up whole populated user documents, and the router is what
 * makes that safe. A per-handler test would pass even if the middleware were
 * deleted.
 */

// Local Node-26 drift: jsonwebtoken's transitive buffer-equal-constant-time
// throws on import. CI (Node 20) is unaffected; this keeps the suite runnable
// on a dev machine without changing what is under test.
jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  req.agentInstallations = [{ podId: 'pod-1', status: 'active' }];
  req.agentAuthorizedPodIds = ['pod-1'];
  next();
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));

jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  buildAgentUsername: jest.fn((a) => a),
}));
jest.mock('../../../services/agentMessageService', () => ({
  getRecentMessages: jest.fn(),
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

const express = require('express');
const request = require('supertest');

const AgentMessageService = require('../../../services/agentMessageService');
const router = require('../../../routes/agentsRuntime');

const DATA_URI = `data:image/jpeg;base64,${'A'.repeat(4000)}`;

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

describe('agent runtime router strips inline avatars (#758)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('GET /pods/:podId/messages returns no data: URI even when the service supplies one', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValue([
      {
        _id: 'm1',
        id: 'm1',
        content: 'hello',
        username: 'sam',
        isBot: false,
        self: false,
        userId: { _id: 'u1', username: 'sam', profilePicture: DATA_URI },
        profile_picture: DATA_URI,
      },
    ]);

    const res = await request(app).get('/api/agents/runtime/pods/pod-1/messages');

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain('data:');
    // The conversation itself must survive untouched.
    expect(res.body.messages[0].content).toBe('hello');
    expect(res.body.messages[0].username).toBe('sam');
    // And so must the fields the wrapper's self-post detection depends on (#757).
    expect(res.body.messages[0]).toHaveProperty('isBot', false);
    expect(res.body.messages[0]).toHaveProperty('self', false);
  });

  test('a URL avatar still reaches the agent — only base64 is dropped', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValue([
      {
        _id: 'm1',
        id: 'm1',
        content: 'hi',
        username: 'sam',
        userId: { _id: 'u1', username: 'sam', profilePicture: '/api/uploads/a.png' },
      },
    ]);

    const res = await request(app).get('/api/agents/runtime/pods/pod-1/messages');

    expect(res.status).toBe(200);
    expect(res.body.messages[0].userId.profilePicture).toBe('/api/uploads/a.png');
  });

  test('the payload actually shrinks — this is a context-window fix, not cosmetics', async () => {
    AgentMessageService.getRecentMessages.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        _id: `m${i}`,
        id: `m${i}`,
        content: 'a short line of conversation',
        username: 'sam',
        userId: { _id: 'u1', username: 'sam', profilePicture: DATA_URI },
        profile_picture: DATA_URI,
      })),
    );

    const res = await request(app).get('/api/agents/runtime/pods/pod-1/messages');
    const size = JSON.stringify(res.body).length;

    // 20 messages x 2 copies x ~4KB would be ~160KB unstripped.
    expect(size).toBeLessThan(5000);
  });
});
