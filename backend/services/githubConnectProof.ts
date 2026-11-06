/**
 * F172: the proof a person gives before a Commonly Connect repository becomes
 * a `github-app` connection they own.
 *
 * Nothing in the request body is trusted. The installation and the repository
 * are read back from GitHub with the person's OWN GitHub App user token: the
 * one D248's hosted-MCP GitHub connection stores (`hosted-mcp` row, entry
 * `github-mcp`, opened through `credentialFor`). That token is minted by the
 * Commonly Connect App, so `GET /user/installations` lists only Connect
 * installations the person can access, and
 * `GET /user/installations/{id}/repositories` only the repositories in that
 * installation the person can access. A connection is created only when both
 * lists name what the body asked for, and the person can push to it.
 *
 * The installation's `app_id` is checked against `GITHUB_CONNECT_APP_ID` as
 * well, so an instance whose hosted-MCP client is a different App than the one
 * the broker signs with refuses instead of binding an installation the Connect
 * key cannot sign for.
 */
import { hostedVendorFetch } from './hostedVendorFetch';

export const GITHUB_MCP_ENTRY_ID = 'github-mcp';

/** Most entries read from one GitHub listing (100 per page). Past this, the answer is "not visible". */
const MAX_PAGES = 10;
const PAGE_SIZE = 100;
const GITHUB_TIMEOUT_MS = 8000;
/** The picker's bound: at most 3 + 10 × 3 requests in one page load, within the time budget. */
const LIST_MAX_INSTALLATIONS = 10;
const LIST_MAX_PAGES = 3;
const LIST_BUDGET_MS = 20_000;

export type GithubConnectProofRefusalCode =
  | 'github_connect_required'
  | 'installation_not_visible'
  | 'installation_suspended'
  | 'repository_not_visible'
  | 'repository_write_required'
  | 'repository_changed'
  | 'github_unreachable';

export class GithubConnectProofError extends Error {
  constructor(public code: GithubConnectProofRefusalCode, message: string, public statusCode: number) {
    super(message);
  }
}

export interface ProvenConnectRepository {
  installationId: string;
  /** GitHub's own spelling, never the body's. */
  owner: string;
  repo: string;
  /** GitHub's repository id: survives a rename, differs after a delete-and-recreate or a transfer swap (F172 M1). */
  repositoryId: string;
}

interface UserTokenRow {
  _id?: unknown;
  revokedAt?: Date | null;
  config?: Record<string, unknown>;
}

export interface GithubConnectProofDeps {
  /** The person's own connected GitHub hosted-MCP row, or null. */
  loadUserTokenRow: (userId: string) => Promise<UserTokenRow | null>;
  /** Opens the row's credential (refreshing behind §10.3's fence). */
  credentialFor: (row: UserTokenRow) => Promise<{ token: string }>;
  fetchImpl: typeof fetch;
  connectAppId: () => string;
}

export const defaultGithubConnectProofDeps = (): GithubConnectProofDeps => ({
  loadUserTokenRow: async (userId) => {
    if (!/^[a-f\d]{24}$/i.test(userId)) return null;
    const { default: Integration } = await import('../models/Integration');
    // Bound to the caller by `createdBy` and to the OAuth row (no `agentId`):
    // never a row id the body names.
    const row = await Integration.findOne({
      type: 'hosted-mcp',
      createdBy: userId,
      'config.entryId': GITHUB_MCP_ENTRY_ID,
      'config.agentId': { $exists: false },
      status: 'connected',
      revokedAt: null,
    }).lean();
    return (row as unknown as UserTokenRow | null) || null;
  },
  credentialFor: async (row) => {
    // Lazy for the reason hostedMcpToolDefinitions gives: the credential
    // service pulls in the OAuth intake helpers.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { credentialFor } = require('./hostedMcpCredentialService');
    return credentialFor(row);
  },
  fetchImpl: hostedVendorFetch,
  connectAppId: () => String(process.env.GITHUB_CONNECT_APP_ID || '').trim(),
});

const connectRequired = (message: string): GithubConnectProofError => new GithubConnectProofError(
  'github_connect_required', message, 403,
);

