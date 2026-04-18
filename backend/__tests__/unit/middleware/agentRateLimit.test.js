// @ts-nocheck
// ADR-003 Phase 4: agentRateLimit middleware tests.
//
// Pure middleware unit tests — no DB, no HTTP server. We hand-build req/res
// objects and call the middleware directly so the per-token counter can be
// exercised in isolation from the auth middleware that normally precedes it.

const agentRateLimit = require('../../../middleware/agentRateLimit');
const { __resetAgentRateLimit } = require('../../../middleware/agentRateLimit');

const mkReq = (tokenHash) => ({
  headers: { authorization: `Bearer ${tokenHash}` },
  agentTokenHash: tokenHash,
  ip: '10.0.0.1',
});
const mkRes = () => {
  const headers = {};
  return {
    statusCode: 0,
    body: null,
    setHeader(k, v) { headers[k] = v; return this; },
    headers,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
};

beforeEach(() => __resetAgentRateLimit());

describe('agentRateLimit', () => {
  it('passes requests under the limit', () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 3 });
    const req = mkReq('alice-token');
    const res = mkRes();
    let nextCount = 0;
    const next = () => { nextCount += 1; };

    for (let i = 0; i < 3; i += 1) mw(req, res, next);
    expect(nextCount).toBe(3);
    expect(res.statusCode).toBe(0);
  });

  it('rejects the request that exceeds the window with 429 + Retry-After', () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 2 });
    const req = mkReq('alice-token');
    const res = mkRes();
    const next = jest.fn();

    mw(req, res, next);
    mw(req, res, next);
    mw(req, res, next); // third should reject

    expect(next).toHaveBeenCalledTimes(2);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('rate_limited');
    expect(res.body.retryAfter).toBeGreaterThan(0);
    expect(res.headers['Retry-After']).toBeDefined();
  });

  it('counts per-token (different tokens do not interfere)', () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 1 });
    const next = jest.fn();

    mw(mkReq('alice-token'), mkRes(), next);
    mw(mkReq('bob-token'), mkRes(), next);
    expect(next).toHaveBeenCalledTimes(2);
  });

  it('falls back to header-hash key when agentTokenHash absent', () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 1 });
    const next = jest.fn();
    const res = mkRes();

    // Same auth header, no req.agentTokenHash — should still rate-limit.
    const req1 = { headers: { authorization: 'Bearer raw-token' }, ip: '10.0.0.1' };
    const req2 = { headers: { authorization: 'Bearer raw-token' }, ip: '10.0.0.1' };
    mw(req1, mkRes(), next);
    mw(req2, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.statusCode).toBe(429);
  });

  it('resets after the window elapses (mocked clock)', () => {
    const realNow = Date.now;
    let now = 1_000_000;
    Date.now = () => now;
    try {
      const mw = agentRateLimit({ windowMs: 60_000, max: 1 });
      const req = mkReq('alice-token');
      const next = jest.fn();
      mw(req, mkRes(), next);
      mw(req, mkRes(), next); // rejects
      expect(next).toHaveBeenCalledTimes(1);

      now += 60_001;
      mw(req, mkRes(), next); // new window — should pass
      expect(next).toHaveBeenCalledTimes(2);
    } finally {
      Date.now = realNow;
    }
  });
});
