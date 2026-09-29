// TASK-172 slice 3a: both public GETs on this route file are rate-limited.
//
// `routeRateLimitGuard` enforces that they carry a limiter, and it reads NAMES
// rather than behaviour — so it witnesses PRESENCE and nothing else. Three
// defects satisfy it exactly as well as the correct code does: a bound nobody
// chose, one limiter instance shared by two routes (which throttles the wrong
// caller and is invisible in the registration), and a limiter tight enough to
// refuse a legitimate caller. Those are what this suite is for; the guard is
// left to do its own job.
//
// No database is touched. The callback's cookie-presence check refuses before
// any row read, so a request here is a cheap refusal — and every request shares
// one rate-limit key, because they all arrive from the same test client, which
// is what makes a bound reachable in a loop at all.
const FIXTURE_ENTRY = {
  id: 'linear',
  title: 'Linear',
  resource: 'https://mcp.linear.app/mcp',
  issuer: 'https://mcp.linear.app',
  client: 'cimd',
  scopes: ['read', 'openid'],
  revoke: 'https://mcp.linear.app/token',
  tools: [],
};

jest.mock('../../../integrations/hostedMcp/entries', () => {
  const actual = jest.requireActual('../../../integrations/hostedMcp/entries');
  return {
    HOSTED_MCP_ENTRIES: [FIXTURE_ENTRY],
    findHostedMcpEntry: actual.findHostedMcpEntry,
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

const call = (path) => request(app).get(path);

const exhaustCallback = async () => {
  const within = [];
  for (let i = 0; i < CALLBACK_BOUND; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    within.push((await call(CALLBACK)).status);
  }
  return within;
};

describe('the two public hosted-MCP GETs are armed, not merely wired', () => {
  test('the callback answers every request up to its bound, then refuses with 429', async () => {
    const within = await exhaustCallback();
    // Every one of the 60 is the handler's own refusal — a redirect carrying
    // `invalid_state` — never a limiter's 429. A bound that began refusing early
    // would otherwise read as a passing loop.
    expect(new Set(within)).toEqual(new Set([302]));

    const over = await call(CALLBACK);
    expect(over.status).toBe(429);
    expect(over.body.msg).toContain('rate limit exceeded');
  });

  test('the metadata document is still served after the callback bucket is spent', async () => {
    // Spent inside this arm rather than inherited from the one above, so a
    // focused run of this test alone is still a real measurement.
    await exhaustCallback();
    expect((await call(CALLBACK)).status).toBe(429);

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
});