const getJson = async (
  deps: GithubConnectProofDeps,
  token: string,
  path: string,
): Promise<unknown> => {
  let res: Response;
  try {
    res = await deps.fetchImpl(`https://api.github.com${path}`, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'commonly-connect',
      },
    });
  } catch {
    throw new GithubConnectProofError('github_unreachable', 'GitHub could not be reached', 502);
  }
  if (res.status === 401) throw connectRequired('your GitHub connection has expired; connect GitHub again');
  // 403/404 on these endpoints mean the token cannot see what was asked for.
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new GithubConnectProofError('github_unreachable', 'GitHub refused the lookup', 502);
  try {
    return await res.json();
  } catch {
    throw new GithubConnectProofError('github_unreachable', 'GitHub answered something unreadable', 502);
  }
};

interface InstallationEntry {
  id?: unknown;
  app_id?: unknown;
  suspended_at?: unknown;
}

interface RepositoryEntry {
  id?: unknown;
  name?: unknown;
  full_name?: unknown;
  owner?: { login?: unknown };
  private?: unknown;
  permissions?: { admin?: unknown; maintain?: unknown; push?: unknown };
}

const findInstallation = async (
  deps: GithubConnectProofDeps, token: string, installationId: string,
): Promise<InstallationEntry | null> => {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await getJson(deps, token, `/user/installations?per_page=${PAGE_SIZE}&page=${page}`) as {
      installations?: unknown;
    } | null;
    const list = Array.isArray(body?.installations) ? body?.installations as InstallationEntry[] : [];
    const match = list.find((entry) => String(entry?.id ?? '') === installationId);
    if (match) return match;
    if (list.length < PAGE_SIZE) return null;
  }
  return null;
};

const findRepository = async (
  deps: GithubConnectProofDeps, token: string, installationId: string, repoKey: string,
): Promise<RepositoryEntry | null> => {
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await getJson(
      deps, token, `/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`,
    ) as { repositories?: unknown } | null;
    const list = Array.isArray(body?.repositories) ? body?.repositories as RepositoryEntry[] : [];
    const match = list.find((entry) => String(entry?.full_name ?? '').toLowerCase() === repoKey);
    if (match) return match;
    if (list.length < PAGE_SIZE) return null;
  }
  return null;
};

const canPush = (repository: RepositoryEntry): boolean => {
  const permissions = repository.permissions;
  return permissions?.push === true || permissions?.maintain === true || permissions?.admin === true;
};

const openUserToken = async (deps: GithubConnectProofDeps, userId: string): Promise<string> => {
  const row = await deps.loadUserTokenRow(userId);
  if (!row) throw connectRequired('connect your GitHub account to Commonly first');
  let token: string;
  try {
    ({ token } = await deps.credentialFor(row));
  } catch {
    throw connectRequired('your GitHub connection needs to be connected again');
  }
  if (!token) throw connectRequired('your GitHub connection needs to be connected again');
  return token;
};

export interface ConnectableRepository {
  installationId: string;
  owner: string;
  repo: string;
  private: boolean;
}

/**
 * What `userId` could connect, for the app's picker: repositories of Connect
 * installations their own token can see, that they can push to. It offers, and
 * proves nothing: the connect route still runs `proveConnectRepository`. A
 * listing GitHub cut short, or one past the caps or the time budget, comes back
 * `truncated`. If GitHub won't give the installations at all there is nothing
 * to say about the person's repositories, so that refuses instead.
 */
