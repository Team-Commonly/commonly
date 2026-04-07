// eslint-disable-next-line global-require
const express = require('express');
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
    const e = err as { response?: { status?: number }; message?: string };
    const status = e.response?.status;
    if (status === 404) return res.status(404).json({ message: 'GitHub App not installed on this repository' });
    return res.status(500).json({ message: 'Failed to generate GitHub token', error: e.message });
  }
});

router.get('/status', auth, async (req: AuthReq, res: Res) => {
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
    const { owner = 'Team-Commonly', repo = 'commonly', per_page } = (req.query || {}) as { owner?: string; repo?: string; per_page?: string };
    if (!VALID_NAME.test(owner) || !VALID_NAME.test(repo)) return res.status(400).json({ error: 'Invalid owner or repo' });
    const issues = await GitHubAppService.listOpenIssues({ owner, repo, perPage: Number(per_page) || 20 });
    return res.json({ issues: issues.map((i: { number: number; title: string; body: string; html_url: string; labels?: Array<{ name: string }>; milestone?: { title?: string } }) => ({ number: i.number, title: i.title, body: i.body, url: i.html_url, labels: i.labels?.map((l) => l.name), milestone: i.milestone?.title || null })) });
  } catch (err) {
    const e = err as { message?: string };
    console.error('GET /github/issues error:', e.message);
    return res.status(500).json({ error: 'Failed to list issues', detail: e.message });
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
    const e = err as { message?: string };
    console.error('POST /github/issues error:', e.message);
    return res.status(500).json({ error: 'Failed to create issue', detail: e.message });
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
    const e = err as { message?: string };
    console.error('POST /github/issues/comment error:', e.message);
    return res.status(500).json({ error: 'Failed to comment', detail: e.message });
  }
});

router.post('/issues/:number/close', anyAuth, async (req: AuthReq, res: Res) => {
  try {
    const issueNumber = Number(req.params?.number);
    const { comment, owner = 'Team-Commonly', repo = 'commonly' } = (req.body || {}) as { comment?: string; owner?: string; repo?: string };
    await GitHubAppService.closeIssue({ owner, repo, issueNumber, comment });
    return res.json({ ok: true, closed: issueNumber });
  } catch (err) {
    const e = err as { message?: string };
    console.error('POST /github/issues/close error:', e.message);
    return res.status(500).json({ error: 'Failed to close issue', detail: e.message });
  }
});

module.exports = router;
