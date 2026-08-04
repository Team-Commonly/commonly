/**
 * `GET /api/github/status` is the endpoint whose only job is to diagnose the
 * GitHub credential. Until this change it answered `configured: true` off
 * `!!process.env.GITHUB_PAT` — presence, not liveness — which is why it read
 * `configured: true` for the whole 2026-08-04 outage while every proxied call
 * returned 401.
 *
 * Two invariants are pinned here, and the second is the one most likely to be
 * "cleaned up" later:
 *
 *  1. A dead credential is reported as `credentialLive: false`.
 *  2. A dead credential is still an HTTP **200**. This route must NOT adopt
 *     mapGitHubUpstreamError. If the diagnostic returned 502 on a rejected
 *     credential, a caller could not tell "the credential is dead" from "the
 *     diagnostic is broken" — the exact collapse #808 removed from the seven
 *     proxying routes, reintroduced at the one endpoint that exists to
 *     prevent it.
 *
 * Unreachable is a third answer, not a synonym for dead: reporting `false`
 * when GitHub could not be reached would send an operator to rotate a working
 * credential.
 */

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  next();
});

let mockCurrentUser = { _id: 'user-1', role: 'admin' };
jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = mockCurrentUser;
  req.userId = mockCurrentUser._id;
  next();
});

jest.mock('axios');

const express = require('express');
const request = require('supertest');
const axios = require('axios');
// eslint-disable-next-line import/no-unresolved, import/extensions
const router = require('../../../routes/github');

const app = express();
app.use(express.json());
app.use('/api/github', router);

const upstream = (status) => Object.assign(new Error(`Request failed with status code ${status}`), {
  response: { status },
});

describe('GET /status reports credential liveness, not just presence', () => {
  const priorPat = process.env.GITHUB_PAT;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GITHUB_PAT = 'ghp_test_token';
    mockCurrentUser = { _id: 'user-1', role: 'admin' };
  });

  afterAll(() => {
    if (priorPat === undefined) delete process.env.GITHUB_PAT;
    else process.env.GITHUB_PAT = priorPat;
  });

  it('reports a working credential as live', async () => {
    axios.get.mockResolvedValue({ data: { rate: { remaining: 4999 } } });

    const res = await request(app).get('/api/github/status');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'pat',
      configured: true,
      credentialLive: true,
      credentialStatus: 'accepted',
    });
  });

  it('probes /rate_limit, which GitHub does not charge against quota', async () => {
    axios.get.mockResolvedValue({ data: {} });

    await request(app).get('/api/github/status');

    expect(axios.get).toHaveBeenCalledTimes(1);
    expect(axios.get.mock.calls[0][0]).toBe('https://api.github.com/rate_limit');
  });

  it('reports a rejected credential as NOT live while still answering 200', async () => {
    axios.get.mockRejectedValue(upstream(401));

    const res = await request(app).get('/api/github/status');

    // The whole finding: `configured: true` alone said everything was fine.
    expect(res.body.configured).toBe(true);
    expect(res.body.credentialLive).toBe(false);
    expect(res.body.credentialStatus).toBe('rejected');
    expect(res.body.upstreamStatus).toBe(401);
    // Load-bearing: a diagnostic must not express its finding as its own
    // failure status. 502 here would be indistinguishable from a broken
    // diagnostic.
    expect(res.status).toBe(200);
  });

  it('treats a 403 credential rejection the same way', async () => {
    axios.get.mockRejectedValue(upstream(403));

    const res = await request(app).get('/api/github/status');

    expect(res.status).toBe(200);
    expect(res.body.credentialLive).toBe(false);
    expect(res.body.upstreamStatus).toBe(403);
  });

  it('reports unreachable as unknown, never as dead', async () => {
    axios.get.mockRejectedValue(Object.assign(new Error('connect ETIMEDOUT'), {}));

    const res = await request(app).get('/api/github/status');

    expect(res.status).toBe(200);
    // null, not false — `false` would send an operator to rotate a credential
    // that may be perfectly good.
    expect(res.body.credentialLive).toBeNull();
    expect(res.body.credentialStatus).toBe('unreachable');
  });

  it('still refuses non-admins before probing anything', async () => {
    mockCurrentUser = { _id: 'user-2', role: 'member' };

    const res = await request(app).get('/api/github/status');

    expect(res.status).toBe(403);
    expect(axios.get).not.toHaveBeenCalled();
  });
});
