/**
 * Agent Environment resolver — ADR-008 Phase 1.
 *
 * An environment.yaml/.json file is the user-authored, driver-neutral spec for
 * how an agent's runtime should be shaped: workspace path, sandbox mode, the
 * Claude skills to mount, the MCP servers to expose. This module is the
 * adapter-facing read-side: parse, validate, and realize the workspace +
 * skill links on disk. Sandbox argv wrapping lives in `./sandbox/bwrap.js`
 * because it is per-driver (Linux-only, bwrap-specific).
 *
 * Zero runtime deps: Node 20 has no built-in YAML, so we accept JSON only and
 * surface a clear error on .yaml/.yml inputs (per task brief). When a future
 * Node version exposes `node:yaml` natively, parseEnvironmentFile is the one
 * place to add a `.yaml` branch — the rest of the module is parser-agnostic.
 */

import { readFile, mkdir, symlink, lstat, readlink, cp } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, isAbsolute, join, resolve as pathResolve, basename } from 'path';
import { homedir } from 'os';

// ── Schema — keep the allow-list narrow; ADR-008 §invariants #1+#2 ──────────
//
// Deliberate omission: the env file's directory (needed to resolve `seed` and
// relative skill paths) is NOT stored on the returned spec. Leaking the user's
// absolute filesystem path into `config.environment` sent to the backend
// exposes `$HOME` layout for zero server-side benefit. Callers pass
// `envFileDir` as a separate argument to resolveWorkspace / linkSkills.

const ALLOWED_TOP_KEYS = new Set([
  'version', 'workspace', 'sandbox', 'skills', 'mcp',
]);
const ALLOWED_SANDBOX_MODES = new Set(['none', 'bwrap', 'firejail', 'container', 'managed']);
const ALLOWED_NETWORK_POLICIES = new Set(['unrestricted', 'restricted']);

const expandHome = (p) => {
  if (!p || typeof p !== 'string') return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/')) return join(homedir(), p.slice(2));
  return p;
};

// ── parseEnvironmentFile ────────────────────────────────────────────────────

/**
 * Read and parse the env file. Accepts JSON only in Phase 1 — .yaml/.yml
 * inputs fail with a specific error pointing the user at JSON, so we never
 * silently misread a YAML file as JSON.
 */
