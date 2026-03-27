const jwt = require('jsonwebtoken');
const axios = require('axios');

/**
 * GitHubAppService — generates short-lived installation access tokens
 * using a GitHub App's private key (RS256 JWT).
 *
 * Required env vars:
 *   GITHUB_APP_ID                         — numeric app ID from GitHub App settings
 *   GITHUB_APP_PRIVATE_KEY                — PEM private key (from GCP SM)
 *   GITHUB_APP_INSTALLATION_ID_COMMONLY   — pre-known installation ID for Team-Commonly/commonly
 */
class GitHubAppService {
  /**
   * Generate a short-lived JWT to authenticate as the GitHub App itself (valid 10 min).
   * Used as a stepping stone to get installation access tokens.
   */
  static generateAppJWT() {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: now - 60, exp: now + 600, iss: process.env.GITHUB_APP_ID },
      process.env.GITHUB_APP_PRIVATE_KEY,
      { algorithm: 'RS256' },
    );
  }

  /**
   * Exchange an installation ID for a short-lived installation access token (valid 1 hour).
   * This token is what agents use with `gh` CLI and `git`.
   * @returns {{ token: string, expiresAt: string }}
   */
  static async getInstallationToken(installationId) {
    const appJWT = this.generateAppJWT();
    const res = await axios.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      {},
      {
        headers: {
          Authorization: `Bearer ${appJWT}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    return { token: res.data.token, expiresAt: res.data.expires_at };
  }

  /**
   * Look up the installation ID for any repo where the app is installed.
   * Used for multi-repo support when owner/repo is not Team-Commonly/commonly.
   * @returns {number} installationId
   */
  static async getInstallationIdForRepo(owner, repo) {
    const appJWT = this.generateAppJWT();
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/installation`,
      {
        headers: {
          Authorization: `Bearer ${appJWT}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      },
    );
    return res.data.id;
  }

  /**
   * Check whether a PAT is configured (simpler alternative to GitHub App).
   */
  static isPatConfigured() {
    return !!process.env.GITHUB_PAT;
  }

  /**
   * Return the PAT directly as a token response.
   * PATs don't have a server-issued expiry, so expiresAt is null.
   * @returns {{ token: string, expiresAt: null }}
   */
  static getPatToken() {
    return { token: process.env.GITHUB_PAT, expiresAt: null };
  }

  // ─── Issues API ──────────────────────────────────────────────────────────

  /**
   * Shared headers for GitHub REST API calls (uses PAT or App token).
   */
  static async _apiHeaders(token) {
    const pat = token || process.env.GITHUB_PAT;
    return {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /**
   * List open issues for a repo (excludes pull requests).
   * @returns {Array<{number, title, body, html_url, labels}>}
   */
  static async listOpenIssues({ owner = 'Team-Commonly', repo = 'commonly', perPage = 20 } = {}) {
    const headers = await this._apiHeaders();
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}`,
      { headers },
    );
    return res.data.filter((i) => !i.pull_request);
  }

  /**
   * Create a new GitHub issue.
   * @returns {object} Created issue object
   */
  static async createIssue({ owner = 'Team-Commonly', repo = 'commonly', title, body, labels } = {}) {
    const headers = await this._apiHeaders();
    const payload = { title };
    if (body) payload.body = body;
    if (labels?.length) payload.labels = labels;
    const res = await axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      payload,
      { headers },
    );
    return res.data;
  }

  /**
   * Add a comment to an existing issue.
   */
  static async addIssueComment({ owner = 'Team-Commonly', repo = 'commonly', issueNumber, body }) {
    const headers = await this._apiHeaders();
    const res = await axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
      { headers },
    );
    return res.data;
  }

  /**
   * Close an issue (optionally with a final comment).
   */
  static async closeIssue({ owner = 'Team-Commonly', repo = 'commonly', issueNumber, comment } = {}) {
    if (comment) {
      await this.addIssueComment({ owner, repo, issueNumber, body: comment });
    }
    const headers = await this._apiHeaders();
    const res = await axios.patch(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      { state: 'closed' },
      { headers },
    );
    return res.data;
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Check whether the GitHub App credentials are configured in env.
   */
  static isConfigured() {
    return !!(
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY
    );
  }
}

module.exports = GitHubAppService;
