import fs from 'fs';
import path from 'path';

const DEFAULT_SOURCE = 'awesome';

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
}

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
    console.warn(`[skills-catalog] Failed to read ${catalogPath}:`, (error as Error).message);
    return { source, updatedAt: null, items: [] };
  }
};

/**
 * Returns the ISO timestamps of the most recent local refresh and the
 * upstream JSON's own `updatedAt`. Used by the /catalog endpoint to power a
 * "Last updated X minutes ago" indicator on the frontend.
 */
export const getLastRefreshedAt = (source = DEFAULT_SOURCE): { localRefreshedAt: string | null; upstreamRefreshedAt: string | null } => {
  // Force a cache warm-up so we pick up the current on-disk values.
  loadCatalog(source);
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
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'commonly-app',
      Accept: 'application/vnd.github.v3+json',
    },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch (${response.status})`);
  }
  return response.json();
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
      const resp = await fetch(String(item.download_url));
      if (!resp.ok) continue;
      const content = await resp.text();
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

  // Step 1 — metadata (we need latestVersion.version for the download URL).
  const metaResp = await fetch(`${CLAWHUB_BASE}/api/skill?owner=${safeOwner}&slug=${safeSlug}`);
  if (!metaResp.ok) {
    throw new Error(`ClawHub metadata fetch failed (${metaResp.status})`);
  }
  const meta = await metaResp.json();
  const version = meta?.latestVersion?.version;
  if (!version) {
    throw new Error('ClawHub metadata has no latestVersion.version');
  }

  // Step 2 — download zip.
  const dlResp = await fetch(`${CLAWHUB_BASE}/api/v1/download?slug=${safeSlug}&version=${encodeURIComponent(version)}`);
  if (!dlResp.ok) {
    throw new Error(`ClawHub download failed (${dlResp.status})`);
  }
  const ab = await dlResp.arrayBuffer();
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
    throw new Error('ClawHub zip had no SKILL.md');
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
  const resolvedUrl = toRawGitHubUrl(sourceUrl);
  if (!/^https?:\/\//i.test(resolvedUrl)) {
    throw new Error('Unsupported skill source URL.');
  }
  const response = await fetch(resolvedUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch skill content (${response.status}).`);
  }
  const content = await response.text();
  return { content, resolvedUrl };
};

export default {
  loadCatalog,
  fetchSkillContentFromSource,
  fetchSkillDirectoryFiles,
  fetchSkillBundleFromClawHub,
  parseLegacyOpenclawSkillsUrl,
  getLastRefreshedAt,
  invalidateCache,
};
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
