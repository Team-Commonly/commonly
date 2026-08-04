/**
 * AX #9 maps GitHub's credential rejection to a non-retryable 502. The
 * mapper unit tests prove the taxonomy; these mount the real router so every
 * route that proxies GitHub is pinned to that taxonomy.
 *
 * Keep this explicit table when adding a GitHub proxy route. The request
 * shapes are intentionally visible here: deriving cases from `router.stack`
 * would hide the route-specific validation each request must pass before it
 * reaches the upstream service. The call-site count below makes every new use
 * of the mapper add a row. A proxy route that bypasses the mapper altogether
 * remains a review concern. `/status` is excluded because it only reads local
 * configuration and signs locally; it must keep its honest local 500.
 */

jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  req.agentUser = { _id: 'bot-1' };
  next();
});

jest.mock('../../../middleware/auth', () => (req, res, next) => {
  req.user = { _id: 'user-1', role: 'member' };
  req.userId = 'user-1';
  next();
});

jest.mock('../../../services/githubAppService', () => ({
  isPatConfigured: jest.fn(),
  isConfigured: jest.fn(),
  getInstallationToken: jest.fn(),
  listOpenIssues: jest.fn(),
  createIssue: jest.fn(),
  addIssueComment: jest.fn(),
  closeIssue: jest.fn(),
  getPullDiff: jest.fn(),
  createPullReview: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');
// The backend source is TypeScript, while the legacy ESLint resolver only
// discovers JavaScript module extensions.
// eslint-disable-next-line import/no-unresolved, import/extensions
const GitHubAppService = require('../../../services/githubAppService');
// eslint-disable-next-line import/no-unresolved, import/extensions
const router = require('../../../routes/github');

const app = express();
app.use(express.json());
app.use('/api/github', router);

const credentialRejected = {
  message: 'Request failed with status code 401',
  response: { status: 401 },
};
const CREDENTIAL_REJECTION_TITLE = '$name maps an upstream 401 to non-retryable credential guidance';
const githubRouteSource = fs.readFileSync(path.join(__dirname, '../../../routes/github.ts'), 'utf8');

// Each row is a distinct route-level call site of mapGitHubUpstreamError.
// Adding another GitHub-proxy route means adding a row here with the smallest
// valid request that reaches its service boundary.
const PROXYING_ROUTE_CASES = [
  {
    name: 'POST /token',
    service: 'getInstallationToken',
    send: (client) => client.post('/api/github/token'),
    assertResponse: (res) => expect(res.body.message).toBe(res.body.error),
  },
  {
    name: 'GET /issues',
    service: 'listOpenIssues',
    send: (client) => client.get('/api/github/issues'),
  },
  {
    name: 'POST /issues',
    service: 'createIssue',
    send: (client) => client.post('/api/github/issues').send({ title: 'Test issue' }),
  },
  {
    name: 'POST /issues/:number/comment',
    service: 'addIssueComment',
    send: (client) => client.post('/api/github/issues/1/comment').send({ body: 'Test comment' }),
  },
  {
    name: 'POST /issues/:number/close',
    service: 'closeIssue',
    send: (client) => client.post('/api/github/issues/1/close'),
  },
  {
    name: 'GET /pulls/:number/diff',
    service: 'getPullDiff',
    send: (client) => client.get('/api/github/pulls/1/diff'),
  },
  {
    name: 'POST /pulls/:number/review',
    service: 'createPullReview',
    send: (client) => client.post('/api/github/pulls/1/review').send({ event: 'APPROVE' }),
  },
];

describe('GitHub proxy routes preserve upstream credential guidance (AX #9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    GitHubAppService.isPatConfigured.mockReturnValue(false);
    GitHubAppService.isConfigured.mockReturnValue(true);
  });

  it('keeps the visible request table aligned with every mapper call site', () => {
    const mapperCallSites = (githubRouteSource.match(/mapGitHubUpstreamError\(/g) || []).length - 1;

    expect(PROXYING_ROUTE_CASES).toHaveLength(mapperCallSites);
  });

  test.each(PROXYING_ROUTE_CASES)(CREDENTIAL_REJECTION_TITLE, async ({ service, send, assertResponse }) => {
    GitHubAppService[service].mockRejectedValue(credentialRejected);

    const res = await send(request(app));

    expect(GitHubAppService[service]).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(502);
    expect(res.body).toEqual(expect.objectContaining({
      code: 'github_credential_rejected',
      upstreamStatus: 401,
      retryable: false,
    }));
    if (assertResponse) assertResponse(res);
  });
});
