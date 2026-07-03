/**
 * Local skills import — the metadata half of "your agent arrives whole"
 * (retention plan Phase C, D3). Scans a local skills directory
 * (<cwd>/.claude/skills or ~/.claude/skills) for SKILL.md files, parses
 * NAME + DESCRIPTION out of the frontmatter, and registers agent-scoped
 * skill entries so the agent's profile shows what it can do.
 *
 * Deliberately metadata-only (plan D3): skill *content* stays on the
 * user's machine — local agents execute their skills locally, Commonly
 * doesn't need the body, and skill files can carry private material. The
 * uploaded SKILL.md is a frontmatter-only stub that says exactly that.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export const MAX_SKILLS = 50;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---/;

/** Parse `name:` and `description:` out of SKILL.md frontmatter. */
export const parseSkillMeta = (markdown, fallbackName) => {
  const fm = FRONTMATTER_RE.exec(markdown);
  if (!fm) return { name: fallbackName, description: '' };
  const fields = {};
  for (const line of fm[1].split(/\r?\n/)) {
    const m = /^(name|description):\s*(.+)$/.exec(line.trim());
    if (m && !fields[m[1]]) fields[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return {
    name: fields.name || fallbackName,
    description: (fields.description || '').slice(0, 500),
  };
};

/**
 * Find skill directories. Explicit dir wins; otherwise check the two
 * well-known locations. Each candidate is a directory whose subdirs
 * contain a SKILL.md.
 */
export const detectSkills = ({ cwd = process.cwd(), home = homedir(), explicitDir = null } = {}) => {
  const roots = [];
  if (explicitDir) {
    if (!existsSync(explicitDir) || !statSync(explicitDir).isDirectory()) {
      throw new Error(`No such directory: ${explicitDir}`);
    }
    roots.push(explicitDir);
  } else {
    for (const candidate of [join(cwd, '.claude', 'skills'), join(home, '.claude', 'skills')]) {
      try {
        if (existsSync(candidate) && statSync(candidate).isDirectory()) roots.push(candidate);
      } catch {
        // symlinked skill roots can dangle; skip quietly
      }
    }
  }

  const skills = [];
  const seen = new Set();
  for (const root of roots) {
    for (const entry of readdirSync(root).sort()) {
      const skillFile = join(root, entry, 'SKILL.md');
      try {
        if (!existsSync(skillFile) || !statSync(skillFile).isFile()) continue;
      } catch {
        continue;
      }
      const meta = parseSkillMeta(readFileSync(skillFile, 'utf8'), entry);
      if (seen.has(meta.name)) continue;
      seen.add(meta.name);
      skills.push({ ...meta, path: skillFile });
      if (skills.length >= MAX_SKILLS) return skills;
    }
  }
  return skills;
};

/** The frontmatter-only stub that gets uploaded in place of skill content. */
export const skillStub = ({ name, description }) => [
  '---',
  `name: ${name}`,
  `description: ${description || name}`,
  '---',
  '',
  'Imported as metadata from a local agent — the skill itself runs on the',
  "agent's own machine; its content was intentionally not uploaded.",
  '',
].join('\n');

/**
 * Register the skills as agent-scoped entries via POST /api/skills/import.
 * `client` must be authenticated as the USER (pod membership is checked),
 * not the agent runtime token.
 */
export const importSkills = async (client, { skills, podId, agentName, instanceId = 'default' }) => {
  const results = [];
  for (const skill of skills) {
    // eslint-disable-next-line no-await-in-loop
    await client.post('/api/skills/import', {
      podId,
      name: skill.name,
      content: skillStub(skill),
      description: skill.description || undefined,
      scope: 'agent',
      agentName,
      instanceId,
    });
    results.push(skill.name);
  }
  return { imported: results.length, names: results };
};
