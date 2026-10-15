import fs from 'fs';
import path from 'path';

import { fetchTextFromAllowedHost, isOutboundUrlRefused } from './outboundUrlGuard';

const DEFAULT_SOURCE = 'awesome';

// Every host the skill-source fetches below may reach: GitHub's web host, its
// raw-content host (where `toRawGitHubUrl` points and where the contents API's
// `download_url`s live) and its REST host (the directory walk). A source URL
// supplied by a caller, and every redirect it produces, must stay on these.
// Measured 2026-10-14: 1,657 of the catalog's 1,659 `sourceUrl`s are github.com;
// the other two are ClawHub page URLs rather than SKILL.md files. Importing one
// of those with pasted content still works: a non-GitHub `sourceUrl` is stored as
// metadata and never fetched (`parseGitHubSource` returns null for it).
// Each host maps to the constant origin its requests are rebuilt on.
const SKILL_SOURCE_ORIGINS: ReadonlyMap<string, string> = new Map([
  ['github.com', 'https://github.com/'],
  ['raw.githubusercontent.com', 'https://raw.githubusercontent.com/'],
  ['api.github.com', 'https://api.github.com/'],
]);
// The largest SKILL.md in this repo is ~66 KB; ClawHub bundles cap a file at 100 KB.
const SKILL_FILE_MAX_BYTES = 512 * 1024;
const GITHUB_LISTING_MAX_BYTES = 1024 * 1024;

interface SkillItem {
  [key: string]: unknown;
}

interface Catalog {
  source: string;
  updatedAt: string | null;
  items: SkillItem[];
}

interface FetchSkillContentResult {
  content: string;
  resolvedUrl: string;
  // Set when the source itself supplied the skill's other files (a ClawHub
  // bundle), so the caller must not list a GitHub directory for them.
  extraFiles?: SkillFile[];
}

const SKILL_SOURCE_UNAVAILABLE = 'skill_source_unavailable';

/**
 * A skill's source could not supply it. `missing` means the source answered
 * and the skill is not there (a 404, or a ClawHub entry with nothing
 * published); otherwise the source could not be reached or read. Routes map
 * the two to a 404 and a 502, never a 500: neither is our server failing.
 * (#2189: 1,655 of 1,659 built-in catalog entries point at a GitHub repository
 * that went 404 in May 2026, and every import of one returned a 500.)
 */
class SkillSourceUnavailableError extends Error {
  readonly code = SKILL_SOURCE_UNAVAILABLE;

  readonly missing: boolean;

  constructor(reason: string, missing: boolean) {
    super(`skill source unavailable: ${reason}`);
    this.name = 'SkillSourceUnavailableError';
    this.missing = missing;
  }
}

export const isSkillSourceUnavailable = (error: unknown): error is { missing: boolean; message: string } => (
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === SKILL_SOURCE_UNAVAILABLE
);

/** A 404 or 410 means the source is there and the skill is not. */
const unavailableForStatus = (where: string, status: number): SkillSourceUnavailableError => (
  new SkillSourceUnavailableError(`${where} returned ${status}`, status === 404 || status === 410)
);

interface SkillFile {
  path: string;
  content: string;
}

interface FetchDirectoryOptions {
  maxFiles?: number;
  maxBytes?: number;
}

interface GitHubSourceInfo {
  owner: string;
  repo: string;
  branch: string;
  path: string;
  mode: string;
}

const resolveCatalogPath = (source: string): string | null => {
  if (source === DEFAULT_SOURCE) {
    if (process.env.SKILLS_CATALOG_PATH) {
      return process.env.SKILLS_CATALOG_PATH;
    }
    if (process.env.SKILLS_CATALOG_DIR) {
      return path.join(process.env.SKILLS_CATALOG_DIR, 'awesome-agent-skills-index.json');
    }
    return path.resolve(__dirname, '../../docs/skills/awesome-agent-skills-index.json');
  }
  return null;
};

// In-memory catalog cache — re-reads whenever the file mtime changes so the
// refresh scheduler can write a new copy without the server needing a restart.
interface CacheEntry {
  mtimeMs: number;
  catalog: Catalog;
  upstreamRefreshedAt: string | null;
  localRefreshedAt: string | null;
}
const catalogCache = new Map<string, CacheEntry>();

export const invalidateCache = (source?: string): void => {
  if (source) {
    catalogCache.delete(source);
    return;
  }
  catalogCache.clear();
};

