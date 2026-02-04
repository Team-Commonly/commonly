const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE = 'awesome';

const resolveCatalogPath = (source) => {
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

const loadCatalog = (source = DEFAULT_SOURCE) => {
  const catalogPath = resolveCatalogPath(source);
  if (!catalogPath) {
    return { source, updatedAt: null, items: [] };
  }
  if (!fs.existsSync(catalogPath)) {
    return { source, updatedAt: null, items: [] };
  }
  try {
    const raw = fs.readFileSync(catalogPath, 'utf8');
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    return {
      source,
      updatedAt: parsed.updatedAt || null,
      items,
    };
  } catch (error) {
    console.warn(`[skills-catalog] Failed to read ${catalogPath}:`, error.message);
    return { source, updatedAt: null, items: [] };
  }
};

const toRawGitHubUrl = (sourceUrl) => {
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

const fetchSkillContentFromSource = async (sourceUrl) => {
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

module.exports = {
  loadCatalog,
  fetchSkillContentFromSource,
};
