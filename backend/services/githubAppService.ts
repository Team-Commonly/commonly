import jwt from 'jsonwebtoken';
import axios from 'axios';

/**
 * Result of a PAT liveness probe. `live: null` means "could not determine",
 * which is a distinct answer from `false` and must stay distinct — see
 * GitHubAppService.checkPatLiveness.
 *
 * `status` is canonical; `live` is a lossy projection of it for humans reading
 * the JSON at a glance. Code should branch on `status`. `!live` merges
 * `rejected` with `absent`, and `live === null` merges `unreachable` with
 * `rate_limited` — three-into-two and two-into-one, so every `live`-based
 * branch is a question answered less precisely than it was asked
 * (@ux-lead, msg 52320, finding 3).
 */
export interface PatLiveness {
  live: boolean | null;
  status: 'absent' | 'accepted' | 'rejected' | 'rate_limited' | 'unreachable';
  upstreamStatus?: number;
  detail?: string;
}

// The 403-disambiguation predicate is shared with routes/github.ts and lives in
// its own module — see githubRateLimit.ts for why it is not a static on this
// class.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { isRateLimitError } = require('./githubRateLimit');

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

type PullReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

interface PullDiffOptions {
  owner?: string;
  repo?: string;
  pullNumber: number;
}

interface PullReviewOptions {
  owner?: string;
  repo?: string;
  pullNumber: number;
  event: PullReviewEvent;
  body?: string;
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
   *
   * PRESENCE, not liveness — and that is correct for its four callers, which
   * ask "should I even attempt this?" before proxying. Keep it free of I/O.
   * If you need to know whether the credential still WORKS, use
   * `checkPatLiveness` instead; see the note there for why these are two
   * predicates rather than one corrected one.
   */
  static isPatConfigured(): boolean {
    return !!process.env.GITHUB_PAT;
  }

  /**
   * Liveness, not presence: does GitHub still accept the configured PAT?
   *
   * A second predicate rather than a fix to `isPatConfigured` (@ux-lead, msg
   * 52286). Those six call sites ask two different questions: four ask
   * "should I attempt this?", where presence is the right test and a network
   * round-trip on every proxying request would be the wrong price; `/status`
   * asks "is it working?", which only GitHub can answer. One constant serving
   * two jobs is how the answer ends up wrong for one of them.
   *
   * `/rate_limit` is the probe because GitHub documents it as not counting
   * against the rate limit, so a diagnostic may call it freely. A 401 there is
   * precisely the signal wanted: present, well-formed, and refused.
   *
   * `live: null` is deliberate and load-bearing. If GitHub is unreachable we
   * do not know, and reporting `false` would send an operator to rotate a
   * working credential — a diagnostic that guesses in the confident direction
   * is the defect this method exists to remove, not a smaller version of it.
   * Throttling gets the same treatment for the same reason: a 403 that means
   * "slow down" is not a dead credential, and `isRateLimitError` is what keeps
   * this branch from asserting one.
   *
   * SCOPE LIMIT, and it is not academic: `accepted` proves GitHub *recognises*
   * the token, not that the token is *authorized* for what the seven proxying
   * routes do. `/rate_limit` is not scope-gated, so a PAT regenerated without
   * `repo` scope, or without SSO re-authorization, returns 200 here and 403 on
   * every real call. That is this method's own version of the bug it fixes —
   * the verdict is narrower than the name (@ux-lead, msg 52320). Unmeasured:
   * settle it at the next rotation by probing this endpoint and one real repo
   * read with the new token and comparing.
   */
  static async checkPatLiveness(timeoutMs = 5000): Promise<PatLiveness> {
    if (!this.isPatConfigured()) return { live: false, status: 'absent' };
    try {
      const headers = await this._apiHeaders();
      await axios.get('https://api.github.com/rate_limit', { headers, timeout: timeoutMs });
      return { live: true, status: 'accepted' };
    } catch (err) {
      const e = err as {
        response?: { status?: number; headers?: Record<string, string> };
        message?: string;
      };
      const upstreamStatus = e.response?.status;
      if (isRateLimitError(upstreamStatus, e.response?.headers)) {
        return { live: null, status: 'rate_limited', upstreamStatus, detail: e.message };
      }
      if (upstreamStatus === 401 || upstreamStatus === 403) {
        return { live: false, status: 'rejected', upstreamStatus };
      }
      return { live: null, status: 'unreachable', detail: e.message };
    }
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

  // ─── Pull Requests API ─────────────────────────────────────────────────────

  /**
   * Fetch the raw unified diff for a pull request.
   * Uses the `application/vnd.github.v3.diff` media type, which makes the
   * `GET /repos/.../pulls/{n}` endpoint return the diff text instead of JSON.
   */
  static async getPullDiff({ owner = 'Team-Commonly', repo = 'commonly', pullNumber }: PullDiffOptions): Promise<string> {
    const headers = await this._apiHeaders();
    headers.Accept = 'application/vnd.github.v3.diff';
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      { headers },
    );
    return res.data as string;
  }

  /**
   * Submit a review on a pull request.
   * `event` is one of APPROVE | REQUEST_CHANGES | COMMENT. GitHub requires a
   * non-empty `body` for REQUEST_CHANGES and COMMENT (the route enforces this).
   */
  static async createPullReview({ owner = 'Team-Commonly', repo = 'commonly', pullNumber, event, body }: PullReviewOptions): Promise<unknown> {
    const headers = await this._apiHeaders();
    const payload: Record<string, unknown> = { event };
    if (body) payload.body = body;
    const res = await axios.post(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
      payload,
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