export const loadCatalog = (source = DEFAULT_SOURCE): Catalog => {
  const catalogPath = resolveCatalogPath(source);
  if (!catalogPath) {
    return { source, updatedAt: null, items: [] };
  }
  if (!fs.existsSync(catalogPath)) {
    return { source, updatedAt: null, items: [] };
  }
  try {
    const stat = fs.statSync(catalogPath);
    const cached = catalogCache.get(source);
    if (cached && cached.mtimeMs === stat.mtimeMs) {
      return cached.catalog;
    }
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const items = Array.isArray(parsed.items) ? parsed.items as SkillItem[] : [];
    const catalog: Catalog = {
      source,
      updatedAt: (parsed.updatedAt as string) || null,
      items,
    };
    catalogCache.set(source, {
      mtimeMs: stat.mtimeMs,
      catalog,
      upstreamRefreshedAt: (parsed.upstreamRefreshedAt as string) || null,
      localRefreshedAt: (parsed.localRefreshedAt as string) || null,
    });
    return catalog;
  } catch (error) {
    // FAIL LOUD. `{ items: [] }` is exactly what a legitimately empty catalog
    // returns (and what the two guards above return for "no path configured"
    // and "file absent"), so swallowing here answered `GET /api/skills/catalog`
    // with 200 "no skills" for an unreadable or malformed catalog file. The
    // route's existing catch turns this throw into a 500, which is the honest
    // answer: we do not know what skills exist.
    const message = (error as Error).message;
    console.error(`[skills-catalog] Failed to read ${catalogPath}:`, message);
    throw new Error(`skills catalog unreadable at ${catalogPath}: ${message}`);
  }
};

/**
 * Returns the ISO timestamps of the most recent local refresh and the
 * upstream JSON's own `updatedAt`. Used by the /catalog endpoint to power a
 * "Last updated X minutes ago" indicator on the frontend.
 */
export const getLastRefreshedAt = (source = DEFAULT_SOURCE): { localRefreshedAt: string | null; upstreamRefreshedAt: string | null } => {
  // Force a cache warm-up so we pick up the current on-disk values. This is a
  // best-effort refresh of a display timestamp, not the catalog read itself —
  // loadCatalog now throws on an unreadable file and that must surface from the
  // CATALOG call, not from here, or a broken file would be reported twice.
  try {
    loadCatalog(source);
  } catch {
    // already logged inside loadCatalog; fall through to whatever is cached
  }
  const cached = catalogCache.get(source);
  if (!cached) {
    return { localRefreshedAt: null, upstreamRefreshedAt: null };
  }
  return {
    localRefreshedAt: cached.localRefreshedAt,
    upstreamRefreshedAt: cached.upstreamRefreshedAt,
  };
};

const toRawGitHubUrl = (sourceUrl: string): string => {
  try {
    const url = new URL(sourceUrl);
    if (url.hostname !== 'github.com') return sourceUrl;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 5) return sourceUrl;
    const [owner, repo, mode, branch, ...rest] = parts;
    if (mode !== 'blob' && mode !== 'tree') return sourceUrl;
    const pathPart = rest.join('/');
    if (!pathPart) return sourceUrl;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${pathPart}`;
  } catch (error) {
    return sourceUrl;
  }
};

const parseGitHubSource = (sourceUrl: string): GitHubSourceInfo | null => {
  try {
    const url = new URL(sourceUrl);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.hostname === 'github.com') {
      if (parts.length < 5) return null;
      const [owner, repo, mode, branch, ...rest] = parts;
      if (mode !== 'blob' && mode !== 'tree') return null;
      const pathPart = rest.join('/');
      return {
        owner,
        repo,
        branch,
        path: pathPart,
        mode,
      };
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      if (parts.length < 4) return null;
      const [owner, repo, branch, ...rest] = parts;
      const pathPart = rest.join('/');
      return {
        owner,
        repo,
        branch,
        path: pathPart,
        mode: 'raw',
      };
    }
    return null;
  } catch (error) {
    return null;
  }
};

const allowedExtensions = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.js', '.ts', '.tsx',
  '.py', '.sh', '.bash', '.zsh', '.yml', '.yaml', '.toml', '.env',
  '.sql', '.css', '.html', '.csv', '.ini',
]);

const shouldIncludeFile = (pathName: string): boolean => {
  const lower = pathName.toLowerCase();
  if (lower.endsWith('/skill.md') || lower.endsWith('/skill.md'.toLowerCase())) return false;
  const idx = lower.lastIndexOf('.');
  if (idx === -1) return false;
  return allowedExtensions.has(lower.slice(idx));
};

const fetchJson = async (url: string): Promise<unknown> => {
  const response = await fetchTextFromAllowedHost(url, {
    allowedOrigins: SKILL_SOURCE_ORIGINS,
    maxBytes: GITHUB_LISTING_MAX_BYTES,
    headers: {
      'User-Agent': 'commonly-app',
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch (${response.status})`);
  }
  return JSON.parse(response.text);
};

