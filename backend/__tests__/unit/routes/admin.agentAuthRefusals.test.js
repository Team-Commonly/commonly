// The route's guard order (rate limit, auth, adminAuth) is pinned by the route
// guard test. These cases send real requests through the router so the status
// codes an operator sees are checked, not just the handler's return value.
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  if (!req.headers['x-test-user']) return res.status(401).json({ message: 'No token' });
  req.user = { id: req.headers['x-test-user'] };
  return next();
});
jest.mock('../../../middleware/adminAuth', () => (req, res, next) => {
  if (req.headers['x-test-role'] !== 'admin') return res.status(403).json({ message: 'Admin only' });
  return next();
});
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: () => 'test-ip',
}));

const express = require('express');
const request = require('supertest');
const adminAgentAuthRoutes = require('../../../routes/admin/agentAuthRefusals');
const {
  AGENT_AUTH_REFUSAL_REASONS,
  recordAgentAuthRefusal,
  resetAgentAuthRefusalsForTest,
} = require('../../../services/agentAuthRefusals');

const buildApp = () => {
  const app = express();
  app.use('/api/admin/agent-auth', adminAgentAuthRoutes);
  return app;
};

describe('GET /api/admin/agent-auth/refusals (TASK-712)', () => {
  beforeEach(() => {
    resetAgentAuthRefusalsForTest();
  });

  test('an unauthenticated request is refused with 401', async () => {
    const res = await request(buildApp()).get('/api/admin/agent-auth/refusals');
    expect(res.status).toBe(401);
  });

  test('an authenticated non-admin is refused with 403', async () => {
    const res = await request(buildApp())
      .get('/api/admin/agent-auth/refusals')
      .set('x-test-user', 'user-1');
    expect(res.status).toBe(403);
  });

  test('an admin gets the per-reason counts since process start', async () => {
    recordAgentAuthRefusal({
      reason: 'invalid_token', route: '/api/agents/runtime/context', method: 'GET', tokenHash: 'token-hash-fixture',
    });
    recordAgentAuthRefusal({
      reason: 'invalid_token', route: '/api/agents/runtime/context', method: 'GET', tokenHash: 'token-hash-fixture',
    });

    const res = await request(buildApp())
      .get('/api/admin/agent-auth/refusals')
      .set('x-test-user', 'admin-1')
      .set('x-test-role', 'admin');

    expect(res.status).toBe(200);
    expect(res.body.since).toEqual(expect.any(String));
    expect(Object.keys(res.body.counts).sort()).toEqual([...AGENT_AUTH_REFUSAL_REASONS].sort());
    expect(res.body.counts.invalid_token).toBe(2);
    expect(res.body.counts.missing_token).toBe(0);
  });
});
