import jwt from 'jsonwebtoken';
import axios from 'axios';
import { sendWrite } from './brokerWriteOutcome';
import {
  GITHUB_APP_NAMES, githubAppCredentials, githubAppOfConfig, type GitHubAppName,
} from './githubAppNames';

export interface GitHubToken {
  token: string;
  expiresAt: string | null;
}

export interface PatLiveness {
  live: boolean | null;
  status: 'absent' | 'accepted' | 'rejected' | 'unreachable';
  upstreamStatus?: number;
  detail?: string;
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

/**
 * An installation, named together with the App that signs for it (F172), and
 * for a Connect row the one repository its token is narrowed to. The App is
 * required wherever an installation is: tsc refuses a call that names an
 * installation and drops its App.
 */
export interface InstallationSigner {
  installationId: string;
  app: GitHubAppName;
  /** GitHub's repository id. A Connect token is minted for this repository only. */
  repositoryId?: string;
}

/** Either no installation (the instance default, or the PAT), or an installation with its App. */
type InstallationTarget =
  | { installationId?: undefined; app?: undefined; repositoryId?: undefined }
  | InstallationSigner;

type ListIssuesOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  perPage?: number;
  forceApp?: boolean;
}

type CreateIssueOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  title: string;
  body?: string;
  labels?: string[];
  forceApp?: boolean;
}

type IssueCommentOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  issueNumber: number;
  body: string;
  forceApp?: boolean;
}

type CloseIssueOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  issueNumber: number;
  comment?: string;
  forceApp?: boolean;
}

type IssueNumberOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  issueNumber: number;
  forceApp?: boolean;
}

type PullRequestOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  pullNumber: number;
  forceApp?: boolean;
}

type MergePullRequestOptions = PullRequestOptions & {
  mergeMethod?: 'merge' | 'squash' | 'rebase';
  commitTitle?: string;
  commitMessage?: string;
  sha?: string;
}

type PullReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

interface PullDiffOptions {
  owner?: string;
  repo?: string;
  pullNumber: number;
}

type PullReviewOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  pullNumber: number;
  event: PullReviewEvent;
  body?: string;
  forceApp?: boolean;
}

type CreatePullRequestOptions = InstallationTarget & {
  owner?: string;
  repo?: string;
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
  forceApp?: boolean;
}

/** Git Data API calls the broker's `github.commit_files` makes. App-only: every caller passes an installation. */
type GitDataOptions = InstallationSigner & {
  owner: string;
  repo: string;
  forceApp?: boolean;
};

/** One path segment at a time, so a `/` in a branch stays a separator and nothing else is read as one. */
const refPath = (branch: string): string => branch.split('/').map(encodeURIComponent).join('/');

export { GITHUB_APP_NAMES, githubAppOfConfig, type GitHubAppName };

export class GitHubAppNotConfiguredError extends Error {
  code = 'github_app_not_configured';

  constructor(public app: GitHubAppName) {
    super('github_app_not_configured');
  }
}

/** A Connect token request that names no single, valid repository id. */
export class GitHubRepositoryRequiredError extends Error {
  code = 'github_repository_required';

  constructor() {
    super('github_repository_required');
  }
}

/** GitHub's repository id as a positive safe integer, or null. Digits only, no sign, no fraction. */
const repositoryIdNumber = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/**
 * The most one GitHub REST request on the broker path may take. An approved
 * call must end well inside APPROVED_CALL_SETTLE_MS in approvalActionService,
 * and a commit is about ten of these in sequence.
 */
export const GITHUB_REST_TIMEOUT_MS = 30 * 1000;

/**
 * The request config for a call the broker makes. `timeout` is only an idle
 * timer in axios's Node adapter, so the signal is what holds the total.
 */
const brokerRequest = (headers: Record<string, string>) => ({
  headers,
  timeout: GITHUB_REST_TIMEOUT_MS,
  signal: AbortSignal.timeout(GITHUB_REST_TIMEOUT_MS),
});

/**
 * Reuse a cached installation token only while it has this long left, so a
 * caller that runs several requests (or a slow git push) never starts on a
 * token about to expire. GitHub issues them for an hour.
 */
export const TOKEN_REUSE_MARGIN_MS = 10 * 60 * 1000;

