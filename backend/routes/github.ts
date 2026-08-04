// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const rateLimit = require('express-rate-limit');
// eslint-disable-next-line global-require
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const GitHubAppService = require('../services/githubAppService');

interface AuthReq {
  user?: { role?: string };
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  params?: Record<string, string>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;
const VALID_REVIEW_EVENTS = ['APPROVE', 'REQUEST_CHANGES', 'COMMENT'];

// Per-route limiter on the PR endpoints — they proxy to the GitHub API (which
// has its own abuse limits on our shared PAT), so bound callers here. Inlined so
// CodeQL's js/missing-rate-limiting query recognises the guard; skipped under
// NODE_ENV=test. Mirrors installRateLimit (routes/registry/install.ts).
const githubPrRateLimit = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => process.env.NODE_ENV === 'test',
  handler: (_req: unknown, res: Res) => res.status(429).json({
    message: 'rate limit exceeded: 30 GitHub PR requests per 60s',
    code: 'rate_limited',
  }),
});

// AX audit #9. Every route below proxies GitHub, and every failure — including
// GitHub rejecting OUR credential — was collapsed into a 500 whose only true
// signal lived in a human-readable `detail` string. The two codes carry
// opposite instructions: 500 means *the server failed, retry*, while an
// upstream 401 means *stop, the credential is wrong, retrying changes
// nothing*. A caller that reads the status and does the right thing by it
// retries forever against a fault no retry resolves.
//
// So: map the upstream status into the same class, and put the instruction in
// a machine-readable field (`retryable`) rather than in prose. The status
// stays 502 for a credential rejection rather than passing 401 through,
// because the CALLER's auth is fine — it is our server credential GitHub
// refused, and a bare 401 would just relocate the false model onto the
// caller's own token. `code` + `upstreamStatus` say which of the two it is.
// NOTE: deliberately not `export function`. This file ends in
// `module.exports = router`, which replaces the exports object wholesale — a
// TS named export would compile to `exports.x = …` and then be silently
// discarded. It is re-attached to the router below instead, which is the
// shape that actually survives.
function mapGitHubUpstreamError(
  err: unknown,
  labels: { fallback: string; notFound: string },
): { status: number; body: Record<string, unknown> } {
  const e = err as {
    response?: { status?: number; headers?: Record<string, string> };
    message?: string;
  };
  const upstreamStatus = e.response?.status;
  const detail = e.message;

  if (upstreamStatus === 404) {
    return { status: 404, body: { error: labels.notFound, code: 'github_not_found', retryable: false } };
  }

  // GitHub signals rate limiting as 429, or as 403 with the remaining budget
  // at zero. Both are retryable — but only after a wait, so say so.
  const remaining = e.response?.headers?.['x-ratelimit-remaining'];
  if (upstreamStatus === 429 || (upstreamStatus === 403 && remaining === '0')) {
    return {
      status: 429,
      body: {
        error: 'GitHub rate limit exceeded', code: 'github_rate_limited', upstreamStatus, retryable: true, detail,
      },
    };
  }

  if (upstreamStatus === 401 || upstreamStatus === 403) {
    return {
      status: 502,
      body: {
        error: 'GitHub rejected the server credential — this is not your token, and retrying will not fix it',
        code: 'github_credential_rejected',
        upstreamStatus,
        retryable: false,
        detail,
      },
    };
  }

  if (typeof upstreamStatus === 'number' && upstreamStatus >= 500) {
    return {
      status: 502,
      body: {
        error: 'GitHub is failing upstream', code: 'github_upstream_error', upstreamStatus, retryable: true, detail,
      },
    };
  }

  // No upstream response at all: our own bug, our own 500. This is the only
  // branch where 500 is the honest answer.
  return { status: 500, body: { error: labels.fallback, code: 'github_proxy_error', retryable: false, detail } };
}

function anyAuth(req: AuthReq, res: Res, next: () => void) {
  const token = ((req.header?.('Authorization') || '').replace('Bearer ', ''));
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
}

const router: ReturnType<typeof express.Router> = express.Router();

