/**
 * Local memory import — Phase C of the retention plan ("your agent arrives
 * whole"). Detects the memory a local agent already has on this machine
 * (project CLAUDE.md / MEMORY.md, Claude Code's per-project auto-memory
 * directory), composes it into one document, and promotes it into the
 * kernel envelope's `long_term` section via POST /memory/sync.
 *
 * Design constraints:
 *   - Explicitly opt-in with preview (plan D3) — local memory files can
 *     contain private material; callers must confirm before anything is
 *     sent. This module only detects/composes/sends; the command layer
 *     owns the prompt.
 *   - APPEND, never clobber: `mode: 'patch'` replaces a section wholesale
 *     (mergePatchSections is section-level), so we read the existing
 *     long_term and append the import after it.
 *   - Server stamps byteSize/updatedAt/schemaVersion (ADR-003 invariant
 *     #9); we send content + visibility only.
 */

import { existsSync, readFileSync, readdirSync, statSync, realpathSync } from 'fs';
import { homedir } from 'os';
import { join, basename } from 'path';

export const SOURCE_RUNTIME = 'import-local';

// Envelope sections are curated context, not dumps. The auto-clearer story
// on the agent side starts caring around 400KB of session; a quarter of
// that is a generous ceiling for a one-shot import.
export const MAX_IMPORT_BYTES = 256 * 1024;

// Claude Code keeps per-project auto-memory under
// ~/.claude/projects/<slug>/memory where <slug> is the project path with
// every '/' replaced by '-'.
export const claudeProjectMemoryDir = (cwd, home) => join(
  home,
  '.claude',
  'projects',
  cwd.replaceAll('/', '-'),
  'memory',
);

const fileCandidate = (path, label) => {
  if (!existsSync(path)) return null;
  const stat = statSync(path);
  if (!stat.isFile() || stat.size === 0) return null;
  return { path, label, bytes: stat.size };
};

/**
 * Find importable memory sources. An explicit path wins outright (file, or
 * directory whose *.md files are all taken); otherwise auto-detect the
 * well-known locations. Duplicates are collapsed by realpath — this repo,
 * for instance, symlinks AGENTS.md → CLAUDE.md.
 */
export const detectMemorySources = ({
  cwd = process.cwd(),
  home = homedir(),
  explicitPath = null,
} = {}) => {
  const candidates = [];

  if (explicitPath) {
    if (!existsSync(explicitPath)) {
      throw new Error(`No such file or directory: ${explicitPath}`);
    }
    if (statSync(explicitPath).isDirectory()) {
      for (const f of readdirSync(explicitPath).filter((n) => n.endsWith('.md')).sort()) {
        const c = fileCandidate(join(explicitPath, f), `from ${basename(explicitPath)}/`);
        if (c) candidates.push(c);
      }
      if (!candidates.length) {
        throw new Error(`No .md files found in ${explicitPath}`);
      }
    } else {
      const c = fileCandidate(explicitPath, 'explicit');
      if (!c) throw new Error(`${explicitPath} is empty or not a regular file`);
      candidates.push(c);
    }
  } else {
    const projectInstructions = fileCandidate(join(cwd, 'CLAUDE.md'), 'project instructions');
    if (projectInstructions) candidates.push(projectInstructions);
    const agentsMd = fileCandidate(join(cwd, 'AGENTS.md'), 'project instructions');
    if (agentsMd) candidates.push(agentsMd);
    const projectMemory = fileCandidate(join(cwd, 'MEMORY.md'), 'project memory');
    if (projectMemory) candidates.push(projectMemory);

    const memDir = claudeProjectMemoryDir(cwd, home);
    if (existsSync(memDir) && statSync(memDir).isDirectory()) {
      for (const f of readdirSync(memDir).filter((n) => n.endsWith('.md')).sort()) {
        const c = fileCandidate(join(memDir, f), 'auto-memory');
        if (c) candidates.push(c);
      }
    }
  }

  // Collapse symlink duplicates (first mention wins its label).
  const seen = new Set();
  return candidates.filter((c) => {
    let real;
    try {
      real = realpathSync(c.path);
    } catch {
      real = c.path;
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
};

/** Compose the sources into one markdown document with per-file provenance. */
export const composeImport = (sources) => {
  if (!sources.length) throw new Error('Nothing to import');
  const total = sources.reduce((n, s) => n + s.bytes, 0);
  if (total > MAX_IMPORT_BYTES) {
    throw new Error(
      `Import is ${Math.round(total / 1024)}KB — over the ${MAX_IMPORT_BYTES / 1024}KB ceiling. `
      + 'Pass an explicit --path to a smaller file, or trim the sources.',
    );
  }
  const parts = sources.map((s) => {
    const content = readFileSync(s.path, 'utf8').trim();
    return `## Imported: ${basename(s.path)} (${s.label})\n\n${content}`;
  });
  return `# Imported local memory\n\n${parts.join('\n\n---\n\n')}`;
};

/**
 * Promote the composed document into the agent's long_term section,
 * appending after any existing content. `client` is an api.js client
 * authenticated with the agent's runtime token.
 */
export const importMemory = async (client, { sources }) => {
  const imported = composeImport(sources);

  let existing = '';
  try {
    const body = await client.get('/api/agents/runtime/memory');
    existing = body?.sections?.long_term?.content || '';
  } catch (err) {
    // Fresh agents 404 — that's the common case. Anything else should stop
    // the import: appending to memory we couldn't read risks clobbering it.
    if (err?.status && err.status !== 404) throw err;
  }

  const content = existing ? `${existing.trimEnd()}\n\n${imported}` : imported;
  await client.post('/api/agents/runtime/memory/sync', {
    mode: 'patch',
    sourceRuntime: SOURCE_RUNTIME,
    sections: {
      long_term: { content, visibility: 'private' },
    },
  });

  return { files: sources.length, bytes: content.length, appended: Boolean(existing) };
};