export const parseEnvironmentFile = async (absolutePath) => {
  if (!isAbsolute(absolutePath)) {
    throw new Error(`parseEnvironmentFile requires an absolute path, got: ${absolutePath}`);
  }
  if (!existsSync(absolutePath)) {
    throw new Error(`Environment file not found: ${absolutePath}`);
  }

  const lower = absolutePath.toLowerCase();
  if (lower.endsWith('.yaml') || lower.endsWith('.yml')) {
    throw new Error(
      `YAML environment files are not supported in Phase 1 — Node 20 has no `
      + `built-in YAML parser and we keep zero runtime deps. Convert ${absolutePath} `
      + `to JSON (same shape) and pass that instead.`,
    );
  }

  const raw = await readFile(absolutePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse environment file ${absolutePath}: ${err.message}`);
  }

  const validation = validateEnvironmentSpec(parsed);
  if (!validation.ok) {
    throw new Error(
      `Invalid environment spec in ${absolutePath}:\n  - ${validation.errors.join('\n  - ')}`,
    );
  }

  // Return the bare spec — no envFileDir wrapping, no underscore-prefixed
  // annotations. The caller is responsible for tracking envFileDir separately
  // (compute via `dirname(envPath)`) and passing it explicitly to
  // resolveWorkspace / linkSkills when relative paths in the spec need to
  // resolve. This keeps the spec safe to serialize and ship to the backend
  // (`config.environment` on AgentInstallation) without leaking $HOME layout.
  return parsed;
};

// ── validateEnvironmentSpec ─────────────────────────────────────────────────

export const validateEnvironmentSpec = (spec) => {
  const errors = [];

  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    return { ok: false, errors: ['env spec must be a JSON object'] };
  }

  for (const key of Object.keys(spec)) {
    if (!ALLOWED_TOP_KEYS.has(key)) {
      errors.push(`unknown top-level key: "${key}" (allowed: ${[...ALLOWED_TOP_KEYS].join(', ')})`);
    }
  }

  if (spec.version !== undefined && spec.version !== 1) {
    errors.push(`version must be 1, got ${JSON.stringify(spec.version)}`);
  }

  if (spec.workspace !== undefined) {
    if (typeof spec.workspace !== 'object' || spec.workspace === null) {
      errors.push('workspace must be an object');
    } else {
      if (spec.workspace.path !== undefined && typeof spec.workspace.path !== 'string') {
        errors.push('workspace.path must be a string');
      }
      if (spec.workspace.seed !== undefined) {
        if (!Array.isArray(spec.workspace.seed)
          || !spec.workspace.seed.every((s) => typeof s === 'string')) {
          errors.push('workspace.seed must be an array of strings');
        }
      }
    }
  }

  if (spec.sandbox !== undefined) {
    if (typeof spec.sandbox !== 'object' || spec.sandbox === null) {
      errors.push('sandbox must be an object');
    } else {
      const { mode, network, filesystem } = spec.sandbox;
      if (mode !== undefined && !ALLOWED_SANDBOX_MODES.has(mode)) {
        errors.push(`sandbox.mode must be one of: ${[...ALLOWED_SANDBOX_MODES].join(', ')}`);
      }
      if (network !== undefined) {
        if (typeof network !== 'object' || network === null) {
          errors.push('sandbox.network must be an object');
        } else {
          if (network.policy !== undefined && !ALLOWED_NETWORK_POLICIES.has(network.policy)) {
            errors.push(`sandbox.network.policy must be one of: ${[...ALLOWED_NETWORK_POLICIES].join(', ')}`);
          }
          if (network['allow-hosts'] !== undefined
            && (!Array.isArray(network['allow-hosts'])
              || !network['allow-hosts'].every((h) => typeof h === 'string'))) {
            errors.push('sandbox.network.allow-hosts must be an array of strings');
          }
        }
      }
      if (filesystem !== undefined) {
        if (typeof filesystem !== 'object' || filesystem === null) {
          errors.push('sandbox.filesystem must be an object');
        } else {
          for (const f of ['read-outside', 'write-outside']) {
            if (filesystem[f] !== undefined
              && (!Array.isArray(filesystem[f])
                || !filesystem[f].every((p) => typeof p === 'string'))) {
              errors.push(`sandbox.filesystem.${f} must be an array of strings`);
            }
          }
        }
      }
    }
  }

  if (spec.skills !== undefined) {
    if (typeof spec.skills !== 'object' || spec.skills === null) {
      errors.push('skills must be an object');
    } else {
      if (spec.skills.claude !== undefined
        && (!Array.isArray(spec.skills.claude)
          || !spec.skills.claude.every((p) => typeof p === 'string'))) {
        errors.push('skills.claude must be an array of strings');
      }
      if (spec.skills.commonly !== undefined
        && (!Array.isArray(spec.skills.commonly)
          || !spec.skills.commonly.every((p) => typeof p === 'string'))) {
        errors.push('skills.commonly must be an array of strings');
      }
    }
  }

  if (spec.mcp !== undefined) {
    if (!Array.isArray(spec.mcp)) {
      errors.push('mcp must be an array');
    } else {
      spec.mcp.forEach((server, i) => {
        if (!server || typeof server !== 'object' || Array.isArray(server)) {
          errors.push(`mcp[${i}] must be an object`);
          return;
        }
        if (typeof server.name !== 'string' || !server.name) {
          errors.push(`mcp[${i}].name is required and must be a non-empty string`);
        }
        if (server.transport !== undefined
          && !['http', 'stdio', 'sse'].includes(server.transport)) {
          errors.push(`mcp[${i}].transport must be one of: http, stdio, sse`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
};

// ── resolveWorkspace ────────────────────────────────────────────────────────

/**
 * Compute the workspace path and ensure it exists. On first creation, copy
 * any `workspace.seed` paths in. Returns `{ path, created }` so the caller
 * can log the outcome and (in the future) gate one-time setup.
 *
 * `envFileDir` is the directory of the env file (used to resolve relative
 * seed paths). Required when `workspace.seed` contains relative entries;
 * ignored otherwise.
 */
export const resolveWorkspace = async (spec, agentName, envFileDir = null) => {
  if (!agentName) throw new Error('resolveWorkspace requires agentName');
  const declared = spec?.workspace?.path;
  const path = expandHome(declared) || join(homedir(), '.commonly', 'workspaces', agentName);
  const absPath = isAbsolute(path) ? path : pathResolve(path);

  const created = !existsSync(absPath);
  await mkdir(absPath, { recursive: true });

  if (created && Array.isArray(spec?.workspace?.seed)) {
    for (const entry of spec.workspace.seed) {
      const src = isAbsolute(entry)
        ? entry
        : (envFileDir ? pathResolve(envFileDir, entry) : pathResolve(entry));
      if (!existsSync(src)) {
        throw new Error(`workspace.seed entry not found: ${src}`);
      }
      const dest = join(absPath, basename(src));
      // eslint-disable-next-line no-await-in-loop
      await cp(src, dest, { recursive: true, force: false, errorOnExist: false });
    }
  }

  return { path: absPath, created };
};

// ── linkSkills ──────────────────────────────────────────────────────────────

/**
 * Symlink each `skills.claude[]` source path into `<workspacePath>/.claude/skills/`.
 *
 * Idempotent: if a symlink already points at the declared source, it is
 * counted in `skipped` and left in place. If a DIFFERENT file or symlink
 * occupies the slot, it is recorded in `conflicted` with a reason — never
 * overwritten (a user-edited skill in the workspace must not be clobbered).
 * Missing source paths are also reported in `conflicted` so the caller can
 * surface them.
 *
 * `envFileDir` is the directory of the env file (used to resolve relative
 * skill paths). Optional — when omitted, relative paths fall back to
 * `workspacePath`. Pass it from `performAttach` for attach-time resolution
 * matching the env file's location.
 *
 * Returns `{ linked, skipped, conflicted }`:
 *   - `linked`:     string[]            — newly created symlinks (absolute source paths)
 *   - `skipped`:    string[]            — already correctly linked (no-op)
 *   - `conflicted`: Array<{path, reason}> where reason ∈
 *       'different-target' | 'not-symlink' | 'missing-source'
 */
export const linkSkills = async (spec, workspacePath, envFileDir = null) => {
  const sources = Array.isArray(spec?.skills?.claude) ? spec.skills.claude : [];
  const linked = [];
  const skipped = [];
  const conflicted = [];
  if (sources.length === 0) return { linked, skipped, conflicted };

  const skillsDir = join(workspacePath, '.claude', 'skills');
  await mkdir(skillsDir, { recursive: true });

  for (const rawSource of sources) {
    const source = expandHome(rawSource);
    const absSource = isAbsolute(source)
      ? source
      : pathResolve(envFileDir || workspacePath, source);
    if (!existsSync(absSource)) {
      conflicted.push({ path: absSource, reason: 'missing-source' });
      continue;
    }
    const linkPath = join(skillsDir, basename(absSource));

    let existingTarget = null;
    let slotIsNonSymlink = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      const stat = await lstat(linkPath);
      if (stat.isSymbolicLink()) {
        // eslint-disable-next-line no-await-in-loop
        existingTarget = await readlink(linkPath);
      } else {
        slotIsNonSymlink = true;
      }
    } catch (err) {
      // Only ENOENT means "slot is free, proceed." EACCES / EPERM / EIO are
      // real failures that should surface — without this narrowing the
      // subsequent symlink() call fails with a confusing follow-on error.
      if (err.code !== 'ENOENT') throw err;
    }

    if (slotIsNonSymlink) {
      conflicted.push({ path: absSource, reason: 'not-symlink' });
      continue;
    }

    if (existingTarget) {
      const resolvedExisting = isAbsolute(existingTarget)
        ? existingTarget
        : pathResolve(skillsDir, existingTarget);
      if (resolvedExisting === absSource) {
        skipped.push(absSource);
        continue;
      }
      conflicted.push({ path: absSource, reason: 'different-target' });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    await symlink(absSource, linkPath);
    linked.push(absSource);
  }

  return { linked, skipped, conflicted };
};