/** Keyed `${app}:${installationId}`, so one App's token is never served for the other's installation. */
const installationTokenCache = new Map<string, GitHubToken>();

/**
 * GitHubAppService — generates short-lived installation access tokens
 * using a GitHub App's private key (RS256 JWT).
 *
 * Env vars:
 *   GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY                   — the tools App
 *   GITHUB_CONNECT_APP_ID / GITHUB_CONNECT_APP_PRIVATE_KEY   — the Connect App (optional)
 *   GITHUB_APP_INSTALLATION_ID_COMMONLY   — pre-known tools installation for Team-Commonly/commonly
 */
class GitHubAppService {
  /** The App's id and key, or null when either is unset. */
  static appCredentials(app: GitHubAppName = 'tools'): { id: string; key: string } | null {
    return githubAppCredentials(app);
  }

  /** Whether this App can sign. */
  static isAppConfigured(app: GitHubAppName): boolean {
    return this.appCredentials(app) !== null;
  }

  /**
   * Generate a short-lived JWT to authenticate as the GitHub App itself (valid 10 min).
   * Used as a stepping stone to get installation access tokens.
   */
  static generateAppJWT(app: GitHubAppName = 'tools'): string {
    const credentials = this.appCredentials(app);
    // The tools App keeps its old behaviour (jwt.sign reports the missing
    // key). Connect refuses by name and never reaches for another key.
    if (!credentials && app !== 'tools') throw new GitHubAppNotConfiguredError(app);
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
      { iat: now - 60, exp: now + 600, iss: credentials ? credentials.id : process.env.GITHUB_APP_ID },
      (credentials ? credentials.key : process.env.GITHUB_APP_PRIVATE_KEY) as string,
      { algorithm: 'RS256' },
    );
  }

  /**
   * Exchange an installation ID for a short-lived installation access token (valid 1 hour).
   * This token is what agents use with `gh` CLI and `git`. Cached per (App, installation).
   */
  static async getInstallationToken(
    installationId: string | number,
    app: GitHubAppName,
    repositoryId?: string,
    options: { fresh?: boolean } = {},
  ): Promise<GitHubToken> {
    if (!GITHUB_APP_NAMES.includes(app)) throw new GitHubAppNotConfiguredError(app);
    // A Connect token is narrowed to the connection's one repository (F172 M1),
    // defence in depth under the per-call proof. Tools tokens are unchanged.
    // A Connect request with no valid repository id refuses: it must never
    // mint an installation-wide token.
    let narrowTo: number | null = null;
    if (app === 'connect') {
      narrowTo = repositoryIdNumber(repositoryId);
      if (narrowTo === null) throw new GitHubRepositoryRequiredError();
    }
    const cacheKey = `${app}:${installationId}:${narrowTo ?? '*'}`;
    const cached = installationTokenCache.get(cacheKey);
    if (!options.fresh && cached && cached.expiresAt
      && Date.parse(cached.expiresAt) - Date.now() > TOKEN_REUSE_MARGIN_MS) {
      return cached;
    }
    const appJWT = this.generateAppJWT(app);
    const res = await axios.post(
      `https://api.github.com/app/installations/${installationId}/access_tokens`,
      narrowTo !== null ? { repository_ids: [narrowTo] } : {},
      brokerRequest({
        Authorization: `Bearer ${appJWT}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      }),
    );
    const token: GitHubToken = { token: res.data.token, expiresAt: res.data.expires_at };
    if (token.token && token.expiresAt) installationTokenCache.set(cacheKey, token);
    return token;
  }

  /** Tests only: forget every cached installation token. */
  static _resetTokenCache(): void {
    installationTokenCache.clear();
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

  /**
   * Ask GitHub whether the PAT is accepted. Presence is not liveness: a token
   * can be set and still refused (revoked, expired), which is what the
   * 2026-08-04 outage looked like from inside the pods.
   *
   * Kept separate from isPatConfigured, which guards hot request paths and
   * must stay free of I/O. GET /rate_limit is documented as not counting
   * against the rate limit, so this diagnostic can be called freely.
   *
   * `live: null` means we could not reach a verdict. Only a 401 is a
   * rejection; anything else (403, 5xx, network) is reported as unknown rather
   * than guessed, since a false "dead" sends an operator to rotate a good key.
   */
  static async checkPatLiveness(): Promise<PatLiveness> {
    if (!this.isPatConfigured()) return { live: false, status: 'absent' };
    try {
      await axios.get('https://api.github.com/rate_limit', {
        headers: { Authorization: `Bearer ${process.env.GITHUB_PAT}`, Accept: 'application/vnd.github+json' },
        timeout: 5000,
      });
      return { live: true, status: 'accepted', upstreamStatus: 200 };
    } catch (err) {
      const e = err as { message?: string; response?: { status?: number } };
      const upstreamStatus = e.response?.status;
      if (upstreamStatus === 401) return { live: false, status: 'rejected', upstreamStatus };
      return { live: null, status: 'unreachable', upstreamStatus, detail: e.message };
    }
  }

  // ─── Issues API ──────────────────────────────────────────────────────────

  /**
   * Shared headers for GitHub REST API calls.
   *
   * The App installation token is the default credential: it lives an hour and
   * is scoped to the repos the App is installed on. The shared GITHUB_PAT is a
   * fallback for instances with no App configured, and using it is logged.
   * Supplying an installationId (or forceApp) is an app-only request, so a
   * broker tool stays fail-closed even if its caller forgets to pass forceApp.
   */
  static async _apiHeaders(
    installationId?: string,
    forceApp = false,
    appName?: GitHubAppName,
    repositoryId?: string,
  ): Promise<Record<string, string>> {
    // An installation is signed only by the App the caller names with it. A
    // JS caller that names one without an App is refused, never defaulted.
    if (installationId !== undefined && appName === undefined) throw new Error('github_app_required');
    const app: GitHubAppName = appName ?? 'tools';
    // An explicit installationId is app-only even when it is empty, so a blank
    // value can neither pick the default installation nor reach the PAT.
    const appOnly = forceApp || installationId !== undefined || app !== 'tools';
    if (installationId !== undefined && !installationId) throw new Error('github_not_configured');
    let credential: string | undefined;
    if (app !== 'tools') {
      // A Connect call names its own installation and is signed by its own
      // App or not at all: no default installation, no PAT, no tools key.
      if (!GITHUB_APP_NAMES.includes(app)) throw new GitHubAppNotConfiguredError(app);
      if (!installationId) throw new Error('github_not_configured');
      if (!this.isAppConfigured(app)) throw new GitHubAppNotConfiguredError(app);
      credential = (await this.getInstallationToken(installationId, app, repositoryId)).token;
    } else {
      const resolvedInstallationId = installationId || process.env.GITHUB_APP_INSTALLATION_ID_COMMONLY;
      const appConfigured = !!(
        process.env.GITHUB_APP_ID
        && process.env.GITHUB_APP_PRIVATE_KEY
        && resolvedInstallationId
      );
      if (appConfigured) {
        credential = (await this.getInstallationToken(resolvedInstallationId as string, 'tools')).token;
      } else if (!appOnly && process.env.GITHUB_PAT) {
        console.warn('[github] GitHub App not configured; falling back to GITHUB_PAT');
        credential = process.env.GITHUB_PAT;
      }
    }
    if (!credential) throw new Error('github_not_configured');
    return {
      Authorization: `Bearer ${credential}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  /**
   * List open issues for a repo (excludes pull requests).
   */
  static async listOpenIssues({ owner = 'Team-Commonly', repo = 'commonly', perPage = 20, installationId, forceApp, app, repositoryId }: ListIssuesOptions = {}): Promise<GitHubIssue[]> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues?state=open&per_page=${perPage}`,
      brokerRequest(headers),
    );
    return (res.data as GitHubIssue[]).filter((i) => !i.pull_request);
  }

  /**
   * Create a new GitHub issue.
   */
  static async createIssue({ owner = 'Team-Commonly', repo = 'commonly', title, body, labels, installationId, forceApp, app, repositoryId }: CreateIssueOptions): Promise<GitHubIssue> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const payload: Record<string, unknown> = { title };
    if (body) payload.body = body;
    if (labels?.length) payload.labels = labels;
    const res = await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues`,
      payload,
      brokerRequest(headers),
    ));
    return res.data;
  }

  /**
   * Add a comment to an existing issue.
   */
  static async addIssueComment({ owner = 'Team-Commonly', repo = 'commonly', issueNumber, body, installationId, forceApp, app, repositoryId }: IssueCommentOptions): Promise<unknown> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`,
      { body },
      brokerRequest(headers),
    ));
    return res.data;
  }

  /**
   * Close an issue (optionally with a final comment).
   */
  static async closeIssue(options: CloseIssueOptions): Promise<unknown> {
    const { owner = 'Team-Commonly', repo = 'commonly', issueNumber, comment, forceApp } = options;
    if (comment) {
      await this.addIssueComment({ ...options, owner, repo, issueNumber, body: comment });
    }
    const close = async () => {
      const headers = await this._apiHeaders(options.installationId, forceApp, options.app, options.repositoryId);
      const res = await sendWrite(() => axios.patch(
        `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
        { state: 'closed' },
        brokerRequest(headers),
      ));
      return res.data;
    };
    // With a comment already posted, a deadline on any later step leaves the
    // issue changed, so even the token mint counts.
    return comment ? sendWrite(close) : close();
  }

  /** Fetch one issue without exposing the server credential to the caller. */
  static async getIssue({ owner = 'Team-Commonly', repo = 'commonly', issueNumber, installationId, forceApp, app, repositoryId }: IssueNumberOptions): Promise<GitHubIssue> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`,
      brokerRequest(headers),
    );
    return res.data;
  }

  /** Fetch one pull request. */
  static async getPullRequest({ owner = 'Team-Commonly', repo = 'commonly', pullNumber, installationId, forceApp, app, repositoryId }: PullRequestOptions): Promise<unknown> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}`,
      brokerRequest(headers),
    );
    return res.data;
  }

  /** Create a pull request without returning the App credential to the seat. */
  static async createPullRequest({
    owner = 'Team-Commonly', repo = 'commonly', title, head, base, body, draft,
    installationId, forceApp, app, repositoryId,
  }: CreatePullRequestOptions): Promise<unknown> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/pulls`,
      { title, head, base, ...(body !== undefined ? { body } : {}), ...(draft !== undefined ? { draft } : {}) },
      brokerRequest(headers),
    ));
    return res.data;
  }

  /** List files changed by one pull request. */
  static async listPullRequestFiles({ owner = 'Team-Commonly', repo = 'commonly', pullNumber, installationId, forceApp, app, repositoryId }: PullRequestOptions): Promise<unknown[]> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/files`,
      brokerRequest(headers),
    );
    return res.data;
  }

  /** Merge one pull request using the connected GitHub App installation. */
  static async mergePullRequest({
    owner = 'Team-Commonly', repo = 'commonly', pullNumber, mergeMethod, commitTitle, commitMessage,
    installationId, forceApp, app, repositoryId, sha,
  }: MergePullRequestOptions): Promise<unknown> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const payload: Record<string, unknown> = {};
    if (sha) payload.sha = sha;
    if (mergeMethod) payload.merge_method = mergeMethod;
    if (commitTitle) payload.commit_title = commitTitle;
    if (commitMessage) payload.commit_message = commitMessage;
    const res = await sendWrite(() => axios.put(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/merge`,
      payload,
      brokerRequest(headers),
    ));
    return res.data;
  }

  // ─── Git Data API (TASK-783) ───────────────────────────────────────────────

  /** The commit a branch points at, or null when the branch does not exist. */
  static async getBranchHead({
    owner, repo, branch, installationId, forceApp, app, repositoryId,
  }: GitDataOptions & { branch: string }): Promise<string | null> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    try {
      const res = await axios.get(
        `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${refPath(branch)}`,
        brokerRequest(headers),
      );
      const object = (res.data as { ref?: string; object?: { sha?: string; type?: string } }) || {};
      // GitHub answers a prefix lookup with an array; only an exact ref is one branch.
      if (Array.isArray(res.data) || object.ref !== `refs/heads/${branch}` || object.object?.type !== 'commit') {
        return null;
      }
      return typeof object.object?.sha === 'string' ? object.object.sha : null;
    } catch (error) {
      if (Number((error as { response?: { status?: unknown } }).response?.status) === 404) return null;
      throw error;
    }
  }

  /** The tree a commit records. */
  static async getCommitTree({
    owner, repo, sha, installationId, forceApp, app, repositoryId,
  }: GitDataOptions & { sha: string }): Promise<string> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}/git/commits/${sha}`, brokerRequest(headers));
    return String((res.data as { tree?: { sha?: string } })?.tree?.sha || '');
  }

  /** The repository's default branch, as GitHub reports it now. */
  static async getDefaultBranch({ owner, repo, installationId, forceApp, app, repositoryId }: GitDataOptions): Promise<string> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(`https://api.github.com/repos/${owner}/${repo}`, brokerRequest(headers));
    return String((res.data as { default_branch?: string })?.default_branch || '');
  }

  /**
   * Every entry of a tree, recursively. `truncated` is GitHub's own flag: past
   * its listing limit the entries are incomplete, and a caller comparing trees
   * must not read an absent entry as "not there".
   */
  static async getTreeEntries({
    owner, repo, sha, installationId, forceApp, app, repositoryId,
  }: GitDataOptions & { sha: string }): Promise<{
    entries: Array<{ path: string; type: string; mode: string; sha: string }>;
    truncated: boolean;
  }> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await axios.get(
      `https://api.github.com/repos/${owner}/${repo}/git/trees/${sha}?recursive=1`,
      brokerRequest(headers),
    );
    const data = (res.data as { tree?: unknown; truncated?: unknown }) || {};
    const entries = (Array.isArray(data.tree) ? data.tree : []).map((entry: Record<string, unknown>) => ({
      path: String(entry?.path ?? ''),
      type: String(entry?.type ?? ''),
      mode: String(entry?.mode ?? ''),
      sha: String(entry?.sha ?? ''),
    }));
    return { entries, truncated: data.truncated === true };
  }

  /** A tree that is `baseTree` with each file's text written as a regular (100644) blob. */
  static async createTextTree({ owner, repo, baseTree, files, installationId, forceApp, app, repositoryId }: GitDataOptions & {
    baseTree: string;
    files: Array<{ path: string; content: string }>;
  }): Promise<string> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/git/trees`,
      {
        base_tree: baseTree,
        tree: files.map((file) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })),
      },
      brokerRequest(headers),
    ));
    return String((res.data as { sha?: string })?.sha || '');
  }

  static async createCommit({ owner, repo, message, tree, parents, installationId, forceApp, app, repositoryId }: GitDataOptions & {
    message: string;
    tree: string;
    parents: string[];
  }): Promise<string> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const res = await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/git/commits`,
      { message, tree, parents },
      brokerRequest(headers),
    ));
    return String((res.data as { sha?: string })?.sha || '');
  }

  /** Create a branch. GitHub refuses (422) when it already exists. */
  static async createBranchRef({ owner, repo, branch, sha, installationId, forceApp, app, repositoryId }: GitDataOptions & {
    branch: string;
    sha: string;
  }): Promise<void> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/git/refs`,
      { ref: `refs/heads/${branch}`, sha },
      brokerRequest(headers),
    ));
  }

  /** Move a branch forward. Never forced: GitHub refuses (422) anything but a fast-forward. */
  static async fastForwardBranchRef({ owner, repo, branch, sha, installationId, forceApp, app, repositoryId }: GitDataOptions & {
    branch: string;
    sha: string;
  }): Promise<void> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    await sendWrite(() => axios.patch(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${refPath(branch)}`,
      { sha, force: false },
      brokerRequest(headers),
    ));
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
  static async createPullReview({
    owner = 'Team-Commonly', repo = 'commonly', pullNumber, event, body, installationId, forceApp, app, repositoryId,
  }: PullReviewOptions): Promise<unknown> {
    const headers = await this._apiHeaders(installationId, forceApp, app, repositoryId);
    const payload: Record<string, unknown> = { event };
    if (body) payload.body = body;
    const res = await sendWrite(() => axios.post(
      `https://api.github.com/repos/${owner}/${repo}/pulls/${pullNumber}/reviews`,
      payload,
      brokerRequest(headers),
    ));
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
