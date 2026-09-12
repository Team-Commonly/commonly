/**
 * phase4RateLimit is a two-tier stack, IP first (B3 first shrink, #1689).
 *
 * Pre-auth the per-token tier keys on a sha256 of the Authorization header,
 * so a caller who rotates the header gets a fresh bucket every request —
 * Vera measured 300 rotating headers reaching auth 300 times on the
 * single-tier version. The coarse per-IP tier ahead of it (Cloudflare-aware
 * key, 3000/60s) is what bounds the Mongo lookup in agentRuntimeAuth against
 * that rotation. These tests drive the REAL router with auth mocked to a
 * counter, so they measure the registered stack, not a copy of it.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn(), verify: jest.fn(), decode: jest.fn() }));

const authReached = { count: 0 };
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res) => {
  authReached.count += 1;
  res.status(401).json({ message: 'stop here' });
});
jest.mock('../../../middleware/auth', () => (req, res, next) => next());
jest.mock('../../../middleware/apiTokenScopes', () => ({
  requireApiTokenScopes: () => (req, res, next) => next(),
}));
jest.mock('../../../services/agentEventService', () => ({}));
jest.mock('../../../services/agentIdentityService', () => ({
  DM_POD_TYPES_GUARD: ['agent-room', 'agent-dm'],
  buildAgentUsername: jest.fn((a) => a),
}));
jest.mock('../../../services/agentMessageService', () => ({}));
jest.mock('../../../services/agentThreadService', () => ({}));
jest.mock('../../../services/podContextService', () => ({}));
jest.mock('../../../services/globalModelConfigService', () => ({}));
jest.mock('../../../services/socialPolicyService', () => ({}));
jest.mock('../../../integrations', () => ({ get: jest.fn() }));
jest.mock('../../../models/Activity', () => ({}));
jest.mock('../../../models/User', () => ({ find: jest.fn(), findById: jest.fn() }));
jest.mock('../../../models/Post', () => ({ findById: jest.fn() }));
jest.mock('../../../models/Pod', () => ({ find: jest.fn() }));
jest.mock('../../../services/dmService', () => ({ getOrCreateAgentDM: jest.fn() }));
jest.mock('../../../models/Integration', () => ({ find: jest.fn(), findOne: jest.fn() }));
jest.mock('../../../models/AgentRegistry', () => ({
  AgentInstallation: { findOne: jest.fn(), find: jest.fn() },
}));
jest.mock('../../../services/chatSummarizerService', () => ({
  getMultiplePodSummaries: jest.fn().mockResolvedValue({}),
}));

const express = require('express');
const request = require('supertest');
const router = require('../../../routes/agentsRuntime');

const app = express();
app.use(express.json());
app.use('/api/agents/runtime', router);

// One of the 11 registrations this shrink moved ahead of auth.
const ROUTE = '/api/agents/runtime/messages/m1/claim';

const hit = (ip, authorization) => request(app)
  .post(ROUTE)
  .set('cf-connecting-ip', ip)
  .set('Authorization', authorization);

describe('phase4RateLimit tiers (IP first, then per-token)', () => {
  beforeEach(() => { authReached.count = 0; });

  test('a fixed header hits the per-token tier: 120 reach auth, the rest 429', async () => {
    const statuses = [];
    for (let i = 0; i < 300; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await hit('198.51.100.1', 'Bearer fixed-token');
      statuses.push(res.status);
    }
    expect(authReached.count).toBe(120);
    expect(statuses.filter((s) => s === 401)).toHaveLength(120);
    expect(statuses.filter((s) => s === 429)).toHaveLength(180);
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
  }, 30_000);

  test('rotating headers from one IP stop at the IP tier: 3000 reach auth, the 3001st is 429', async () => {
    let last;
    for (let i = 0; i < 3001; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      last = await hit('198.51.100.2', `Bearer rotating-${i}`);
      if (i < 3000) expect(last.status).toBe(401);
    }
    expect(last.status).toBe(429);
    expect(last.body.code).toBe('rate_limited');
    expect(authReached.count).toBe(3000);
  }, 120_000);

  test('the IP tier is keyed by cf-connecting-ip, so another IP is a fresh bucket', async () => {
    const res = await hit('198.51.100.3', 'Bearer rotating-anywhere');
    expect(res.status).toBe(401);
    expect(authReached.count).toBe(1);
  });
});
