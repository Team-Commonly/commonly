// TASK-172 slice 3a: both public GETs on this route file are rate-limited.
//
// `routeRateLimitGuard` enforces that they carry a limiter, and it reads NAMES
// rather than behaviour — so it witnesses PRESENCE and nothing else. Four
// defects satisfy it exactly as well as the correct code does: a bound nobody
// chose, one limiter instance shared by two routes (which throttles the wrong
// caller), a bound tight enough to refuse a legitimate caller, and a refusal
// shaped for the wrong caller (both routes answer, but one answers a browser
// with JSON). Those are what this suite is for; the guard does its own job.
//
// No database is touched. The callback's cookie-presence check refuses before
// any row read, so a request here is a cheap refusal — and every request shares
// one rate-limit key, because they all arrive from the same test client, which
// is what makes a bound reachable in a loop at all.
//
// The two refusal arms are the discriminating part: a throttled callback and an
// unthrottled one are BOTH redirects, so the status alone cannot tell them apart.
// The `code` in the Location is what separates `invalid_state` from
// `rate_limited`, and it is asserted on both sides of the bound.
const FIXTURE_ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: { page: 'https://linear.app/settings/security' },
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
    // The callback copies this off the entry onto the row, so the partial mock
    // has to carry it: an unforwarded accessor reads as `undefined` and throws
    // at the write rather than at the import.
    hostedMcpRevokeTarget: actual.hostedMcpRevokeTarget,
  };
});

jest.mock('../../../middleware/auth', () => (req, _res, next) => {
  req.user = { id: 'user-1' };
  next();
});

jest.mock('../../../models/Integration', () => ({ findOneAndUpdate: jest.fn() }));

const request = require('supertest');
const express = require('express');

const connectRoutes = require('../../../routes/hostedMcpConnect');

const app = express();
app.use('/connect/hosted-mcp', connectRoutes);

// `state` and `code` are supplied so the refusal under test is the browser
// nonce's — the missing cookie — rather than the earlier missing-parameter one.
const CALLBACK = '/connect/hosted-mcp/linear/callback?state=s&code=c';
const METADATA = '/connect/hosted-mcp/linear/client-metadata';

// Deliberately literals, one over the bound stated in the route file: a suite
// that reads the number it is testing cannot tell a chosen bound from a changed
// one. `CALLBACK_BOUND` is the callback's own bound; `METADATA_REQUESTS` is
// above it and below the document's, which is the asymmetry being asserted.
const CALLBACK_BOUND = 60;
const METADATA_REQUESTS = 61;
// One past the document's bound with room to spare, since this arm has to work
// whether or not an earlier arm in the file has already spent part of its bucket.
const METADATA_EXHAUST_LIMIT = 700;

const call = (path) => request(app).get(path);

const exhaustCallback = async () => {
  const within = [];
  for (let i = 0; i < CALLBACK_BOUND; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    within.push(await call(CALLBACK));
  }
  return within;
};

describe('the two public hosted-MCP GETs are armed, not merely wired', () => {
  test('the callback answers every request up to its bound, then refuses with a redirect', async () => {
    const within = await exhaustCallback();
    // Up to the bound, every request is the handler's own refusal — a redirect
    // carrying `invalid_state` — and never the limiter's. A bound that began
    // refusing early would otherwise read as a passing loop.
    expect(new Set(within.map((r) => r.status))).toEqual(new Set([302]));
    expect(within.every((r) => r.headers.location.includes('code=invalid_state'))).toBe(true);

    const over = await call(CALLBACK);
    // A throttled browser lands on the page, with a code it can speak to. Raw
    // JSON here would be the one outcome on this route a person cannot act on —
    // and the person who least knows why. Status alone is not the assertion:
    // both sides of the bound are 302.
    expect(over.status).toBe(302);
    expect(over.headers.location).toContain('hostedMcp=error');
    expect(over.headers.location).toContain('code=rate_limited');
    expect(over.headers['content-type']).not.toContain('json');
  });

  test('the metadata document is still served after the callback bucket is spent', async () => {
    // Spent inside this arm rather than inherited from the one above, so a
    // focused run of this test alone is still a real measurement.
    await exhaustCallback();
    const spent = await call(CALLBACK);
    expect(spent.headers.location).toContain('code=rate_limited');

    const statuses = [];
    for (let i = 0; i < METADATA_REQUESTS; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      statuses.push((await call(METADATA)).status);
    }
    // Two claims in one set: the document is not held to the callback's bound
    // (61 requests all answered), and the two routes do not share a bucket — the
    // second would fail here with the callback's bucket already spent, while
    // satisfying the name-reading guard perfectly.
    expect(new Set(statuses)).toEqual(new Set([200]));
  });

  test('the metadata route refuses its own caller in the shape that caller can read', async () => {
    // The document's caller is the authorization server, so its refusal stays
    // JSON — the fix for the callback must not travel to this route. Loop until
    // the bound is reached rather than counting to it, so the arm is a real
    // measurement whether it runs alone or after the arms above.
    let refusal = null;
    for (let i = 0; i < METADATA_EXHAUST_LIMIT && !refusal; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const res = await call(METADATA);
      if (res.status !== 200) refusal = res;
    }
    expect(refusal).not.toBeNull();
    expect(refusal.status).toBe(429);
    expect(refusal.body.msg).toContain('rate limit exceeded');
    expect(refusal.headers.location).toBeUndefined();
  });
});
