const express = require('express');

const router = express.Router();
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const GitHubAppService = require('../services/githubAppService');

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;

/**
 * Accept both agent tokens and human JWT for issue endpoints.
 */
function anyAuth(req, res, next) {
  const token = (req.header('Authorization') || '').replace('Bearer ', '');
  if (token.startsWith('cm_agent_')) return agentRuntimeAuth(req, res, next);
  return auth(req, res, next);
}

/**
 * POST /api/github/token
 *
 * Agents call this (via acpx_run curl) to get a GitHub token for git/gh CLI operations.
 * Supports two modes (checked in order):
 *   1. PAT mode  — if GITHUB_PAT is set, returns it directly (simpler, for dev use)
 *   2. App mode  — generates a short-lived installation token via GitHub App RS256 JWT
 *
 * Response: { token: string, expiresAt: string|null }
 * Token usage:
 *   - git clone https://x-access-token:${token}@github.com/owner/repo.git
 *   - GH_TOKEN=${token} gh pr create ...
 *
 * Body (optional): { owner: "Team-Commonly", repo: "commonly" }
 * Secured by agentRuntimeAuth — requires a valid cm_agent_* runtime token.
 */
router.post('/token', agentRuntimeAuth, async (req, res) => {
  try {
    // PAT mode — simple passthrough, no GitHub App setup needed
    if (GitHubAppService.isPatConfigured()) {
      return res.json(GitHubAppService.getPatToken());
    }

    // GitHub App mode
    if (!GitHubAppService.isConfigured()) {
      return res.status(503).json({
        message: 'No GitHub credentials configured. Set GITHUB_PAT or GitHub App env vars (GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID_COMMONLY).',
      });
    }

    const { owner = 'Team-Commonly', repo = 'commonly' } = req.body || {};

    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) {
      return res.status(400).json({ message: 'Invalid owner or repo name' });
    }

    let installationId = process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY;

    // For repos other than the default, look up installation ID dynamically
    if (owner !== 'Team-Commonly' || repo !== 'commonly') {
      installationId = await GitHubAppService.getInstallationIdForRepo(owner, repo);
    }

    const result = await GitHubAppService.getInstallationToken(installationId);
    return res.json(result); // { token: "ghs_...", expiresAt: "2026-..." }
  } catch (err) {
    const status = err.response?.status;
    if (status === 404) {
      return res.status(404).json({ message: 'GitHub App not installed on this repository' });
    }
    return res.status(500).json({ message: 'Failed to generate GitHub token', error: err.message });
  }
});

/**
 * GET /api/github/status
 *
 * Admin endpoint — check whether the GitHub App is configured and the credentials work.
 * Secured by user auth (admin access).
 */
router.get('/status', auth, async (req, res) => {
  try {
    if (req.user?.role !== 'admin') {
      return res.status(403).json({ message: 'Admin only' });
    }
    if (GitHubAppService.isPatConfigured()) {
      return res.json({ mode: 'pat', configured: true });
    }
    if (!GitHubAppService.isConfigured()) {
      return res.json({ mode: 'none', configured: false, message: 'Set GITHUB_PAT or GitHub App env vars' });
    }
    const appJWT = GitHubAppService.generateAppJWT();
    return res.json({
      mode: 'app',
      configured: true,
      appId: process.env.GITHUB_APP_ID,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY,
      jwtGenerated: !!appJWT,
    });
  } catch (err) {
    return res.status(500).json({ configured: false, error: err.message });
  }
});

// ─── GitHub Issues API ───────────────────────────────────────────────────────

/**
 * GET /api/github/issues
 * List open issues (excludes pull requests).
 * Query: ?owner=Team-Commonly&repo=commonly&per_page=20
 */
router.get('/issues', anyAuth, async (req, res) => {
  try {
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const { owner = 'Team-Commonly', repo = 'commonly', per_page } = req.query;
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) {
      return res.status(400).json({ error: 'Invalid owner or repo' });
    }
    const issues = await GitHubAppService.listOpenIssues({ owner, repo, perPage: Number(per_page) || 20 });
    return res.json({ issues: issues.map((i) => ({ number: i.number, title: i.title, body: i.body, url: i.html_url, labels: i.labels?.map((l) => l.name), milestone: i.milestone?.title || null })) });
  } catch (err) {
    console.error('GET /github/issues error:', err.message);
    return res.status(500).json({ error: 'Failed to list issues', detail: err.message });
  }
});

/**
 * POST /api/github/issues
 * Create a new GitHub issue.
 * Body: { title, body?, labels?, owner?, repo? }
 */
router.post('/issues', anyAuth, async (req, res) => {
  try {
    if (!GitHubAppService.isPatConfigured() && !GitHubAppService.isConfigured()) {
      return res.status(503).json({ error: 'No GitHub credentials configured' });
    }
    const { title, body, labels, owner = 'Team-Commonly', repo = 'commonly' } = req.body || {};
    if (!title) return res.status(400).json({ error: 'title is required' });
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) {
      return res.status(400).json({ error: 'Invalid owner or repo' });
    }
    const issue = await GitHubAppService.createIssue({ owner, repo, title, body, labels });
    return res.status(201).json({ number: issue.number, title: issue.title, url: issue.html_url });
  } catch (err) {
    console.error('POST /github/issues error:', err.message);
    return res.status(500).json({ error: 'Failed to create issue', detail: err.message });
  }
});

/**
 * POST /api/github/issues/:number/comment
 * Add a comment to an issue.
 * Body: { body, owner?, repo? }
 */
router.post('/issues/:number/comment', anyAuth, async (req, res) => {
  try {
    const issueNumber = Number(req.params.number);
    const { body, owner = 'Team-Commonly', repo = 'commonly' } = req.body || {};
    if (!body) return res.status(400).json({ error: 'body is required' });
    await GitHubAppService.addIssueComment({ owner, repo, issueNumber, body });
    return res.json({ ok: true });
  } catch (err) {
    console.error('POST /github/issues/comment error:', err.message);
    return res.status(500).json({ error: 'Failed to comment', detail: err.message });
  }
});

/**
 * POST /api/github/issues/:number/close
 * Close an issue, optionally with a final comment.
 * Body: { comment?, owner?, repo? }
 */
router.post('/issues/:number/close', anyAuth, async (req, res) => {
  try {
    const issueNumber = Number(req.params.number);
    const { comment, owner = 'Team-Commonly', repo = 'commonly' } = req.body || {};
    await GitHubAppService.closeIssue({ owner, repo, issueNumber, comment });
    return res.json({ ok: true, closed: issueNumber });
  } catch (err) {
    console.error('POST /github/issues/close error:', err.message);
    return res.status(500).json({ error: 'Failed to close issue', detail: err.message });
  }
});

module.exports = router;
