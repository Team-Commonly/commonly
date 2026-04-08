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

export const loadCatalog = (source = DEFAULT_SOURCE): Catalog => {
  const catalogPath = resolveCatalogPath(source);
  if (!catalogPath) {
    return { source, updatedAt: null, items: [] };
  }
  if (!fs.existsSync(catalogPath)) {
    return { source, updatedAt: null, items: [] };
  }
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const items = Array.isArray(parsed.items) ? parsed.items as SkillItem[] : [];
    return {
      source,
      updatedAt: (parsed.updatedAt as string) || null,
      items,
    };
  } catch (error) {
    console.warn(`[skills-catalog] Failed to read ${catalogPath}:`, (error as Error).message);
    return { source, updatedAt: null, items: [] };
  }
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

export default { loadCatalog, fetchSkillContentFromSource, fetchSkillDirectoryFiles };
// CJS compat: let require() return the default export directly
// eslint-disable-next-line @typescript-eslint/no-require-imports
module.exports = exports["default"]; Object.assign(module.exports, exports);
