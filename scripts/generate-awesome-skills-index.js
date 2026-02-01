#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const DEFAULT_SOURCE_URL = 'https://github.com/VoltAgent/awesome-agent-skills';
const DEFAULT_TIMEOUT_MS = 8000;

const getArg = (name, fallback = null) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((entry) => entry.startsWith(prefix));
  if (!arg) return fallback;
  return arg.slice(prefix.length).trim() || fallback;
};

const repoPath = getArg('repo') || process.env.AWESOME_AGENT_SKILLS_DIR;
const outputPath =
  getArg('out') ||
  path.resolve(__dirname, '../docs/skills/awesome-agent-skills-index.json');
const sourceUrl = getArg('source') || DEFAULT_SOURCE_URL;
const fetchLicenses = getArg('fetch-licenses', 'false') === 'true';
const githubToken = getArg('github-token') || process.env.GITHUB_TOKEN || null;
const maxConcurrent = Number(getArg('concurrency', '6')) || 6;
const timeoutMs = Number(getArg('timeout-ms', String(DEFAULT_TIMEOUT_MS))) || DEFAULT_TIMEOUT_MS;

if (!repoPath || !fs.existsSync(repoPath)) {
  console.error('Missing repo path. Use --repo=/path/to/awesome-agent-skills');
  process.exit(1);
}

const isFile = (filePath) => {
  try {
    return fs.statSync(filePath).isFile();
  } catch (err) {
    return false;
  }
};

const readFileSafe = (filePath) => {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return null;
  }
};

const parseFrontMatter = (text) => {
  if (!text || !text.startsWith('---')) return { body: text, data: {} };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { body: text, data: {} };
  const frontMatter = text.slice(3, end).trim();
  const body = text.slice(end + 4).trim();
  const data = {};

  frontMatter.split('\n').forEach((line) => {
    const [rawKey, ...rest] = line.split(':');
    if (!rawKey || rest.length === 0) return;
    const key = rawKey.trim();
    const value = rest.join(':').trim();
    if (!key) return;
    if (value.startsWith('[') && value.endsWith(']')) {
      data[key] = value
        .slice(1, -1)
        .split(',')
        .map((entry) => entry.replace(/['"]/g, '').trim())
        .filter(Boolean);
    } else {
      data[key] = value.replace(/['"]/g, '').trim();
    }
  });

  return { body, data };
};

const findLicense = (startDir) => {
  let current = startDir;
  while (current && current.length >= repoPath.length) {
    const licensePath = path.join(current, 'LICENSE');
    if (isFile(licensePath)) {
      return {
        path: path.relative(repoPath, licensePath),
        text: readFileSafe(licensePath),
      };
    }
    const licenseMdPath = path.join(current, 'LICENSE.md');
    if (isFile(licenseMdPath)) {
      return {
        path: path.relative(repoPath, licenseMdPath),
        text: readFileSafe(licenseMdPath),
      };
    }
    if (current === repoPath) break;
    current = path.dirname(current);
  }
  return null;
};

const toSourceUrl = (relativePath) => {
  const normalized = relativePath.replace(/\\/g, '/');
  return `${sourceUrl}/tree/main/${normalized}`;
};

const walkForSkills = (dir, results = []) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForSkills(fullPath, results);
    } else if (entry.isFile() && entry.name.toLowerCase() === 'skill.md') {
      results.push(fullPath);
    }
  }
  return results;
};

const parseReadmeSkills = (readmeText) => {
  if (!readmeText) return [];
  const lines = readmeText.split('\n');
  const items = [];

  const patterns = [
    /^\s*-\s+\*\*\[([^\]]+)\]\(([^)]+)\)\*\*\s*-\s*(.+)\s*$/,
    /^\s*-\s+\[([^\]]+)\]\(([^)]+)\)\s*-\s*(.+)\s*$/,
  ];

  lines.forEach((line) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (!match) continue;
      const name = match[1].trim();
      const url = match[2].trim();
      const description = match[3].trim();
      const vendor = name.includes('/') ? name.split('/')[0] : null;
      const tags = vendor ? [vendor] : [];
      items.push({
        id: name,
        name,
        description,
        tags,
        content: '',
        sourceUrl: url,
        license: null,
      });
      break;
    }
  });

  return items;
};

const parseGitHubRepo = (url) => {
  if (!url) return null;
  const match = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)(\/|$)/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
};

const fetchWithTimeout = async (url, options = {}) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return response;
  } finally {
    clearTimeout(timeout);
  }
};

const tryFetchLicense = async (owner, repo) => {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'COPYING', 'COPYING.md'];
  const branches = ['main', 'master'];
  for (const branch of branches) {
    for (const filename of candidates) {
      const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${filename}`;
      try {
        const res = await fetchWithTimeout(url, {
          headers: githubToken ? { Authorization: `Bearer ${githubToken}` } : undefined,
        });
        if (res.ok) {
          const text = await res.text();
          const name = text.split('\n')[0].trim() || filename;
          return { name, path: filename, text };
        }
      } catch (err) {
        // ignore and continue
      }
    }
  }
  return null;
};

const enrichLicenses = async (itemsList) => {
  const queue = itemsList.map((item) => ({ item }));
  let index = 0;
  const results = [...itemsList];

  const worker = async () => {
    while (index < queue.length) {
      const current = queue[index];
      index += 1;
      const repoInfo = parseGitHubRepo(current.item.sourceUrl);
      if (!repoInfo) continue;
      const license = await tryFetchLicense(repoInfo.owner, repoInfo.repo);
      if (license) {
        current.item.license = license;
      }
    }
  };

  const workers = Array.from({ length: maxConcurrent }, () => worker());
  await Promise.all(workers);
  return results;
};

const skillsRoot = fs.existsSync(path.join(repoPath, 'skills'))
  ? path.join(repoPath, 'skills')
  : repoPath;

const skillFiles = walkForSkills(skillsRoot);
let items = [];

if (skillFiles.length > 0) {
  items = skillFiles.map((skillPath) => {
    const raw = readFileSafe(skillPath) || '';
    const { data } = parseFrontMatter(raw);
    const relativePath = path.relative(repoPath, path.dirname(skillPath));
    const license = findLicense(path.dirname(skillPath));
    const name = data.name || path.basename(path.dirname(skillPath));
    const description = data.description || '';
    const tags = Array.isArray(data.tags) ? data.tags : [];

    return {
      id: relativePath.replace(/\\/g, '/'),
      name,
      description,
      tags,
      content: raw,
      sourceUrl: toSourceUrl(relativePath),
      license: license
        ? {
            name: license.text ? license.text.split('\n')[0].trim() : 'LICENSE',
            path: license.path,
            text: license.text,
          }
        : null,
    };
  });
} else {
  const readme = readFileSafe(path.join(repoPath, 'README.md'));
  items = parseReadmeSkills(readme);
}

const run = async () => {
  if (fetchLicenses && items.length > 0) {
    console.log(`Fetching licenses for ${items.length} skills...`);
    items = await enrichLicenses(items);
  }

  const output = {
    updatedAt: new Date().toISOString(),
    items,
  };

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log(`Wrote ${items.length} skills to ${outputPath}`);
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
