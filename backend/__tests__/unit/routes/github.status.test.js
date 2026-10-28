// GET /api/github/status answers "is the GitHub credential working?", not "is
// one set?". A dead PAT is a successful diagnosis: 200 with credentialLive
// false, never a 5xx that looks like our fault.

jest.mock('../../../middleware/agentRuntimeAuth', () => jest.fn((req, res, next) => next()));

// The role is switched per test, so the non-admin path can be exercised.
let mockRole = 'admin';
jest.mock('../../../middleware/auth', () => jest.fn((req, res, next) => {
  req.user = { _id: 'user-1', role: mockRole };
  req.userId = 'user-1';
  next();
}));

jest.mock('../../../services/githubAppService', () => ({
  isConfigured: jest.fn(),
  isPatConfigured: jest.fn(),
  checkPatLiveness: jest.fn(),
  generateAppJWT: jest.fn(),
}));

const express = require('express');
const request = require('supertest');
// eslint-disable-next-line import/no-unresolved, import/extensions
const GitHubAppService = require('../../../services/githubAppService');
// eslint-disable-next-line import/no-unresolved, import/extensions
const router = require('../../../routes/github');

const app = express();
app.use(express.json());
app.use('/api/github', router);

describe('GET /api/github/status', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRole = 'admin';
    GitHubAppService.isConfigured.mockReturnValue(false);
    GitHubAppService.isPatConfigured.mockReturnValue(true);
  });

  it('reports a PAT the upstream accepts as live', async () => {
    GitHubAppService.checkPatLiveness.mockResolvedValue({ live: true, status: 'accepted', upstreamStatus: 200 });
    const res = await request(app).get('/api/github/status');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      mode: 'pat', configured: true, credentialLive: true, credentialStatus: 'accepted', upstreamStatus: 200,
    });
  });

  it('reports a set but refused PAT as dead, with a 200 and no 5xx', async () => {
    GitHubAppService.checkPatLiveness.mockResolvedValue({ live: false, status: 'rejected', upstreamStatus: 401 });
    const res = await request(app).get('/api/github/status');
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(true);
    expect(res.body.credentialLive).toBe(false);
    expect(res.body.credentialStatus).toBe('rejected');
    expect(res.body.upstreamStatus).toBe(401);
  });

  it('reports unknown, not dead, when GitHub cannot be reached', async () => {
    GitHubAppService.checkPatLiveness.mockResolvedValue({ live: null, status: 'unreachable', upstreamStatus: 503 });
    const res = await request(app).get('/api/github/status');
    expect(res.status).toBe(200);
    expect(res.body.credentialLive).toBeNull();
    expect(res.body.credentialStatus).toBe('unreachable');
  });

  it('refuses a non-admin before any upstream probe runs', async () => {
    mockRole = 'user';
    GitHubAppService.checkPatLiveness.mockResolvedValue({ live: true, status: 'accepted', upstreamStatus: 200 });
    const res = await request(app).get('/api/github/status');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ message: 'Admin only' });
    expect(GitHubAppService.checkPatLiveness).not.toHaveBeenCalled();
  });

  it('keeps the mode none answer when nothing is configured, with no probe', async () => {
    GitHubAppService.isPatConfigured.mockReturnValue(false);
    const res = await request(app).get('/api/github/status');
    expect(res.body).toEqual({ mode: 'none', configured: false, message: 'Set GitHub App env vars' });
    expect(GitHubAppService.checkPatLiveness).not.toHaveBeenCalled();
  });
});
