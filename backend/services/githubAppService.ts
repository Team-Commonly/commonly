import jwt from 'jsonwebtoken';
import axios from 'axios';

export interface GitHubToken {
  token: string;
  expiresAt: string | null;
}

export interface GitHubIssueLabel {
  name: string;
  color?: string;
}

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  html_url: string;
  labels: GitHubIssueLabel[];
  pull_request?: unknown;
  milestone?: { title: string } | null;
}

interface ListIssuesOptions {
  owner?: string;
  repo?: string;
  perPage?: number;
}

interface CreateIssueOptions {
  owner?: string;
  repo?: string;
  title: string;
  body?: string;
  labels?: string[];
}

interface IssueCommentOptions {
  owner?: string;
  repo?: string;
  issueNumber: number;
  body: string;
}

interface CloseIssueOptions {
  owner?: string;
  repo?: string;
  issueNumber: number;
  comment?: string;
}

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
  static generateAppJWT(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: now - 60, exp: now + 600, iss: process.env.GITHUB_APP_ID },
      process.env.GITHUB_APP_PRIVATE_KEY as string,
      { algorithm: 'RS256' },
    );
  }

  /**
   * Exchange an installation ID for a short-lived installation access token (valid 1 hour).
   * This token is what agents use with `gh` CLI and `git`.
   */
  static async getInstallationToken(installationId: string | number): Promise<GitHubToken> {
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
   */
  static async getInstallationIdForRepo(owner: string, repo: string): Promise<number> {
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
  static isPatConfigured(): boolean {
    return !!process.env.GITHUB_PAT;
  }

  /**
   * Return the PAT directly as a token response.
   * PATs don't have a server-issued expiry, so expiresAt is null.
   */
  static getPatToken(): GitHubToken {
    return { token: process.env.GITHUB_PAT as string, expiresAt: null };
  }

  // ─── Issues API ──────────────────────────────────────────────────────────

  /**
   * Shared headers for GitHub REST API calls (uses PAT or App token).
   */
  static async _apiHeaders(token?: string): Promise<Record<string, string>> {
    const pat = token || process.env.GITHUB_PAT;
    return {
      Authorization: `Bearer ${pat}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /**
   * List open issues for a repo (excludes pull requests).
   */
  static async listOpenIssues({ owner = 'Team-Commonly', repo = 'commonly', perPage = 20 }: ListIssuesOptions = {}): Promise<GitHubIssue[]> {
    const headers = await this._apiHeaders();
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}`,
      { headers },
    );
    return (res.data as GitHubIssue[]).filter((i) => !i.pull_request);
  }

  /**
   * Create a new GitHub issue.
   */
  static async createIssue({ owner = 'Team-Commonly', repo = 'commonly', title, body, labels }: CreateIssueOptions): Promise<GitHubIssue> {
    const headers = await this._apiHeaders();
    const payload: Record<string, unknown> = { title };
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
  static async addIssueComment({ owner = 'Team-Commonly', repo = 'commonly', issueNumber, body }: IssueCommentOptions): Promise<unknown> {
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
  static async closeIssue({ owner = 'Team-Commonly', repo = 'commonly', issueNumber, comment }: CloseIssueOptions): Promise<unknown> {
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
  static isConfigured(): boolean {
    return !!(
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_PRIVATE_KEY &&
      process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY
    );
  }
}

export default GitHubAppService;
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
