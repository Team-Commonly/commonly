// The route's guard order (rate limit, auth, adminAuth) is pinned by the route
// guard test. These cases send real requests through the router with the real
// auth and adminAuth middleware, so the status codes an operator sees are the
// ones the real guards produce. Only the data they read is faked.
jest.mock('../../../services/sessionAccountService', () => ({
  loadSessionAccount: jest.fn(async (id) => ({
    'admin-1': {
      _id: 'admin-1', username: 'admin', email: 'a@x.test', role: 'admin', 
    },
    'user-1': {
      _id: 'user-1', username: 'user', email: 'u@x.test', role: 'user', 
    },
  }[id] || null)),
  sessionRefusal: jest.fn((account) => (account ? null : 'missing')),
  isAccountInstanceRestricted: jest.fn(async () => false),
}));
jest.mock('../../../models/User', () => ({
  findById: jest.fn(async (id) => ({ _id: id, role: id === 'admin-1' ? 'admin' : 'user' })),
  findOne: jest.fn(async () => null),
  updateOne: jest.fn(async () => ({})),
}));
jest.mock('../../../middleware/ipRateLimit', () => ({
  cloudflareIpRateLimitKeyGenerator: () => 'test-ip',
}));

const express = require('express');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const adminAgentAuthRoutes = require('../../../routes/admin/agentAuthRefusals');
const {
  AGENT_AUTH_REFUSAL_REASONS,
  recordAgentAuthRefusal,
  resetAgentAuthRefusalsForTest,
} = require('../../../services/agentAuthRefusals');

const SECRET = 'test-jwt-secret';
const sessionFor = (id) => jwt.sign({ id }, SECRET, { expiresIn: '1h' });

const buildApp = () => {
  const app = express();
  app.use('/api/admin/agent-auth', adminAgentAuthRoutes);
  return app;
};

describe('GET /api/admin/agent-auth/refusals (TASK-712)', () => {
  let savedSecret;
  let savedNodeEnv;

  beforeAll(() => {
    savedSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });
  afterAll(() => {
    process.env.JWT_SECRET = savedSecret;
  });
  beforeEach(() => {
    resetAgentAuthRefusalsForTest();
    savedNodeEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = savedNodeEnv;
  });

  test('an unauthenticated request is refused with 401', async () => {
    const res = await request(buildApp()).get('/api/admin/agent-auth/refusals');
    expect(res.status).toBe(401);
  });

  test('a session for an account that no longer exists is refused with 401', async () => {
    const res = await request(buildApp())
      .get('/api/admin/agent-auth/refusals')
      .set('Authorization', `Bearer ${sessionFor('deleted-1')}`);
    expect(res.status).toBe(401);
    expect(res.body.msg).toBe('Account no longer exists');
  });

  test('an authenticated non-admin is refused with 403', async () => {
    const res = await request(buildApp())
      .get('/api/admin/agent-auth/refusals')
      .set('Authorization', `Bearer ${sessionFor('user-1')}`);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe('Admin access required');
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
      .set('Authorization', `Bearer ${sessionFor('admin-1')}`);

    expect(res.status).toBe(200);
    expect(res.body.since).toEqual(expect.any(String));
    expect(Object.keys(res.body.counts).sort()).toEqual([...AGENT_AUTH_REFUSAL_REASONS].sort());
    expect(res.body.counts.invalid_token).toBe(2);
    expect(res.body.counts.missing_token).toBe(0);
  });

  // Keep this last: the limiter's store lives for the whole file, and the
  // other cases run with the limiter skipped under NODE_ENV=test.
  test('the limiter answers 429 after 60 requests in a window', async () => {
    process.env.NODE_ENV = 'production';
    const app = buildApp();
    let last;
    for (let i = 0; i < 61; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await request(app).get('/api/admin/agent-auth/refusals');
    }
    expect(last.status).toBe(429);
    expect(last.body).toEqual({ error: 'rate_limited' });
  });
});
