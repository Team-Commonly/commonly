// @ts-nocheck
// ADR-003 Phase 4: agentRateLimit middleware tests.
//
// Behavior-focused tests against the express-rate-limit-backed middleware.
// No DB, no HTTP server — we hand-build req/res objects and call the
// middleware directly. Each test instantiates a fresh middleware so the
// internal MemoryStore is reset between cases.

const agentRateLimit = require('../../../middleware/agentRateLimit');

const mkReq = (tokenHash, extras = {}) => ({
  headers: { authorization: `Bearer ${tokenHash}` },
  agentTokenHash: tokenHash,
  ip: '10.0.0.1',
  // express-rate-limit expects an `app` reference and basic Express plumbing;
  // a stubbed app with the minimum surface keeps it happy in tests.
  app: { get: () => undefined },
  get(name) { return this.headers[name?.toLowerCase()]; },
  ...extras,
});

const mkRes = () => {
  const headers = {};
  return {
    statusCode: 0,
    body: null,
    headersSent: false,
    setHeader(k, v) { headers[k] = v; return this; },
    getHeader(k) { return headers[k]; },
    headers,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; },
    send(b) { this.body = b; this.headersSent = true; return this; },
    end(b) { this.body = b; this.headersSent = true; return this; },
  };
};

const callMw = (mw, req, res) => new Promise((resolve, reject) => {
  try {
    const result = mw(req, res, () => resolve('passed'));
    if (result && typeof result.then === 'function') {
      result.then(() => {
        if (!res.headersSent) resolve('passed');
        else resolve('rejected');
      }).catch(reject);
    } else if (res.headersSent) {
      resolve('rejected');
    }
  } catch (err) { reject(err); }
});

describe('agentRateLimit', () => {
  it('passes requests under the limit', async () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 3 });
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      results.push(await callMw(mw, mkReq('alice-token'), mkRes()));
    }
    expect(results).toEqual(['passed', 'passed', 'passed']);
  });

  it('rejects with 429 + code=rate_limited once the window cap is hit', async () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 2 });
    await callMw(mw, mkReq('alice-token'), mkRes());
    await callMw(mw, mkReq('alice-token'), mkRes());
    const res = mkRes();
    await callMw(mw, mkReq('alice-token'), res);
    expect(res.statusCode).toBe(429);
    expect(res.body.code).toBe('rate_limited');
  });

  it('counts per-token (different tokens get independent budgets)', async () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 1 });
    const aliceFirst = await callMw(mw, mkReq('alice-token'), mkRes());
    const bobFirst = await callMw(mw, mkReq('bob-token'), mkRes());
    expect(aliceFirst).toBe('passed');
    expect(bobFirst).toBe('passed');

    // Each token's SECOND request must reject — confirms per-token isolation.
    const aliceSecond = mkRes();
    const bobSecond = mkRes();
    await callMw(mw, mkReq('alice-token'), aliceSecond);
    await callMw(mw, mkReq('bob-token'), bobSecond);
    expect(aliceSecond.statusCode).toBe(429);
    expect(bobSecond.statusCode).toBe(429);
  });

  it('falls back to header-hash key when agentTokenHash is absent', async () => {
    const mw = agentRateLimit({ windowMs: 60_000, max: 1 });
    // Same Authorization header on both, no req.agentTokenHash — the fallback
    // hash must produce the same key, so the second request should reject.
    const reqA = {
      headers: { authorization: 'Bearer raw-token' },
      ip: '10.0.0.1',
      app: { get: () => undefined },
      get(name) { return this.headers[name?.toLowerCase()]; },
    };
    const reqB = { ...reqA };
    await callMw(mw, reqA, mkRes());
    const res = mkRes();
    await callMw(mw, reqB, res);
    expect(res.statusCode).toBe(429);
  });
});
