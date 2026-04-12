import fs from 'fs';
import path from 'path';

/**
 * skillsRefreshService
 *
 * Keeps the local awesome-agent-skills-index.json catalog fresh by:
 *   1. Attempting to fetch the upstream index JSON (configurable URL).
 *      On failure, falls back to reading the existing LOCAL catalog file so we
 *      still do step 2 even when the upstream mirror is unreachable/moved.
 *   2. For every unique `repo` in the catalog, fetching live star counts via the
 *      GitHub REST API and overwriting the `stars` field on all matching items.
 *   3. Writing the result back to the SAME local path the read-side catalog
 *      service (`skillsCatalogService.ts`) reads from.
 *
 * Designed to fail safely — if both upstream AND local reads fail, we bail
 * without touching anything. Star-count refresh happens even when upstream is
 * gone, which is the common dev case (upstream URL changes or goes to GCS).
 */

const UPSTREAM_INDEX_URL = process.env.SKILLS_UPSTREAM_INDEX_URL
  || 'https://raw.githubusercontent.com/openclaw/skills/main/docs/skills/awesome-agent-skills-index.json';

const GITHUB_API_BASE = 'https://api.github.com';
const REPO_CALL_DELAY_MS = 100; // Respect secondary rate limits; 100ms => 10 req/s.

interface CatalogFile {
  updatedAt?: string | null;
  upstreamRefreshedAt?: string | null;
  localRefreshedAt?: string | null;
  items?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

interface RefreshResult {
  refreshed: number;
  errors: Error[];
  durationMs: number;
  reposUpdated: number;
  reposTotal: number;
  catalogItems: number;
  wroteFile: boolean;
}

// In-memory tracking of the last successful refresh — exposed to the frontend
// via `getLastRefreshedAt()` and the catalog endpoint.
let lastRefreshAt: Date | null = null;

const resolveLocalCatalogPath = (): string => {
  if (process.env.SKILLS_CATALOG_PATH) {
    return process.env.SKILLS_CATALOG_PATH;
  }
  if (process.env.SKILLS_CATALOG_DIR) {
    return path.join(process.env.SKILLS_CATALOG_DIR, 'awesome-agent-skills-index.json');
  }
  // Matches the read path in skillsCatalogService.ts#resolveCatalogPath.
  return path.resolve(__dirname, '../../docs/skills/awesome-agent-skills-index.json');
};

const buildGitHubHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {
    'User-Agent': 'commonly-skills-refresh',
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const token = process.env.GITHUB_PAT;
  if (token) {
    // Fine-grained PATs use `Bearer`; classic PATs accept it too.
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, ms);
});

const fetchUpstreamIndex = async (): Promise<CatalogFile> => {
  const response = await fetch(UPSTREAM_INDEX_URL, {
    headers: {
      'User-Agent': 'commonly-skills-refresh',
      Accept: 'application/json',
    },
  });
  if (!response.ok) {
    throw new Error(`Upstream index fetch failed: ${response.status} ${response.statusText}`);
  }
  const text = await response.text();
  try {
    return JSON.parse(text) as CatalogFile;
  } catch (error) {
    throw new Error(`Upstream index JSON parse failed: ${(error as Error).message}`);
  }
};

const readLocalCatalog = (filePath: string): CatalogFile | null => {
  try {
    if (!fs.existsSync(filePath)) return null;
    const text = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(text) as CatalogFile;
  } catch (error) {
    console.warn(
      '[skills-refresh] Failed to parse local catalog file:',
      (error as Error).message,
    );
    return null;
  }
};

const parseRepoString = (repo: unknown): { owner: string; name: string } | null => {
  if (typeof repo !== 'string') return null;
  const trimmed = repo.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('/').filter(Boolean);
  if (parts.length !== 2) return null;
  return { owner: parts[0], name: parts[1] };
};

const fetchRepoStats = async (
  owner: string,
  name: string,
): Promise<{ stars: number | null; forks: number | null; rateLimited: boolean; authFailed: boolean }> => {
  const url = `${GITHUB_API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
  const response = await fetch(url, { headers: buildGitHubHeaders() });
  if (response.status === 401 || response.status === 403) {
    // 403 with x-ratelimit-remaining=0 is the rate-limit signal; distinguish
    // from an auth failure by checking the header.
    const remaining = response.headers.get('x-ratelimit-remaining');
    if (remaining === '0') {
      return { stars: null, forks: null, rateLimited: true, authFailed: false };
    }
    if (response.status === 401) {
      return { stars: null, forks: null, rateLimited: false, authFailed: true };
    }
    // A plain 403 with no rate-limit header — treat as auth failure to be safe.
    return { stars: null, forks: null, rateLimited: false, authFailed: true };
  }
  if (response.status === 404) {
    // Repo moved or private — leave stats alone.
    return { stars: null, forks: null, rateLimited: false, authFailed: false };
  }
  if (!response.ok) {
    throw new Error(`GitHub repo fetch failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json() as { stargazers_count?: number; forks_count?: number };
  return {
    stars: typeof body.stargazers_count === 'number' ? body.stargazers_count : null,
    forks: typeof body.forks_count === 'number' ? body.forks_count : null,
    rateLimited: false,
    authFailed: false,
  };
};

/**
 * Refresh the local skills catalog from the upstream GitHub JSON and
 * overlay fresh star counts on every unique repo. Safe to call repeatedly;
 * failures preserve the existing local file.
 */