export const listConnectRepositories = async (
  input: { userId: string },
  overrides: Partial<GithubConnectProofDeps> = {},
): Promise<{ repositories: ConnectableRepository[]; truncated: boolean }> => {
  const deps: GithubConnectProofDeps = { ...defaultGithubConnectProofDeps(), ...overrides };
  const token = await openUserToken(deps, input.userId);
  const appId = deps.connectAppId();
  const repositories: ConnectableRepository[] = [];
  if (!appId) return { repositories, truncated: false };
  let truncated = false;
  const deadline = Date.now() + LIST_BUDGET_MS;

  const installations: InstallationEntry[] = [];
  for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
    const body = await getJson(deps, token, `/user/installations?per_page=${PAGE_SIZE}&page=${page}`) as {
      installations?: unknown;
    } | null;
    if (!Array.isArray(body?.installations)) {
      if (page === 1) throw new GithubConnectProofError('github_unreachable', 'GitHub refused the lookup', 502);
      truncated = true;
    }
    const list = Array.isArray(body?.installations) ? body?.installations as InstallationEntry[] : [];
    installations.push(...list);
    if (list.length < PAGE_SIZE) break;
    if (page === LIST_MAX_PAGES) truncated = true;
  }

  const usable = installations.filter((entry) => String(entry?.app_id ?? '') === appId
    && !entry.suspended_at && /^\d{1,20}$/.test(String(entry?.id ?? '')));
  if (usable.length > LIST_MAX_INSTALLATIONS) truncated = true;
  for (const installation of usable.slice(0, LIST_MAX_INSTALLATIONS)) {
    const installationId = String(installation.id);
    for (let page = 1; page <= LIST_MAX_PAGES; page += 1) {
      if (Date.now() >= deadline) return { repositories, truncated: true };
      // eslint-disable-next-line no-await-in-loop -- bounded by the caps above, and GitHub's limit is per token
      const body = await getJson(
        deps, token, `/user/installations/${installationId}/repositories?per_page=${PAGE_SIZE}&page=${page}`,
      ) as { repositories?: unknown } | null;
      if (!body) truncated = true;
      const list = Array.isArray(body?.repositories) ? body?.repositories as RepositoryEntry[] : [];
      list.filter(canPush).forEach((repository) => {
        const owner = String(repository?.owner?.login ?? '');
        const repo = String(repository?.name ?? '');
        // A row GitHub doesn't mark public is not called public.
        if (owner && repo) repositories.push({ installationId, owner, repo, private: repository?.private !== false });
      });
      if (list.length < PAGE_SIZE) break;
      if (page === LIST_MAX_PAGES) truncated = true;
    }
  }
  return { repositories, truncated };
};

/**
 * Prove that `userId` can reach `owner/repo` through Connect installation
 * `installationId`, and return GitHub's spelling of both. Throws
 * GithubConnectProofError for every refusal.
 */
export const proveConnectRepository = async (
  input: {
    userId: string;
    installationId: string;
    owner: string;
    repo: string;
    /** Set on a re-proof: the listed repository must be this one, not another with the same name. */
    expectedRepositoryId?: string;
  },
  overrides: Partial<GithubConnectProofDeps> = {},
): Promise<ProvenConnectRepository> => {
  const deps: GithubConnectProofDeps = { ...defaultGithubConnectProofDeps(), ...overrides };
  const token = await openUserToken(deps, input.userId);

  const installation = await findInstallation(deps, token, input.installationId);
  const appId = deps.connectAppId();
  if (!installation || !appId || String(installation.app_id ?? '') !== appId) {
    throw new GithubConnectProofError(
      'installation_not_visible',
      'that Commonly Connect installation is not one your GitHub account can access',
      403,
    );
  }
  if (installation.suspended_at) {
    throw new GithubConnectProofError('installation_suspended', 'that installation is suspended on GitHub', 403);
  }

  const repoKey = `${input.owner}/${input.repo}`.toLowerCase();
  const repository = await findRepository(deps, token, input.installationId, repoKey);
  const owner = String(repository?.owner?.login ?? '');
  const repo = String(repository?.name ?? '');
  if (!repository || `${owner}/${repo}`.toLowerCase() !== repoKey) {
    throw new GithubConnectProofError(
      'repository_not_visible',
      'that repository is not in the installation, or your GitHub account cannot access it',
      403,
    );
  }
  if (!canPush(repository)) {
    throw new GithubConnectProofError(
      'repository_write_required',
      'you need write access to that repository to connect it',
      403,
    );
  }
  const repositoryId = String(repository.id ?? '');
  if (!/^\d{1,20}$/.test(repositoryId)
    || (input.expectedRepositoryId !== undefined && repositoryId !== input.expectedRepositoryId)) {
    throw new GithubConnectProofError(
      'repository_changed',
      'that repository is no longer the one that was connected',
      403,
    );
  }
  return { installationId: input.installationId, owner, repo, repositoryId };
};
