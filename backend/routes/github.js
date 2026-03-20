const express = require('express');

const router = express.Router();
const agentRuntimeAuth = require('../middleware/agentRuntimeAuth');
const auth = require('../middleware/auth');
const GitHubAppService = require('../services/githubAppService');

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;

/**
 * POST /api/github/token
 *
 * Agents call this (via acpx_run curl) to get a fresh GitHub App installation token.
 * Token is valid for 1 hour and can be used with:
 *   - git clone https://x-access-token:${token}@github.com/owner/repo.git
 *   - GH_TOKEN=${token} gh pr create ...
 *
 * Body (optional): { owner: "Team-Commonly", repo: "commonly" }
 * Defaults to Team-Commonly/commonly if omitted.
 *
 * Secured by agentRuntimeAuth — requires a valid cm_agent_* runtime token.
 */
router.post('/token', agentRuntimeAuth, async (req, res) => {
  try {
    if (!GitHubAppService.isConfigured()) {
      return res.status(503).json({
        message: 'GitHub App not configured. Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID_COMMONLY.',
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
    if (!req.user?.role === 'admin') {
      return res.status(403).json({ message: 'Admin only' });
    }
    if (!GitHubAppService.isConfigured()) {
      return res.json({ configured: false, message: 'Missing env vars' });
    }
    // Validate that the JWT can be generated (catches bad key format early)
    const appJWT = GitHubAppService.generateAppJWT();
    return res.json({
      configured: true,
      appId: process.env.GITHUB_APP_ID,
      installationId: process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY,
      jwtGenerated: !!appJWT,
    });
  } catch (err) {
    return res.status(500).json({ configured: false, error: err.message });
  }
});

module.exports = router;