export const fetchSkillDirectoryFiles = async (sourceUrl: string, options: FetchDirectoryOptions = {}): Promise<SkillFile[]> => {
  const parsed = parseGitHubSource(sourceUrl);
  if (!parsed) return [];

  const { owner, repo, branch } = parsed;
  let dirPath = parsed.path || '';
  if (dirPath.endsWith('SKILL.md')) {
    dirPath = dirPath.replace(/\/?SKILL\.md$/i, '');
  }
  if (!dirPath) return [];

  const maxFiles = options.maxFiles || 50;
  const maxBytes = options.maxBytes || 200_000;
  let totalBytes = 0;
  const files: SkillFile[] = [];

  const walk = async (currentPath: string): Promise<void> => {
    if (files.length >= maxFiles || totalBytes >= maxBytes) return;
    const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${currentPath}?ref=${branch}`;
    const listing = await fetchJson(apiUrl);
    if (!Array.isArray(listing)) return;
    for (const item of listing as Array<Record<string, unknown>>) {
      if (files.length >= maxFiles || totalBytes >= maxBytes) break;
      if (item.type === 'dir') {
        await walk(String(item.path));
        continue;
      }
      if (item.type !== 'file') continue;
      if (!item.path || !item.download_url) continue;
      if (!shouldIncludeFile(String(item.path))) continue;
      if (item.size && Number(item.size) > maxBytes) continue;
      // The remaining budget is the body cap, so a file that would overrun it
      // ends the walk (as the `totalBytes > maxBytes` break below always did)
      // without first being read into memory whole.
      const resp = await fetchTextFromAllowedHost(String(item.download_url), {
        allowedOrigins: SKILL_SOURCE_ORIGINS,
        maxBytes: maxBytes - totalBytes,
      });
      if (!resp.ok) continue;
      const content = resp.text;
      totalBytes += content.length;
      if (totalBytes > maxBytes) break;
      files.push({
        path: String(item.path).replace(new RegExp(`^${dirPath}/?`), ''),
        content,
      });
    }
  };

  try {
    await walk(dirPath);
  } catch (error) {
    console.warn('[skills-catalog] Failed to fetch extra files:', (error as Error).message);
  }

  return files;
};

// ClawHub — public skills registry (clawhub.ai). The OG `github.com/openclaw/skills`
// repo went 404 in early May 2026, but the same skills are served by ClawHub
// at canonical URLs:
//   GET /api/skill?owner=<owner>&slug=<slug>          → metadata JSON (incl. latestVersion.version)
//   GET /api/v1/download?slug=<slug>&version=<v>      → ZIP bundle (SKILL.md + sub-files)
//
// We use this both to recover dead catalog entries (presetSkillsAutoImport
// rewrites openclaw/skills URLs to ClawHub fetches) and for any future
// "import skill by clawhub:<owner>/<slug>" CLI flow.
const CLAWHUB_BASE = 'https://clawhub.ai';
const DEAD_GITHUB_OPENCLAW_RE = /^https?:\/\/github\.com\/openclaw\/skills\/(?:tree|blob)\/[^/]+\/skills\/([^/]+)\/([^/]+)\/SKILL\.md\b/;

interface ClawHubBundle {
  content: string;
  extraFiles: SkillFile[];
  resolvedUrl: string;
  version: string;
}

const PER_FILE_BYTES = 100 * 1024;
const TOTAL_BUNDLE_BYTES = 800 * 1024;
// A request can reach ClawHub now (an import of a legacy catalog entry), so
// both calls carry the deadline and the download a size cap, as the GitHub
// path does through the fetch guard.
const CLAWHUB_TIMEOUT_MS = 15 * 1000;
const CLAWHUB_MAX_ZIP_BYTES = 2 * 1024 * 1024;

/**
 * Parse a legacy `github.com/openclaw/skills/tree/main/skills/<owner>/<slug>/SKILL.md`
 * URL into ClawHub's owner+slug coordinates. Returns null if the URL doesn't
 * match the dead pattern.
 */
export const parseLegacyOpenclawSkillsUrl = (sourceUrl: string): { owner: string; slug: string } | null => {
  if (!sourceUrl) return null;
  const m = DEAD_GITHUB_OPENCLAW_RE.exec(sourceUrl);
  return m ? { owner: m[1], slug: m[2] } : null;
};

/**
 * Resolve and download a skill from ClawHub. Returns the SKILL.md content +
 * any sub-files (sub-skills, references/, scripts/) up to size budgets.
 *
 * Note: the metadata endpoint requires `owner` to be passed; the download
 * endpoint only takes `slug` (slugs appear to be globally unique). If two
 * authors publish the same slug ClawHub presumably disambiguates server-side.
 */
export const fetchSkillBundleFromClawHub = async (
  owner: string,
  slug: string,
): Promise<ClawHubBundle> => {
  const safeOwner = encodeURIComponent(owner);
  const safeSlug = encodeURIComponent(slug);
  const signal = AbortSignal.timeout(CLAWHUB_TIMEOUT_MS);
  const reach = async (url: string): Promise<Response> => {
    try {
      return await fetch(url, { signal });
    } catch (error) {
      throw new SkillSourceUnavailableError(`ClawHub unreachable: ${(error as Error).message}`, false);
    }
  };

  // Step 1 — metadata (we need latestVersion.version for the download URL).
  const metaResp = await reach(`${CLAWHUB_BASE}/api/skill?owner=${safeOwner}&slug=${safeSlug}`);
  if (!metaResp.ok) {
    throw unavailableForStatus('ClawHub metadata', metaResp.status);
  }
  const meta = await metaResp.json();
  const version = meta?.latestVersion?.version;
  if (!version) {
    throw new SkillSourceUnavailableError('ClawHub has no published version', true);
  }

  // Step 2 — download zip.
  const dlResp = await reach(`${CLAWHUB_BASE}/api/v1/download?slug=${safeSlug}&version=${encodeURIComponent(version)}`);
  if (!dlResp.ok) {
    throw unavailableForStatus('ClawHub download', dlResp.status);
  }
  const declaredBytes = Number(dlResp.headers.get('content-length') || 0);
  if (declaredBytes > CLAWHUB_MAX_ZIP_BYTES) {
    throw new SkillSourceUnavailableError(`ClawHub bundle is ${declaredBytes} bytes`, false);
  }
  const ab = await dlResp.arrayBuffer();
  if (ab.byteLength > CLAWHUB_MAX_ZIP_BYTES) {
    throw new SkillSourceUnavailableError(`ClawHub bundle is ${ab.byteLength} bytes`, false);
  }
  const buf = Buffer.from(ab);

  // Step 3 — unzip. adm-zip is sync but bundles are tiny (<<100KB typical).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(buf);
  const entries = zip.getEntries();

  let content = '';
  const extraFiles: SkillFile[] = [];
  let totalBytes = 0;
  for (const e of entries) {
    if (e.isDirectory) continue;
    const name: string = e.entryName;
    // Skip dotfiles + LICENSE/README (parallel to bundled-skill collectExtraFiles).
    if (name.startsWith('.') || name.split('/').some((seg: string) => seg.startsWith('.'))) continue;
    if (name === 'LICENSE' || name === 'README.md') continue;
    if (e.header.size > PER_FILE_BYTES) continue;

    if (name === 'SKILL.md') {
      content = zip.readAsText(e);
      continue;
    }
    if (totalBytes + e.header.size > TOTAL_BUNDLE_BYTES) continue;
    extraFiles.push({ path: name, content: zip.readAsText(e) });
    totalBytes += e.header.size;
  }
  if (!content) {
    throw new SkillSourceUnavailableError('ClawHub bundle has no SKILL.md', true);
  }
  return {
    content,
    extraFiles,
    resolvedUrl: `clawhub:${owner}/${slug}@${version}`,
    version,
  };
};

export const fetchSkillContentFromSource = async (sourceUrl: string): Promise<FetchSkillContentResult> => {
  if (!sourceUrl) return { content: '', resolvedUrl: sourceUrl };
  // github.com/openclaw/skills is gone (404 since May 2026), and almost the
  // whole built-in catalog still points at it. The skills that are still
  // published live on ClawHub under the same owner and slug; the rest are a
  // `missing` answer, not a server error (#2189).
  const legacy = parseLegacyOpenclawSkillsUrl(sourceUrl);
  if (legacy) {
    const bundle = await fetchSkillBundleFromClawHub(legacy.owner, legacy.slug);
    return { content: bundle.content, resolvedUrl: bundle.resolvedUrl, extraFiles: bundle.extraFiles };
  }
  const resolvedUrl = toRawGitHubUrl(sourceUrl);
  let response;
  try {
    response = await fetchTextFromAllowedHost(resolvedUrl, {
      allowedOrigins: SKILL_SOURCE_ORIGINS,
      maxBytes: SKILL_FILE_MAX_BYTES,
    });
  } catch (error) {
    // A refusal stays a refusal (the routes answer 400). Anything else — the
    // deadline, the size cap, the network — is the source being unreadable.
    if (isOutboundUrlRefused(error)) throw error;
    throw new SkillSourceUnavailableError((error as Error).message, false);
  }
  if (!response.ok) {
    throw unavailableForStatus('skill source', response.status);
  }
  return { content: response.text, resolvedUrl };
};

export default {
  loadCatalog,
  fetchSkillContentFromSource,
  fetchSkillDirectoryFiles,
  fetchSkillBundleFromClawHub,
  parseLegacyOpenclawSkillsUrl,
  isSkillSourceUnavailable,
  getLastRefreshedAt,
  invalidateCache,
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