router.post('/token', agentRuntimeAuth, async (req: AuthReq, res: Res) => {
  try {
    if (GitHubAppService.isPatConfigured()) return res.json(GitHubAppService.getPatToken());

    if (!GitHubAppService.isConfigured()) {
      return res.status(503).json({ message: 'No GitHub credentials configured. Set GITHUB_PAT or GitHub App env vars.' });
    }

    const { owner = 'Team-Commonly', repo = 'commonly' } = (req.body || {}) as { owner?: string; repo?: string };
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) {
      return res.status(400).json({ message: 'Invalid owner or repo name' });
    }

    let installationId = process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY;
    if (owner !== 'Team-Commonly' || repo !== 'commonly') {
      installationId = await GitHubAppService.getInstallationIdForRepo(owner, repo);
    }

    const result = await GitHubAppService.getInstallationToken(installationId);
    return res.json(result);
  } catch (err) {
    // The seventh proxying route, and the one where the flattening bit
    // hardest (@ux-lead, msg 52276): this endpoint's entire job is
    // credentials, so the caller most likely to hit an upstream 401 here is
    // someone ALREADY debugging a credential failure — and a 500 tells them to
    // retry. `getInstallationIdForRepo` and `getInstallationToken` both call
    // GitHub, so the same mapping applies.
    const mapped = mapGitHubUpstreamError(err, {
      fallback: 'Failed to generate GitHub token',
      notFound: 'GitHub App not installed on this repository',
    });
    // `message` is kept alongside the mapped body: this route has always
    // answered with `message`, and CLI/driver callers read it. Additive, so
    // nothing that parses the old shape breaks.
    console.error('POST /github/token error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json({ ...mapped.body, message: mapped.body.error });
  }
});

// Deliberately NOT mapped, and this is the ONE route where that is a hard rule
// rather than an observation. The mapper turns an upstream 401 into a 502; a
// diagnostic that does the same makes "the credential is dead" and "the
// diagnostic is broken" the same response — reintroducing, at the single
// endpoint whose job is to prevent it, exactly the collapse the mapper exists
// to eliminate. A diagnostic must never express its finding as its own failure
// status: a dead credential is a successful diagnosis. So this route answers
// 200 with `credentialLive: false` and keeps its local-fault 500 for genuine
// local faults only. (@ux-lead, msg 52286.)
//
// `configured` answers "is a credential present", which is what the four
// proxying gates need. It answered `true` all through the 2026-08-04 outage
// while every call 401'd — presence read as health, and it fails in the
// direction that ends the search: three seats were blocked, one concluded the
// fault was its own seat (msg 52256), and this endpoint would have agreed.
// `credentialLive` is the separate question, from the separate predicate.
router.get('/status', auth, async (req: AuthReq, res: Res) => {
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
    if (GitHubAppService.isPatConfigured()) {
      const liveness = await GitHubAppService.checkPatLiveness();
      return res.json({
        mode: 'pat',
        configured: true,
        credentialLive: liveness.live,
        credentialStatus: liveness.status,
        ...(liveness.upstreamStatus ? { upstreamStatus: liveness.upstreamStatus } : {}),
        ...(liveness.detail ? { detail: liveness.detail } : {}),
      });
    }
    if (!GitHubAppService.isConfigured()) return res.json({ mode: 'none', configured: false, message: 'Set GITHUB_PAT or GitHub App env vars' });
    const appJWT = GitHubAppService.generateAppJWT();
    return res.json({ mode: 'app', configured: true, appId: process.env.GITHUB_APP_ID, installationId: process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY, jwtGenerated: !!appJWT });
  } catch (err) {
    const e = err as { message?: string };
    return res.status(500).json({ configured: false, error: e.message });
  }
});