export const refreshSkillsIndex = async (): Promise<RefreshResult> => {
  const startedAt = Date.now();
  const errors: Error[] = [];
  const result: RefreshResult = {
    refreshed: 0,
    errors,
    durationMs: 0,
    reposUpdated: 0,
    reposTotal: 0,
    catalogItems: 0,
    wroteFile: false,
  };

  let catalog: CatalogFile;
  let upstreamSucceeded = false;
  try {
    catalog = await fetchUpstreamIndex();
    upstreamSucceeded = true;
  } catch (error) {
    const err = error as Error;
    console.warn(
      '[skills-refresh] Upstream index fetch failed; falling back to local catalog:',
      err.message,
    );
    errors.push(err);
    // Fall back: read the local file and still run the star-count refresh on
    // its entries. This is the common dev case when the upstream URL is wrong
    // or the mirror has moved.
    const localPath = resolveLocalCatalogPath();
    const localCatalog = readLocalCatalog(localPath);
    if (!localCatalog) {
      console.warn('[skills-refresh] No local catalog available; nothing to refresh.');
      result.durationMs = Date.now() - startedAt;
      return result;
    }
    catalog = localCatalog;
  }

  const items = Array.isArray(catalog.items) ? catalog.items : [];
  result.catalogItems = items.length;

  // Build a unique repo set so we hit each repo exactly once regardless of
  // how many skill entries reference it.
  const uniqueRepos = new Map<string, { owner: string; name: string }>();
  items.forEach((item) => {
    const parsed = parseRepoString(item.repo);
    if (!parsed) return;
    const key = `${parsed.owner}/${parsed.name}`;
    if (!uniqueRepos.has(key)) {
      uniqueRepos.set(key, parsed);
    }
  });
  result.reposTotal = uniqueRepos.size;

  const statsByRepo = new Map<string, { stars: number; forks: number }>();
  let stopDueToAuth = false;
  let stopDueToRateLimit = false;

  // Walk repos sequentially with a delay — avoids secondary rate-limit bursts.
  for (const [key, parsed] of uniqueRepos) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { stars, forks, rateLimited, authFailed } = await fetchRepoStats(parsed.owner, parsed.name);
      if (authFailed) {
        stopDueToAuth = true;
        errors.push(new Error(`GitHub auth failed for ${key} — check GITHUB_PAT`));
        break;
      }
      if (rateLimited) {
        stopDueToRateLimit = true;
        errors.push(new Error(`GitHub rate limit reached at ${key}`));
        break;
      }
      if (typeof stars === 'number') {
        statsByRepo.set(key, {
          stars,
          forks: typeof forks === 'number' ? forks : 0,
        });
      }
    } catch (error) {
      errors.push(error as Error);
      // Keep going on individual fetch errors — one dead repo shouldn't
      // nuke the entire refresh.
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(REPO_CALL_DELAY_MS);
  }

  if (stopDueToAuth) {
    // Without valid auth we can't trust the stats we got (may be empty).
    // Still write the upstream index though — that's a net improvement.
    console.warn('[skills-refresh] GitHub auth failed; writing upstream index without fresh stats.');
  }
  if (stopDueToRateLimit) {
    console.warn('[skills-refresh] Hit GitHub rate limit mid-run; partial stats will be applied.');
  }

  // Overlay fresh stars and forks onto each catalog item.
  let refreshedCount = 0;
  items.forEach((item) => {
    const parsed = parseRepoString(item.repo);
    if (!parsed) return;
    const key = `${parsed.owner}/${parsed.name}`;
    const stats = statsByRepo.get(key);
    if (stats) {
      // eslint-disable-next-line no-param-reassign
      (item as { stars: number }).stars = stats.stars;
      // eslint-disable-next-line no-param-reassign
      (item as { forks: number }).forks = stats.forks;
      refreshedCount += 1;
    }
  });
  result.refreshed = refreshedCount;
  result.reposUpdated = statsByRepo.size;

  // Stamp the catalog for frontend "last updated X ago" display.
  // If upstream fetch succeeded, record now as the upstreamRefreshedAt.
  // If we fell back to local, preserve the prior upstreamRefreshedAt (or
  // the old `updatedAt` field as a best-effort approximation) since we
  // didn't actually hit the upstream.
  const now = new Date();
  const nowIso = now.toISOString();
  const priorUpstream = typeof catalog.upstreamRefreshedAt === 'string'
    ? catalog.upstreamRefreshedAt
    : (typeof catalog.updatedAt === 'string' ? catalog.updatedAt : null);
  const output: CatalogFile = {
    ...catalog,
    updatedAt: nowIso,
    upstreamRefreshedAt: upstreamSucceeded ? nowIso : priorUpstream,
    localRefreshedAt: nowIso,
    items,
  };

  const targetPath = resolveLocalCatalogPath();
  try {
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    result.wroteFile = true;
    lastRefreshAt = now;
    // Invalidate any in-memory cache the read-side service holds.
    try {
      // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
      const catalogService = require('./skillsCatalogService');
      if (typeof catalogService.invalidateCache === 'function') {
        catalogService.invalidateCache();
      }
    } catch (_error) {
      // No cache to invalidate — fine.
    }
    console.log(
      `[skills-refresh] Wrote ${items.length} items to ${targetPath} `
      + `(stats updated on ${refreshedCount} item(s) across ${statsByRepo.size}/${uniqueRepos.size} repo(s))`,
    );
  } catch (error) {
    const err = error as Error;
    console.error('[skills-refresh] Failed to write catalog file:', err.message);
    errors.push(err);
  }

  result.durationMs = Date.now() - startedAt;
  return result;
};

export const getLastRefreshAt = (): Date | null => lastRefreshAt;

export default { refreshSkillsIndex, getLastRefreshAt };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
