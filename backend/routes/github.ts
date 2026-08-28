// eslint-disable-next-line global-require
const express = require('express');
// eslint-disable-next-line global-require
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
// eslint-disable-next-line global-require
const auth = require('../middleware/auth');
// eslint-disable-next-line global-require
const GitHubAppService = require('../services/githubAppService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { agentCanWriteGitHubIssues } = require('../services/githubIssueWriteCapability');

interface AuthReq {
  user?: { role?: string };
  agentUser?: { _id?: unknown };
  agentInstallations?: Array<{ githubIssueWrite?: boolean }>;
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  params?: Record<string, string>;
  header?: (name: string) => string | undefined;
}
interface Res {
  status: (n: number) => Res;
  json: (d: unknown) => void;
}

// The ONLY repository these routes may touch. Previously `owner`/`repo` were
// caller-supplied with these as defaults, which meant the caller chose the
// target and our server-held credential supplied the authority — so the blast
// radius was "every repo the PAT can reach", including private ones, rather
// than "our issue tracker". Pinned server-side: callers no longer name a target.
//
// This also retires the `VALID_NAME` regex that used to validate those inputs.
// Validating a caller-chosen repo name was always the weaker guard — it made
// the value well-formed, never authorised — and with nothing caller-supplied
// left to interpolate there is no input to check. If a per-user-credential path
// ever reintroduces a caller-chosen repo, it needs authorisation, not a regex.
const PINNED_OWNER = 'Team-Commonly';
const PINNED_REPO = 'commonly';

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

  // `detail` rides on every branch including this one. Omitting it here made
  // the callers' log line read `github_not_found undefined` on the commonest
  // failure there is (@sprint-review) — a diagnostic that goes blank exactly
  // where it is most often read.
  if (upstreamStatus === 404) {
    return {
      status: 404,
      body: {
        error: labels.notFound, code: 'github_not_found', retryable: false, detail,
      },
    };
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

const requireGitHubIssueWriteCapability = (req: AuthReq, res: Res): boolean => {
  // `anyAuth` also serves ordinary human JWTs. The capability is only for
  // agent-runtime callers. `agentUser` is best-effort for legacy tokens, but
  // both successful agent auth paths always attach the installation list.
  const isAgentRuntimeCaller = Array.isArray(req.agentInstallations);
  if (!isAgentRuntimeCaller || agentCanWriteGitHubIssues(req.agentInstallations)) return true;
  res.status(403).json({
    error: 'GitHub issue writing is not granted to this agent installation',
    code: 'github_issue_write_not_granted',
  });
  return false;
};

// REMOVED — `POST /token`, which handed our GitHub credential to callers.
//
// It was guarded by `agentRuntimeAuth` alone, so ANY `cm_agent_*` token — held
// by an agent installed by ANY user on this instance — could ask for one. With
// `GITHUB_PAT` set it returned `getPatToken()`, i.e. the raw shared PAT in
// plaintext; without it, it minted an App installation token for a
// caller-chosen repo. Both branches give away a credential we then no longer
// control, and neither asked who was calling or what for.
//
// Nothing in this repo called it; only a route-contract test did. There is no
// safer variant to keep: a token in a client's hands is a token that outlives
// any check we do here. A shell-less runtime that needs GitHub access needs a
// per-user App install of its own, not a share of ours.

router.get('/status', auth, async (req: AuthReq, res: Res) => {
  // @github-upstream-exempt: this route touches no upstream — it reads env and
  // signs a JWT locally — so a throw here really is our fault and 500 is the
  // honest answer. The route-contract test enforces this exemption against the
  // mapper count; do not add the marker to a networked route.
  try {
    if (req.user?.role !== 'admin') return res.status(403).json({ message: 'Admin only' });
    if (GitHubAppService.isPatConfigured()) return res.json({ mode: 'pat', configured: true });
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
    const { per_page } = (req.query || {}) as { per_page?: string };
    const issues = await GitHubAppService.listOpenIssues({ owner: PINNED_OWNER, repo: PINNED_REPO, perPage: Number(per_page) || 20 });
    return res.json({ issues: issues.map((i: { number: number; title: string; body: string; html_url: string; labels?: Array<{ name: string }>; milestone?: { title?: string } }) => ({ number: i.number, title: i.title, body: i.body, url: i.html_url, labels: i.labels?.map((l) => l.name), milestone: i.milestone?.title || null })) });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to list issues', notFound: 'Repository not found' });
    console.error('GET /github/issues error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/issues', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!requireGitHubIssueWriteCapability(req, res)) return;
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const { title, body, labels } = (req.body || {}) as { title?: string; body?: string; labels?: string[] };
    if (!title) return res.status(400).json({ error: 'title is required' });
    const issue = await GitHubAppService.createIssue({ owner: PINNED_OWNER, repo: PINNED_REPO, title, body, labels });
    return res.status(201).json({ number: issue.number, title: issue.title, url: issue.html_url });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to create issue', notFound: 'Repository not found' });
    console.error('POST /github/issues error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/issues/:number/comment', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!requireGitHubIssueWriteCapability(req, res)) return;
    const issueNumber = Number(req.params?.number);
    const { body } = (req.body || {}) as { body?: string };
    if (!body) return res.status(400).json({ error: 'body is required' });
    await GitHubAppService.addIssueComment({ owner: PINNED_OWNER, repo: PINNED_REPO, issueNumber, body });
    return res.json({ ok: true });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to comment', notFound: 'Issue not found' });
    console.error('POST /github/issues/comment error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

router.post('/issues/:number/close', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    if (!requireGitHubIssueWriteCapability(req, res)) return;
    const issueNumber = Number(req.params?.number);
    const { comment } = (req.body || {}) as { comment?: string };
    await GitHubAppService.closeIssue({ owner: PINNED_OWNER, repo: PINNED_REPO, issueNumber, comment });
    return res.json({ ok: true, closed: issueNumber });
  } catch (err) {
    const mapped = mapGitHubUpstreamError(err, { fallback: 'Failed to close issue', notFound: 'Issue not found' });
    console.error('POST /github/issues/close error:', mapped.body.code, mapped.body.detail);
    return res.status(mapped.status).json(mapped.body);
  }
});

// ─── Pull Requests ───────────────────────────────────────────────────────
//
// REMOVED — `GET /pulls/:number/diff` and `POST /pulls/:number/review`, which
// backed the `commonly_pr_diff` / `commonly_pr_review` MCP tools.
//
// Same defect as `/token`, one step less direct: `anyAuth` accepted any
// `cm_agent_*` token, `owner`/`repo` were caller-supplied with ours as mere
// defaults, and the call executed under our server-held PAT. So any user's
// agent could read diffs from — and post reviews, including `APPROVE`, onto —
// any repository that credential could reach. A rate limit bounds the volume of
// that, not the authority.
//
// Removing them costs no capability. Every runtime that used these has a shell
// and a GitHub credential of its own: local wrappers use the operator's `gh`
// keyring auth (PR #963 was opened that way), and cluster runtimes get `gh`
// plus a credential helper at image build. The tools were an ergonomic wrapper
// (docs/audits/ui-smoke-2026-05-23: agents "have to know the gh CLI is
// available"), and convenience is not a reason to proxy a shared credential for
// untrusted callers.
//
// The open question this leaves is deliberate: a shell-LESS runtime — native
// Tier-1, or a hosted Code Reviewer persona — still has no GitHub path. That
// case needs per-user GitHub App auth, because reviewing a user's repository
// with OUR identity is wrong even when it works. See ADR-022's v1 cast.

module.exports = router;
// Exposed for unit tests: the mapping is the load-bearing part, and testing it
// through six routes' worth of axios mocks would test the mocks.
module.exports.mapGitHubUpstreamError = mapGitHubUpstreamError;

export {};