router.get('/issues', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const { owner = 'Team-Commonly', repo = 'commonly', per_page } = (req.query || {}) as { owner?: string; repo?: string; per_page?: string };
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) return res.status(400).json({ error: 'Invalid owner or repo' });
    const issues = await GitHubAppService.listOpenIssues({ owner, repo, perPage: Number(per_page) || 20 });
    return res.json({ issues: issues.map((i: { number: number; title: string; body: string; html_url: string; labels?: Array<{ name: string }>; milestone?: { title?: string } }) => ({ number: i.number, title: i.title, body: i.body, url: i.html_url, labels: i.labels?.map((l) => l.name), milestone: i.milestone?.title || null })) });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to list issues', notFound: 'Repository not found' });
    console.error('GET /github/issues error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/issues', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const { title, body, labels, owner = 'Team-Commonly', repo = 'commonly' } = (req.body || {}) as { title?: string; body?: string; labels?: string[]; owner?: string; repo?: string };
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) return res.status(400).json({ error: 'Invalid owner or repo' });
    const issue = await GitHubAppService.createIssue({ owner, repo, title, body, labels });
    return res.status(201).json({ number: issue.number, title: issue.title, url: issue.html_url });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to create issue', notFound: 'Repository not found' });
    console.error('POST /github/issues error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/issues/:number/comment', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    const issueNumber = Number(req.params?.number);
    const { body, owner = 'Team-Commonly', repo = 'commonly' } = (req.body || {}) as { body?: string; owner?: string; repo?: string };
    if (!body) return res.status(400).json({ error: 'body is required' });
    await GitHubAppService.addIssueComment({ owner, repo, issueNumber, body });
    return res.json({ ok: true });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to comment', notFound: 'Issue not found' });
    console.error('POST /github/issues/comment error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/issues/:number/close', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    const issueNumber = Number(req.params?.number);
    const { comment, owner = 'Team-Commonly', repo = 'commonly' } = (req.body || {}) as { comment?: string; owner?: string; repo?: string };
    await GitHubAppService.closeIssue({ owner, repo, issueNumber, comment });
    return res.json({ ok: true, closed: issueNumber });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to close issue', notFound: 'Issue not found' });
    console.error('POST /github/issues/close error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

// ─── Pull Requests ───────────────────────────────────────────────────────

router.get('/pulls/:number/diff', githubPrRateLimit, anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const pullNumber = Number(req.params?.number);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return res.status(400).json({ error: 'Invalid pull number' });
    const { owner = 'Team-Commonly', repo = 'commonly' } = (req.query || {}) as { owner?: string; repo?: string };
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) return res.status(400).json({ error: 'Invalid owner or repo' });
    const diff = await GitHubAppService.getPullDiff({ owner, repo, pullNumber });
    return res.json({ number: pullNumber, diff });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to fetch pull diff', notFound: 'Pull request not found' });
    console.error('GET /github/pulls/diff error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/pulls/:number/review', githubPrRateLimit, anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const pullNumber = Number(req.params?.number);
    if (!Number.isInteger(pullNumber) || pullNumber <= 0) return res.status(400).json({ error: 'Invalid pull number' });
    const { event, body, owner = 'Team-Commonly', repo = 'commonly' } = (req.body || {}) as { event?: string; body?: string; owner?: string; repo?: string };
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) return res.status(400).json({ error: 'Invalid owner or repo' });
    if (!event || !VALID_REVIEW_EVENTS.includes(event)) return res.status(400).json({ error: 'event must be one of APPROVE, REQUEST_CHANGES, COMMENT' });
    if (event !== 'APPROVE' && !body) return res.status(400).json({ error: 'body is required for REQUEST_CHANGES and COMMENT reviews' });
    const review = await GitHubAppService.createPullReview({ owner, repo, pullNumber, event: event as 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT', body });
    const r = review as { id?: number; state?: string; html_url?: string };
    return res.status(201).json({ ok: true, id: r?.id, state: r?.state, url: r?.html_url });
  } catch (err) {
    // AX #9 left this one explicitly unverified — "whether commonly_pr_review
    // shares the same broken credential; assume it does until someone checks."
    // It does: both routes go through GitHubAppService._apiHeaders and the same
    // GITHUB_PAT, so a rejected credential fails the write path identically.
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to submit review', notFound: 'Pull request not found' });
    console.error('POST /github/pulls/review error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

module.exports = router;
// Exposed for unit tests: the mapping is the load-bearing part, and testing it
// through six routes' worth of axios mocks would test the mocks.
module.exports.mapGitHubUpstreamError = mapGitHubUpstreamError;

export {};
