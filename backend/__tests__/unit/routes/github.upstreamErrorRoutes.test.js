/**
 * AX #9 maps GitHub's credential rejection to a non-retryable 502. The
 * mapper unit tests prove the taxonomy; these mount the real router so every
 * route that proxies GitHub is pinned to that taxonomy.
 *
 * Keep this explicit table when adding a GitHub proxy route. The request
 * shapes are intentionally visible here: deriving cases from `router.stack`
 * would hide the route-specific validation each request must pass before it
 * reaches the upstream service. The source-level check below counts every
 * handler that calls GitHubAppService, not merely every mapper call, so an
 * unmapped proxy route cannot make both sides of the assertion move together.
 * `/status` carries the single explicit exemption because it only reads local
 * configuration and signs locally; it must keep its honest local 500.
 */

let mockAgentInstallations = [];
let mockAgentUser = { _id: 'bot-1' };
jest.mock('../../../middleware/agentRuntimeAuth', () => (req, res, next) => {
  if (mockAgentUser) req.agentUser = mockAgentUser;
  req.agentInstallations = mockAgentInstallations;
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

const githubRouteHandlers = (source) => {
  const starts = [...source.matchAll(/router\.(?:get|post)\(/g)].map((match) => match.index);

  return starts.map((start, index) => {
    const handler = source.slice(start, starts[index + 1]);

    return {
      touchesGitHubService: handler.includes('GitHubAppService.'),
      mapsUpstreamError: handler.includes('mapGitHubUpstreamError('),
      upstreamExempt: handler.includes('@github-upstream-exempt'),
    };
  });
};

// Each row is a distinct route-level call site of mapGitHubUpstreamError.
// Adding another GitHub-proxy route means adding a row here with the smallest
// valid request that reaches its service boundary.
const PROXYING_ROUTE_CASES = [
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
];

// These three routes were removed because they lent our server-held GitHub
// credential to any caller holding an agent token. `/token` returned it
// outright; the two `/pulls` routes spent it on a caller-chosen `owner`/`repo`.
//
// The test is written against the mounted app rather than the source text on
// purpose: a source-level assertion ("the file no longer contains
// `/pulls/:number/review`") passes just as happily if the route moves to
// another router and stays reachable. What matters is that nothing answers
// these paths.
const REMOVED_CREDENTIAL_ROUTES = [
  { name: 'POST /token', send: (client) => client.post('/api/github/token') },
  { name: 'GET /pulls/:number/diff', send: (client) => client.get('/api/github/pulls/1/diff') },
  {
    name: 'POST /pulls/:number/review',
    send: (client) => client.post('/api/github/pulls/1/review').send({ event: 'APPROVE' }),
  },
];

describe('GitHub proxy routes preserve upstream credential guidance (AX #9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentInstallations = [];
    GitHubAppService.isPatConfigured.mockReturnValue(false);
    GitHubAppService.isConfigured.mockReturnValue(true);
  });

  it('maps every GitHub service handler unless it declares a local-only exemption', () => {
    const handlers = githubRouteHandlers(githubRouteSource);
    const githubServiceHandlers = handlers.filter((handler) => handler.touchesGitHubService);
    const exemptHandlers = githubServiceHandlers.filter((handler) => handler.upstreamExempt);
    const mappedHandlers = githubServiceHandlers.filter((handler) => handler.mapsUpstreamError);

    expect(exemptHandlers.every((handler) => !handler.mapsUpstreamError)).toBe(true);
    expect(githubServiceHandlers.length - exemptHandlers.length).toBe(mappedHandlers.length);
    expect(PROXYING_ROUTE_CASES).toHaveLength(mappedHandlers.length);
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

describe('GitHub issue write capability', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentUser = { _id: 'bot-1' };
    GitHubAppService.isPatConfigured.mockReturnValue(true);
    GitHubAppService.isConfigured.mockReturnValue(true);
  });

  test.each([
    ['/issues', { title: 'untrusted agent write' }, 'createIssue'],
    ['/issues/1/comment', { body: 'untrusted agent comment' }, 'addIssueComment'],
    ['/issues/1/close', {}, 'closeIssue'],
  ])('denies an ungranted agent token on POST %s', async (routePath, body, service) => {
    mockAgentInstallations = [{ githubIssueWrite: false }];

    const res = await request(app)
      .post(`/api/github${routePath}`)
      .set('Authorization', 'Bearer cm_agent_ungranted')
      .send(body);

    expect(res.status).toBe(403);
    expect(res.body).toEqual(expect.objectContaining({ code: 'github_issue_write_not_granted' }));
    expect(GitHubAppService[service]).not.toHaveBeenCalled();
  });

  test.each([
    ['/issues', { title: 'legacy agent write' }, 'createIssue'],
    ['/issues/1/comment', { body: 'legacy agent comment' }, 'addIssueComment'],
    ['/issues/1/close', {}, 'closeIssue'],
  ])(
    'denies an ungranted legacy token without an attached agent user on POST %s',
    async (routePath, body, service) => {
      mockAgentUser = undefined;
      mockAgentInstallations = [{ githubIssueWrite: false }];
      GitHubAppService[service].mockResolvedValue({});

      const res = await request(app)
        .post(`/api/github${routePath}`)
        .set('Authorization', 'Bearer cm_agent_legacy')
        .send(body);

      expect(res.status).toBe(403);
      expect(res.body).toEqual(expect.objectContaining({ code: 'github_issue_write_not_granted' }));
      expect(GitHubAppService[service]).not.toHaveBeenCalled();
    },
  );

  it('keeps issue reads open to the same ungranted agent token', async () => {
    mockAgentInstallations = [{ githubIssueWrite: false }];
    GitHubAppService.listOpenIssues.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/github/issues')
      .set('Authorization', 'Bearer cm_agent_ungranted');

    expect(res.status).toBe(200);
    expect(GitHubAppService.listOpenIssues).toHaveBeenCalledTimes(1);
  });

  it('allows a server-granted dev installation to create an issue', async () => {
    mockAgentInstallations = [{ githubIssueWrite: true }];
    GitHubAppService.createIssue.mockResolvedValue({ number: 7, title: 'dev write', html_url: 'url' });

    const res = await request(app)
      .post('/api/github/issues')
      .set('Authorization', 'Bearer cm_agent_dev')
      .send({ title: 'dev write' });

    expect(res.status).toBe(201);
    expect(GitHubAppService.createIssue).toHaveBeenCalledTimes(1);
  });

  it('keeps human issue writing unchanged', async () => {
    GitHubAppService.createIssue.mockResolvedValue({ number: 8, title: 'human write', html_url: 'url' });

    const res = await request(app)
      .post('/api/github/issues')
      .set('Authorization', 'Bearer human-jwt')
      .send({ title: 'human write' });

    expect(res.status).toBe(201);
    expect(GitHubAppService.createIssue).toHaveBeenCalledTimes(1);
  });
});

describe('routes that lent out the server GitHub credential stay removed', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // The strongest configuration for the defect: a PAT IS present, which is
    // exactly when `/token` used to answer with it in plaintext.
    GitHubAppService.isPatConfigured.mockReturnValue(true);
    GitHubAppService.isConfigured.mockReturnValue(true);
  });

  test.each(REMOVED_CREDENTIAL_ROUTES)('$name is not routable', async ({ send }) => {
    const res = await send(request(app));

    expect(res.status).toBe(404);
  });

  it('never reaches a GitHub service call for any of them', async () => {
    await Promise.all(REMOVED_CREDENTIAL_ROUTES.map(({ send }) => send(request(app))));

    // A 404 alone would also be satisfied by a route that answers 404 for its
    // own reasons while still touching the credential first. Assert the
    // credential is never read and no upstream call is made.
    expect(GitHubAppService.getInstallationToken).not.toHaveBeenCalled();
    expect(GitHubAppService.getPullDiff).not.toHaveBeenCalled();
    expect(GitHubAppService.createPullReview).not.toHaveBeenCalled();
  });

  it('pins issue routes to our own repository, ignoring a caller-supplied target', async () => {
    GitHubAppService.createIssue.mockResolvedValue({ number: 1, title: 't', html_url: 'u' });

    await request(app)
      .post('/api/github/issues')
      .send({ title: 't', owner: 'attacker', repo: 'private-repo' });

    expect(GitHubAppService.createIssue).toHaveBeenCalledWith(
      expect.objectContaining({ owner: 'Team-Commonly', repo: 'commonly' }),
    );
  });
});
