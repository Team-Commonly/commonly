// TASK-125 — the module-level witness for `middleware/integrationRateLimit.ts`.
//
// Every route suite that touches these limiters stubs them to a pass-through
// (`discordBindingContainment`, `installables`, `slackOAuth.installables`,
// `integrations.routingState`, `integrations.linkedUserId`), and
// `routeRateLimitGuard` pins only the mount order — so nothing showed either
// limiter COUNTING. This file loads the real module and drives it.
//
// WHAT IT WITNESSES. The write budget is a count: 30 succeed in the window and
// the 31st is refused with the limiter's own body. Two presented bearer tokens
// are two buckets. And the no-header branch buckets by the Cloudflare-recorded
// address, so two requests differing only in `req.ip` share a bucket while two
// differing only in `cf-connecting-ip` do not.
//
// WHAT IT DOES NOT WITNESS, stated rather than implied. A key is chosen before
// any route's auth check runs, so these buckets are per PRESENTED credential or
// address — not per caller, and not a boundary against a caller who rotates
// either one. The other `ipKeyGenerator(req.ip)` fallbacks elsewhere in
// backend/ are TASK-126 and are deliberately not asserted here.
//
// The counts and the 429 body are restated from the module rather than derived
// (30 writes/60s). A change to either reddens the assertion below, which is the
// tripwire; the coupling is named in the comment at the constant.
const express = require('express');
const request = require('supertest');

const {
  writeIntegrationsRateLimit,
  integrationsRateLimitKey,
} = require('../../../middleware/integrationRateLimit');

const WRITE_BUDGET = 30;
const WRITE_MSG = 'rate limit exceeded: 30 writes per 60s';

const app = express();
app.use(express.json());
app.post('/write', writeIntegrationsRateLimit, (req, res) => res.status(200).json({ ok: true }));

// Sequential on purpose: express-rate-limit counts on arrival, so a concurrent
// burst would decide the last status by timing rather than by order. Each test
// uses its own bucket, because the limiter is module-level and its store
// persists across tests in this file.
const flood = (remaining, headers, seen) => {
  if (remaining === 0) return Promise.resolve(seen);
  return request(app)
    .post('/write')
    .set(headers)
    .then((res) => flood(remaining - 1, headers, seen.concat({
      status: res.status,
      msg: res.body && res.body.msg,
    })));
};

const token = (name) => ({ authorization: `Bearer ${name}` });

describe('the connector write limiter counts and buckets (TASK-125)', () => {
  it('refuses the 31st write in the window, with its own body, after 30 successes', async () => {
    const seen = await flood(WRITE_BUDGET + 1, token('t125-budget'), []);

    expect(seen).toHaveLength(WRITE_BUDGET + 1);
    expect(seen.slice(0, WRITE_BUDGET).every((entry) => entry.status === 200)).toBe(true);
    expect(seen[WRITE_BUDGET].status).toBe(429);
    // Identified as THIS limiter, not a blanket refusal: the body is its own.
    expect(seen[WRITE_BUDGET].msg).toBe(WRITE_MSG);
  });

  it('gives two presented bearer tokens separate buckets', async () => {
    const exhausted = await flood(WRITE_BUDGET + 1, token('t125-token-a'), []);
    expect(exhausted[WRITE_BUDGET].status).toBe(429);

    // A different credential is a different bucket, so the budget the first one
    // spent does not refuse this one.
    const fresh = await request(app).post('/write').set(token('t125-token-b'));
    expect(fresh.status).toBe(200);
  });

  it('buckets the no-header branch by cf-connecting-ip, not by the proxy address', async () => {
    const exhausted = await flood(WRITE_BUDGET + 1, { 'cf-connecting-ip': '198.51.100.1' }, []);
    expect(exhausted.slice(0, WRITE_BUDGET).every((entry) => entry.status === 200)).toBe(true);
    expect(exhausted[WRITE_BUDGET].status).toBe(429);

    // Under a `req.ip`-only fallback this is the SAME bucket as the flood above
    // (supertest gives every request here one loopback address), so it would be
    // 429 rather than 200.
    const other = await request(app).post('/write').set({ 'cf-connecting-ip': '198.51.100.2' });
    expect(other.status).toBe(200);
  });

  it('shares a single bucket for one cf-connecting-ip value', async () => {
    const seen = await flood(WRITE_BUDGET + 1, { 'cf-connecting-ip': '198.51.100.3' }, []);
    expect(seen[WRITE_BUDGET - 1].status).toBe(200);
    expect(seen[WRITE_BUDGET].status).toBe(429);
  });
});

describe('integrationsRateLimitKey', () => {
  it('reads cf-connecting-ip before req.ip, so the proxy address cannot decide the bucket', () => {
    const withCf = (cf, ip) => ({ headers: { 'cf-connecting-ip': cf }, ip });

    // One edge address, two `req.ip` values (the two cloudflared pods): one bucket.
    expect(integrationsRateLimitKey(withCf('203.0.113.7', '10.0.0.1')))
      .toBe(integrationsRateLimitKey(withCf('203.0.113.7', '10.0.0.2')));
    // Two edge addresses, one `req.ip`: two buckets. Under the previous
    // `req.ip`-only fallback both of these assertions invert.
    expect(integrationsRateLimitKey(withCf('203.0.113.7', '10.0.0.1')))
      .not.toBe(integrationsRateLimitKey(withCf('203.0.113.8', '10.0.0.1')));
  });

  it('still buckets a presented Authorization header by that header', () => {
    const withToken = (value, ip) => ({ get: () => value, ip });

    expect(integrationsRateLimitKey(withToken('Bearer one', '10.0.0.1')))
      .toBe(integrationsRateLimitKey(withToken('Bearer one', '10.0.0.2')));
    expect(integrationsRateLimitKey(withToken('Bearer one', '10.0.0.1')))
      .not.toBe(integrationsRateLimitKey(withToken('Bearer two', '10.0.0.1')));
    expect(integrationsRateLimitKey(withToken('Bearer one', '10.0.0.1'))).toMatch(/^tok:/);
  });
});
