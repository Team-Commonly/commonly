import { observeSpawn, controlsFromArguments } from '../runtime-observation.js';
/**
 * OpenCode adapter — wraps `opencode run --format json` as a Commonly seat.
 *
 * Smoke-tested versions are recorded in TESTED_OPENCODE_VERSIONS below.
 * OpenCode stores sessions under XDG_DATA_HOME. Trusted seats use the
 * operator's data home directly; public seats get per-identity state without
 * operator auth.json and a child environment limited to safe launch/locale
 * variables. Public provider keys
 * stay in the host adapter and reach the configured provider through a
 * per-spawn loopback proxy; OpenCode receives only that proxy's bearer.
 * This protects the key, not provider spend: the model can use its seat's key
 * budget. On Linux the process has its own network namespace, with loopback
 * bridges to the fixed provider and Commonly instance origins.
 * Config is generated per spawn. OpenCode merges config sources, therefore the
 * global config directory is isolated and project config is explicitly off;
 * the environment spec is the sole source of MCP servers for this run.
 *
 * OpenCode's JSON stream carries `sessionID` on step_start, final text in
 * `text.part.text`, and token counts in `step_finish.part.tokens`.
 */

import { requireSeatModel, seatModelRequired } from './seat-model.js';
import { isPatchAfterNewestTested } from './tested-version.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readdirSync, realpathSync, rmSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  unlink,
  symlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { fileURLToPath } from 'url';
import {
  dirname, isAbsolute, join, relative, resolve as pathResolve,
} from 'path';
import { writeCredentialFile } from '../credential-file.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn, publicMcpUnavailableError, selectedMcpVersionDir } from '../mcp-home.js';
import { buildMemoryPreamble } from '../memory-bridge.js';
import {
  isLegacySandboxTrust,
  normalizeSandboxTrust,
  refuseWorkspaceTrust,
  validateEnvironmentSpec,
} from '../environment.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';
import { detectBwrap, wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import { wrapArgvWithSeatbelt } from '../sandbox/seatbelt.js';
import { resolvePublicSandboxMode } from '../sandbox/mode.js';
import { resolveProviderKeyFile, startProviderProxy } from '../provider-proxy.js';
import { isShippedCommonlyMcpCommand } from '../declared-mcp-guard.js';
import { isAnswerableToolError, PUBLIC_TOOL_FAILED_CODE } from '../public-tool-error.js';
import { startInstanceProxy } from '../instance-proxy.js';
import { PUBLIC_SEAT_WITHHELD_TOOLS } from '../public-withheld-tools.js';

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const ISOLATED_PROXY_PORT = 8765;
const ISOLATED_INSTANCE_PORT = 8766;
const LOOPBACK_BRIDGE = fileURLToPath(new URL('../sandbox/opencode-loopback.mjs', import.meta.url));
const TERMINATION_GRACE_MS = 5000;
// Bump only with a passing real sandbox-exec smoke against the new version.
const TESTED_OPENCODE_VERSIONS = Object.freeze(['1.18.35', '1.19.0', '1.19.4']);
const ALLOW_UNTESTED_OPENCODE_VERSION_ENV = 'COMMONLY_OPENCODE_ALLOW_UNTESTED_VERSION';
const VERSION_CHECK_TIMEOUT_MS = 5000;
const OPENCODE_CONFIG_GITIGNORE = [
  'node_modules',
  'package.json',
  'package-lock.json',
  'bun.lock',
  '.gitignore',
].join('\n');
const DISABLED_ENV = [
  'OPENCODE_DISABLE_CLAUDE_CODE',
  'OPENCODE_DISABLE_CLAUDE_CODE_PROMPT',
  'OPENCODE_DISABLE_CLAUDE_CODE_SKILLS',
  'OPENCODE_DISABLE_EXTERNAL_SKILLS',
  'OPENCODE_DISABLE_DEFAULT_PLUGINS',
  'OPENCODE_DISABLE_AUTOUPDATE',
];
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;
const SPAWN_ROOT_DENY = '**/commonly-opencode-*/**';
const PUBLIC_READ_DENIES = [
  '**/.commonly/**',
  '**/.codex/**',
  '**/.env',
  '**/*.env',
  '**/.env.*',
  '**/*.env.*',
  // Every per-spawn root (mkdtemp `commonly-opencode-`), by name: OpenCode's
  // older tools compare paths as text without following symlinks, so a
  // workspace link to the temp root would otherwise reach the credential.
  SPAWN_ROOT_DENY,
];
// `.git` (a directory, or a linked worktree's file): its config can widen the
// project (`core.worktree`, Opus review #3487) or run code (`core.fsmonitor`).
const PUBLIC_EDIT_DENIES = [
  ...PUBLIC_READ_DENIES, '**/.npmrc', '**/.yarnrc*', '.git', '.git/**', '**/.git', '**/.git/**',
];
const PUBLIC_SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

// `realpathSync.native` (realpath(3)) returns the on-disk spelling, case
// included, on a case-insensitive APFS volume; the JS realpath keeps the case
// it was given, so `/PRIVATE/...` would not compare equal to `/private/...`.
const canonicalPath = (path) => realpathSync.native(path);

const realOrSelf = (path) => {
  try {
    return canonicalPath(path);
  } catch {
    return path;
  }
};

const isWithin = (parent, child) => {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/**
 * F175a: what hides a public seat's per-spawn files (the credential file the
 * grant broker's bearer names, the provider-proxy token) from OpenCode's own
 * read, glob, grep and lsp tools is OpenCode's permission layer, not the jail:
 * OpenCode itself must read the credential to expand `{file:}`, so Seatbelt and
 * bwrap both admit the spawn root. Those tools read anything under `--dir`
 * without asking and ask `external_directory` (denied here) for anything else
 * (Tool.assertExternalDirectory, OpenCode 1.19.4). So the spawn root must lie
 * OUTSIDE the workspace, or the deny never fires. Compared both as written and
 * resolved, since macOS spells the temp root two ways (/var and /private/var).
 */
/**
 * The nearest ancestor of `dir` (itself included) holding a `.git` entry, by a
 * plain filesystem walk. OpenCode counts the whole git worktree as inside the
 * project (Instance.containsPath), so its tools reach it without asking
 * external_directory, exactly as they reach --dir.
 */
const gitToplevel = (dir) => {
  let current = dir;
  for (;;) {
    if (existsSync(join(current, '.git'))) return current;
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
};

const GIT_TOPLEVEL_TIMEOUT_MS = 5000;

// Round 8 (#3487): OpenCode matches permission patterns case-sensitively and
// APFS does not, so `.GIT/config` slips past the `.git` edit deny. Config from
// the environment outranks the repo's own, however the path was spelled, so a
// public seat's git (OpenCode's and this adapter's check alike) runs no
// fsmonitor and no hook. Added after the public env filter, which drops every
// GIT_* the launcher had.
const PUBLIC_GIT_ENV = Object.freeze({
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'core.fsmonitor',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'core.hooksPath',
  GIT_CONFIG_VALUE_1: '/dev/null',
});

/**
 * The worktree git reports for the repo whose `.git` sits in `holder`, the way
 * OpenCode 1.19.4 computes `Instance.worktree` (GitV2 `Git.repo.discover`: find
 * `.git` upward, then `git rev-parse --show-toplevel` with that folder as cwd,
 * falling back to the folder itself when git fails). `env` is the seat's own
 * child environment, so both read the same config. Returns `{ top }`,
 * `{ notRepo: true }` when git finds no repository there (OpenCode then has no
 * worktree beyond --dir), or `{ error }`.
 */
const gitReportedWorktree = (holder, env) => {
  const run = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd: holder, env, encoding: 'utf8', timeout: GIT_TOPLEVEL_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (run.error) return { error: run.error.code || run.error.message };
  const stderr = String(run.stderr || '').trim();
  if (run.status !== 0) {
    if (/not a git repository/i.test(stderr)) return { notRepo: true };
    return { error: `exit ${run.status}${stderr ? `: ${stderr.slice(0, 200)}` : ''}` };
  }
  const text = String(run.stdout || '').trim();
  return text ? { top: pathResolve(holder, text) } : { error: 'empty output' };
};

// Bounds for the pre-spawn symlink walk. Reaching either one leaves the
// workspace unproven, and a seat carrying the grant broker then refuses
// (`assertSpawnRootOutsideWorkspace`), so the depth sits well above real source
// trees: it guards against a pathological tree, not an ordinary one.
const SYMLINK_WALK_BOUNDS = Object.freeze({ maxDepth: 32, maxEntries: 20000 });
// CodeRabbit round 4 (#3487): a grant-bearing spawn also walks every
// node_modules tree, links only, under its own bound. Measured 2026-11-05 on
// this repo's backend/node_modules: 44,664 entries, 63 symlinks (none leaving
// the workspace), 0.5-1.4 s on a host at load average ~90.
const DEPENDENCY_WALK_BOUNDS = Object.freeze({ maxDepth: 64, maxEntries: 200000 });
const SYMLINK_WALK_SKIP = new Set(['.git']);
const DEPENDENCY_DIR = 'node_modules';

/**
 * Scan `workspace` for a symlink OpenCode's tools could follow to the per-spawn
 * credential directory. Measured in OpenCode 1.19.4: `grep` and `glob` judge
 * only their argument (the regex, the glob) against permission rules and check
 * the search PATH as text through external_directory, so `grep` with
 * `path: <workspace link to the temp root>` searches the credential's contents
 * with nothing asked. This walk is what stops that, not a permission pattern.
 *
 * Returns `{ link, reason }` for the first offending link, `{ incomplete }` when
 * a bound stopped the walk before it saw the whole tree, or null.
 * - `reaches_spawn_root`: the link's target holds or lies inside `spawnRoot`.
 *   A dangling link (an old spawn root, since removed) can't, and is skipped.
 * - `outside_workspace`: a link AT a node_modules top level (or under an
 *   @scope there) leading out of `boundary`. node_modules is not walked into,
 *   since a typical one exhausts the entry bound on every spawn; its packages'
 *   links are installed by the package manager inside it, while a top-level
 *   link out (`npm link`, a `file:` dependency) reaches a tree this walk never
 *   read.
 *
 * `deepDependencies` (a spawn that hands its credential to a remote server):
 * every workspace link is held to `boundary` as well, and every node_modules tree, nested ones and @scopes included, is walked too,
 * links only, under `dependencyBounds`, its own budget. A link anywhere in it
 * that reaches the spawn root, or that leaves `boundary`, is refused, since a
 * package tarball or postinstall script can plant `dist/x -> /tmp`, or a chain
 * through a directory outside (CodeRabbit #3487). Nothing is followed, and
 * only a symlink costs a realpath; a regular entry costs its dirent. A stopped
 * walk reports `{ incomplete: 'dependency_entries' | 'dependency_depth' }`.
 * The same mode walks every `.git` directory links-only, and treats what it
 * cannot see as unproven (Opus review, #3487): a directory it cannot list
 * (`incomplete: 'unreadable'`; a 0111 directory is still traversable by the
 * OS) or a link realpath cannot resolve for a reason other than a missing
 * target (`incomplete: 'unresolvable'`, a loop say), each with `problem:
 * { path, code }`. `root` is where the walk starts: the git worktree root for a
 * grant seat, since OpenCode's tools reach the whole worktree.
 */
const scanWorkspaceLinks = (workspace, spawnRoot, {
  boundary = workspace,
  root = workspace,
  bounds = SYMLINK_WALK_BOUNDS,
  deepDependencies = false,
  dependencyBounds = DEPENDENCY_WALK_BOUNDS,
} = {}) => {
  const target = realOrSelf(spawnRoot);
  const inside = realOrSelf(boundary);
  let budget = bounds.maxEntries;
  let dependencyBudget = dependencyBounds.maxEntries;
  let incomplete = null;
  let problem = null;
  // A missing path (a dangling link, a directory removed mid-walk) is no route.
  const ABSENT = new Set(['ENOENT', 'ENOTDIR']);
  const unproven = (kind, path, err) => {
    if (ABSENT.has(err?.code) || !deepDependencies) return;
    incomplete = incomplete || kind;
    problem = problem || { path, code: err?.code || String(err) };
  };
  const linkFinding = (path, { dependencyTop }) => {
    let resolved;
    try {
      resolved = canonicalPath(path);
    } catch (err) {
      unproven('unresolvable', path, err);
      return null;
    }
    if (isWithin(resolved, target) || isWithin(target, resolved)) return { link: path, reason: 'reaches_spawn_root' };
    if (dependencyTop && !isWithin(inside, resolved)) return { link: path, reason: 'outside_workspace' };
    return null;
  };
  const readEntries = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      unproven('unreadable', dir, err);
      return [];
    }
  };
  // The top level of a node_modules, and of each @scope in it: links checked,
  // nothing descended into.
  const scanDependencyTop = (dir, { scoped = false } = {}) => {
    const entries = readEntries(dir);
    if (incomplete) return null;
    for (const entry of entries) {
      budget -= 1;
      if (budget < 0) {
        incomplete = incomplete || 'entries';
        return null;
      }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const hit = linkFinding(path, { dependencyTop: true });
        if (hit || incomplete) return hit;
      } else if (!scoped && entry.isDirectory() && entry.name.startsWith('@')) {
        const hit = scanDependencyTop(path, { scoped: true });
        if (hit || incomplete) return hit;
      }
    }
    return null;
  };
  // Every entry under one node_modules, iteratively: a link is resolved and
  // judged, never descended into; a real directory is queued. The node_modules
  // directory itself is level 1. A deep link is held to the top-level rule:
  // one leaving `boundary` is refused, since a path argument resolves a chain
  // (node_modules/x/y -> /outside/dir/y -> /tmp) in a tree never read.
  const scanDependencyTree = (modulesDir) => {
    const stack = [[modulesDir, 1]];
    while (stack.length) {
      const [dir, depth] = stack.pop();
      if (depth > dependencyBounds.maxDepth) {
        incomplete = incomplete || 'dependency_depth';
        return null;
      }
      const entries = readEntries(dir);
      if (incomplete) return null;
      for (const entry of entries) {
        dependencyBudget -= 1;
        if (dependencyBudget < 0) {
          incomplete = incomplete || 'dependency_entries';
          return null;
        }
        const path = join(dir, entry.name);
        if (entry.isSymbolicLink()) {
          const hit = linkFinding(path, { dependencyTop: true });
          if (hit || incomplete) return hit;
        } else if (entry.isDirectory()) {
          stack.push([path, depth + 1]);
        }
      }
    }
    return null;
  };
  const walk = (dir, depth) => {
    if (depth > bounds.maxDepth) {
      incomplete = incomplete || 'depth';
      return null;
    }
    const entries = readEntries(dir);
    if (incomplete) return null;
    for (const entry of entries) {
      budget -= 1;
      if (budget < 0) {
        incomplete = incomplete || 'entries';
        return null;
      }
      const path = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // A grant seat holds every workspace link to the boundary: a chain
        // through a tree outside it (src/vendor -> /outside, a node_modules
        // that is itself a link) is resolved by the OS, unread by this walk.
        const hit = linkFinding(path, { dependencyTop: deepDependencies });
        if (hit || incomplete) return hit;
      } else if (entry.isDirectory() && entry.name === DEPENDENCY_DIR) {
        const hit = scanDependencyTop(path) || (!incomplete && deepDependencies ? scanDependencyTree(path) : null);
        if (hit || incomplete) return hit;
      } else if (deepDependencies && entry.isDirectory() && SYMLINK_WALK_SKIP.has(entry.name)) {
        // `.git` on a grant seat: links only, under the dependency budget
        // (8,243 entries in this repo's own checkout, no links).
        const hit = scanDependencyTree(path);
        if (hit || incomplete) return hit;
      } else if (entry.isDirectory() && !SYMLINK_WALK_SKIP.has(entry.name)) {
        const hit = walk(path, depth + 1);
        if (hit || incomplete) return hit;
      }
    }
    return null;
  };
  const hit = walk(pathResolve(root), 0);
  if (hit) return hit;
  if (!incomplete) return null;
  return problem ? { incomplete, problem } : { incomplete };
};

/**
 * Refuse a public seat whose workspace lets OpenCode's tools reach the
 * per-spawn credential directory. `carriesGrant` says whether this spawn hands
 * its credential file to a remote MCP server (buildMcpConfig's report, the
 * grant broker among them): a walk stopped by its bound refuses only then,
 * since a huge monorepo should not be refused when there is no grant to protect.
 */
const assertSpawnRootOutsideWorkspace = (workspace, spawnRoot, {
  carriesGrant = false,
  bounds = SYMLINK_WALK_BOUNDS,
  dependencyBounds = DEPENDENCY_WALK_BOUNDS,
  gitEnv = null,
} = {}) => {
  if (typeof workspace !== 'string' || !workspace) return;
  const pairs = [[pathResolve(workspace), spawnRoot], [realOrSelf(workspace), realOrSelf(spawnRoot)]];
  if (pairs.some(([parent, child]) => isWithin(parent, child))) {
    throw new Error(
      `public OpenCode agents refuse a workspace (${workspace}) that contains the per-spawn credential directory `
      + `(${spawnRoot}): OpenCode's tools could read the credential there; choose a workspace outside the temp directory`,
    );
  }
  // Containment first: a real repo holding the spawn root also trips the
  // core.worktree check below, whose message would blame a setting that isn't
  // there (CI #3487).
  const toplevels = pairs
    .map(([parent, child]) => [gitToplevel(parent), child])
    .filter(([top]) => top);
  const hit = toplevels.find(([top, child]) => isWithin(top, child));
  if (hit) {
    throw new Error(
      `public OpenCode agents refuse a workspace (${workspace}) whose git worktree (${hit[0]}) contains the per-spawn `
      + `credential directory (${spawnRoot}): OpenCode's tools could read the credential there; `
      + 'choose a workspace outside that repository or set TMPDIR outside it',
    );
  }
  // Opus review round 7 (#3487): the folder holding .git is the boundary only
  // while git agrees. `core.worktree` makes `--show-toplevel` (OpenCode's
  // worktree) name any folder, $TMPDIR and every spawn root included.
  if (gitEnv) {
    const holders = [...new Set(pairs.map(([parent]) => gitToplevel(parent)).filter(Boolean))];
    for (const holder of holders) {
      const reported = gitReportedWorktree(holder, gitEnv);
      if (reported.error) {
        // A git that cannot answer (missing, timed out, failing) leaves the
        // boundary a guess; no public seat runs on one (round 8, #3487).
        throw new Error(
          `public OpenCode agents could not confirm the git worktree of the workspace (${workspace}): `
          + `git rev-parse --show-toplevel in ${holder} failed (${reported.error}); `
          + 'make git available to the seat, or choose a workspace outside a git repository',
        );
      }
      if (!reported.top) continue;
      const top = realOrSelf(reported.top);
      const widened = top !== realOrSelf(holder);
      if (widened || isWithin(top, realOrSelf(spawnRoot)) || isWithin(top, realOrSelf(tmpdir()))) {
        throw new Error(
          `public OpenCode agents refuse a workspace (${workspace}) whose git reports the worktree as ${reported.top}, `
          + `not ${holder}, the folder holding .git: OpenCode's tools reach the whole of that worktree, which a `
          + 'core.worktree setting can widen to the temp directory and the per-spawn credential; remove the setting',
        );
      }
    }
  }
  // OpenCode counts the whole git worktree as inside the project, so a
  // node_modules link into it is not a link out.
  const boundary = toplevels[0]?.[0] || gitToplevel(pathResolve(workspace)) || workspace;
  // A grant seat walks the whole worktree OpenCode's tools can reach, sibling
  // packages and .git included (Opus review, #3487); a seat without one, its
  // workspace.
  const finding = scanWorkspaceLinks(workspace, spawnRoot, {
    boundary,
    root: carriesGrant ? realOrSelf(boundary) : workspace,
    bounds,
    deepDependencies: carriesGrant,
    dependencyBounds,
  });
  if (finding?.incomplete === 'unreadable' || finding?.incomplete === 'unresolvable') {
    const { path, code } = finding.problem;
    throw new Error(
      `public OpenCode agents could not ${finding.incomplete === 'unreadable' ? 'list the directory' : 'resolve the symlink'} `
      + `${path} (${code}) while checking the workspace (${workspace}) for symlinks to the per-spawn credential directory; `
      + 'what the walk cannot see is not proven clean, and this seat carries a connector grant; fix its permissions, '
      + 'remove it, or drop the grant broker from this seat',
    );
  }
  if (finding?.reason === 'reaches_spawn_root') {
    throw new Error(
      `public OpenCode agents refuse a workspace (${workspace}) holding a symlink (${finding.link}) that reaches the per-spawn `
      + `credential directory (${spawnRoot}): OpenCode's tools could read the credential through it; remove the link`,
    );
  }
  if (finding?.reason === 'outside_workspace') {
    throw new Error(
      `public OpenCode agents refuse a workspace (${workspace}) holding a symlink (${finding.link}) that leads outside `
      + 'the workspace, into a tree not checked for links to the per-spawn credential directory; '
      + 'move the seat to a workspace without links that leave it, or remove the link',
    );
  }
  if (finding?.incomplete?.startsWith('dependency_')) {
    throw new Error(
      `public OpenCode agents could not finish checking the workspace's node_modules and .git trees (${workspace}) for symlinks `
      + `to the per-spawn credential directory: the link walk stopped at its ${finding.incomplete === 'dependency_depth'
        ? `depth bound (${dependencyBounds.maxDepth} levels)` : `entry bound (${dependencyBounds.maxEntries} entries)`}, `
      + 'and this seat carries a connector grant; prune the dependency tree, or drop the grant broker from this seat',
    );
  }
  if (finding?.incomplete && carriesGrant) {
    throw new Error(
      `public OpenCode agents could not finish checking the workspace (${workspace}) for symlinks to the per-spawn `
      + `credential directory: the walk stopped at its ${finding.incomplete === 'depth'
        ? `depth bound (${bounds.maxDepth} levels)` : `entry bound (${bounds.maxEntries} entries)`}, and this seat `
      + 'carries a connector grant; choose a smaller workspace, or drop the grant broker from this seat',
    );
  }
};

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

const substitutePublicPlaceholders = (value, ctx) => {
  if (typeof value !== 'string' || !value.includes('${COMMONLY_')) return value;
  const replacements = {
    COMMONLY_TOKEN_FILE: ctx.credentialFile || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
  };
  return value.replace(PLACEHOLDER_RE, (whole, key) => replacements[key] || whole);
};

const isSafeMcpName = (name) => typeof name === 'string'
  && /^[A-Za-z0-9_-]+$/.test(name);

const permissionMcpName = (name) => name.replace(/[^A-Za-z0-9_]/g, '_');

const buildMcpConfig = (servers, ctx = {}) => {
  const mcp = {};
  const runtimeToken = typeof ctx.runtimeToken === 'string' ? ctx.runtimeToken : '';
  for (const server of servers || []) {
    if (!isSafeMcpName(server?.name)) continue;
    const transport = typeof server.transport === 'string'
      ? server.transport.trim().toLowerCase()
      : 'stdio';

    if (transport === 'stdio') {
      if (!Array.isArray(server.command) || server.command.length === 0) continue;
      const command = prepareMcpSpawn(server.command, {
        apiUrl: ctx.instanceUrl, publicSeat: ctx.publicSeat,
      });
      if (!command) {
        ctx.unavailableMcp?.push(server.name);
        continue;
      }
      if (runtimeToken && command.some((part) => typeof part === 'string' && part.includes(runtimeToken))) {
        // A bearer token in argv is readable by same-user processes.
        // eslint-disable-next-line no-console
        console.warn(`[opencode] skipping MCP server ${server.name}: seat credentials cannot be passed in argv`);
        continue;
      }
      const delivery = deliverSeatCredential({ ...server, command }, {
        credentialFile: ctx.credentialFile,
        label: 'opencode',
      });
      const env = {};
      let unsupportedCredential = false;
      for (const [key, rawValue] of Object.entries(delivery.env)) {
        if (typeof rawValue !== 'string') continue;
        if (rawValue.includes('${COMMONLY_AGENT_TOKEN}')
          && delivery.delivered !== 'path') {
          unsupportedCredential = true;
          break;
        }
        const value = substitutePublicPlaceholders(rawValue, ctx);
        if (runtimeToken && value.includes(runtimeToken)) {
          unsupportedCredential = true;
          break;
        }
        env[key] = value;
      }
      if (unsupportedCredential) {
        // eslint-disable-next-line no-console
        console.warn(`[opencode] skipping MCP server ${server.name}: its credential declaration has no file-backed delivery`);
        continue;
      }
      mcp[server.name] = {
        type: 'local',
        command: command.map((part) => substitutePublicPlaceholders(part, ctx)),
        enabled: true,
        ...(Object.keys(env).length ? { environment: env } : {}),
        ...(typeof server.cwd === 'string' ? { cwd: server.cwd } : {}),
      };
      const versionDir = ctx.publicSeat && selectedMcpVersionDir(command);
      if (versionDir) ctx.mcpReadDirectories?.push(versionDir);
      continue;
    }

    if (transport !== 'http' || typeof server.url !== 'string') continue;
    if (server.url.includes('${COMMONLY_AGENT_TOKEN}')) continue;
    const url = substitutePublicPlaceholders(server.url, ctx);
    // Runtime credentials only travel through OpenCode's measured {file:}
    // header expansion, never as environment values or literal config text.
    if (runtimeToken && url.includes(runtimeToken)) continue;
    const headers = {};
    let unsupportedCredential = false;
    for (const [key, rawValue] of Object.entries(server.headers || {})) {
      if (typeof rawValue !== 'string') continue;
      let value = substitutePublicPlaceholders(rawValue, ctx);
      if (rawValue.includes('${COMMONLY_AGENT_TOKEN}')) {
        if (key.toLowerCase() !== 'authorization'
          || rawValue !== 'Bearer ${COMMONLY_AGENT_TOKEN}'
          || !ctx.credentialFile) {
          unsupportedCredential = true;
          break;
        }
        value = `Bearer {file:${ctx.credentialFile}}`;
      }
      if (runtimeToken && value.includes(runtimeToken)) {
        unsupportedCredential = true;
        break;
      }
      headers[key] = value;
    }
    if (unsupportedCredential) {
      // eslint-disable-next-line no-console
      console.warn(`[opencode] skipping MCP server ${server.name}: remote credentials must use the bearer file channel`);
      continue;
    }
    mcp[server.name] = {
      type: 'remote',
      url,
      enabled: true,
      ...(Object.keys(headers).length ? { headers } : {}),
    };
    // What delivered the credential file to a remote server, whatever its URL:
    // the spawn's grant checks read this, not a guess at which entry is the
    // broker (CodeRabbit #3487).
    if (Object.values(headers).some((value) => value.includes(`{file:${ctx.credentialFile}}`))) {
      ctx.bearerFileServers?.push(server.name);
    }
  }
  return mcp;
};

const publicPermissions = (mode, mcpNames) => {
  const read = { '*': 'allow' };
  const edit = { '*': mode === 'read-only' ? 'deny' : 'allow' };
  for (const pattern of PUBLIC_READ_DENIES) {
    read[pattern] = 'deny';
  }
  for (const pattern of PUBLIC_EDIT_DENIES) edit[pattern] = 'deny';
  // The spawn-folder rule on the search tools. OpenCode 1.19.4 matches these
  // against the tool's own argument (the glob string, the grep regex), not the
  // searched path or the results, and ships no `list` tool, so this stops only
  // a search that names the folder; scanWorkspaceLinks stops one through a link.
  const search = () => ({ '*': 'allow', [SPAWN_ROOT_DENY]: 'deny' });
  return {
    '*': 'deny',
    read,
    edit,
    glob: search(),
    grep: search(),
    list: search(),
    bash: 'deny',
    task: 'deny',
    external_directory: 'deny',
    question: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
    skill: 'deny',
    todowrite: 'allow',
    todoread: 'allow',
    lsp: 'allow',
    ...Object.fromEntries(mcpNames.map((name) => [`${permissionMcpName(name)}_*`, 'allow'])),
    // After the wildcard allow, since the last matching rule wins
    // (public-withheld-tools.js; self-install and memory writes, F118).
    ...Object.fromEntries(mcpNames.flatMap((name) => PUBLIC_SEAT_WITHHELD_TOOLS
      .map((tool) => [`${permissionMcpName(name)}_${tool}`, 'deny']))),
  };
};

const buildArgs = ({ prompt, sessionId, cwd, model, effort, title }) => ([
  '--pure',
  'run',
  '--format', 'json',
  ...(sessionId ? ['-s', String(sessionId)] : []),
  ...(model ? ['-m', String(model)] : []),
  ...(effort ? ['--variant', String(effort)] : []),
  ...(cwd ? ['--dir', cwd] : []),
  ...(title ? ['--title', String(title)] : []),
  prompt,
]);

const qualifiedProviderModel = (provider, model) => (
  provider ? `${provider.id}/${model}` : model
);

const buildProviderConfig = (provider, model, keyFile) => {
  if (!provider) return undefined;
  if (!model) throw new Error('OpenCode provider configuration requires environment.model');
  // OpenCode 1.18.35 resolves {file:} in provider options, but failed before
  // making a request when the selected id was absent from provider.models.
  const models = { ...(provider.models || {}) };
  const selectedModel = models[model];
  if (!selectedModel) {
    models[model] = { name: model };
  } else if (typeof selectedModel.name !== 'string' || !selectedModel.name) {
    models[model] = { ...selectedModel, name: model };
  }
  // anthropic-messages: provider.baseURL is the host (as for Claude Code's
  // ANTHROPIC_BASE_URL); @ai-sdk/anthropic appends /messages to a /v1 base.
  const anthropic = provider.api === 'anthropic-messages';
  return {
    [provider.id]: {
      npm: anthropic ? '@ai-sdk/anthropic' : '@ai-sdk/openai-compatible',
      options: {
        baseURL: anthropic ? `${provider.baseURL.replace(/\/+$/, '')}/v1` : provider.baseURL,
        apiKey: `{file:${keyFile}}`,
      },
      models,
    },
  };
};

const validateProviderEnvironment = async (environment, workspacePath) => {
  if (environment?.provider === undefined) return null;
  const validation = validateEnvironmentSpec({
    provider: environment.provider,
    model: environment.model,
  });
  if (!validation.ok) {
    throw new Error(`Invalid OpenCode provider configuration: ${validation.errors.join('; ')}`);
  }
  return resolveProviderKeyFile(environment.provider, workspacePath);
};

const STALE_SESSION_PATTERN = /session not found/i;
// Set by runOpenCode only when the rejected run produced no turn output, so a
// phrase that shows up after the model acted cannot replay the turn.
const isStaleSessionError = (err) => err?.staleSession === true;

const makeEventParser = () => {
  let buffer = '';
  let sessionId = null;
  let text = '';
  let usage = null;
  let errorMessage = null;
  // Any text, tool call or step result means the model acted this run.
  let turnOutput = false;
  let stepStarted = false;
  // Every tool call that came back as an error, for the public-seat check in
  // spawn (publicToolFailure).
  const toolErrors = [];
  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.sessionID) sessionId = event.sessionID;
      // Any step event means the run started a turn, so it is not safe to replay.
      if (String(event.type || '').startsWith('step_') || event.type === 'tool_use') turnOutput = true;
      if (event.type === 'step_start') stepStarted = true;
      if (event.type === 'text' && typeof event.part?.text === 'string') {
        turnOutput = true;
        text += event.part.text;
      } else if (event.type === 'step_finish' && event.part?.tokens) {
        usage = event.part.tokens;
      }
      if (event.type === 'tool_use' && event.part?.state?.status === 'error') {
        const { error } = event.part.state;
        toolErrors.push({
          tool: String(event.part.tool || ''),
          error: typeof error === 'string' ? error : JSON.stringify(error ?? ''),
        });
      } else if (event.type === 'error') {
        errorMessage = event.error?.data?.message || event.error?.message || 'OpenCode turn failed';
      }
    } catch {
      // JSONL stdout should be parseable. Ignore an unrelated line rather than
      // turning a useful final text event into an adapter failure.
    }
  };
  return {
    get turnOutput() { return turnOutput; },
    get stepStarted() { return stepStarted; },
    consume(chunk) {
      buffer += chunk.toString();
      let newline;
      // eslint-disable-next-line no-cond-assign
      while ((newline = buffer.indexOf('\n')) !== -1) {
        consumeLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
    },
    flush() {
      consumeLine(buffer);
      buffer = '';
    },
    get sessionId() { return sessionId; },
    get text() { return text; },
    get usage() { return usage; },
    get errorMessage() { return errorMessage; },
    get toolErrors() { return toolErrors; },
  };
};

// A public seat must never show a stranger its own plumbing. When a Commonly
// tool can't reach the API, the model is left narrating the failure, and the
// run loop posted that narration: on 2026-10-21 a canary of Commonly HQ's
// support seat (this adapter, its prompt, an unreachable API) told the asker
// "every Commonly tool call (`list_pods`, `list_artifacts`) is returning
// `fetch failed`", and an instruction to answer NO_REPLY in that case held in
// only 1 of 3 turns. So the turn is withheld here instead: nothing is posted,
// and the run loop keeps the event unacked for its retry.
//
// OpenCode names an MCP tool `<server>_<tool>`, and a failed call reports
// `state.status: 'error'` with the message in `state.error` (measured on
// OpenCode 1.19.0). Only tools of the declared Commonly server count. Of
// those, only the errors `isAnswerableToolError` names (an API refusal the
// person can be told about, or a schema mistake the model fixes) leave the
// turn to be posted; any other failure withholds it. This adapter-level check
// stays beside the adapter-agnostic readiness witness (TASK-256): it sees the
// runtime's own view of each call, and the witness sees a server that never
// started, so each catches what the other cannot.
export { PUBLIC_TOOL_FAILED_CODE };

export const publicToolFailure = (toolErrors, mcpServers) => {
  const prefixes = (Array.isArray(mcpServers) ? mcpServers : [])
    .filter((server) => server?.name && isShippedCommonlyMcpCommand(server.command))
    .map((server) => `${server.name}_`);
  if (!prefixes.length) return null;
  return (toolErrors || []).find(({ tool, error }) => (
    prefixes.some((prefix) => tool.startsWith(prefix)) && !isAnswerableToolError(error)
  )) || null;
};

const publicToolFailedError = ({ tool, error }) => {
  const reason = String(error).replace(/\s+/g, ' ').slice(0, 160) || '(empty error)';
  const failure = new Error(
    `public seat withheld this turn's reply: Commonly tool ${tool} failed in a way the model must not narrate `
    + `(${reason}), so nothing was posted and the event stays unacked for retry`,
  );
  failure.code = PUBLIC_TOOL_FAILED_CODE;
  return failure;
};

const runOpenCode = ({
  cmd, args, cwd, env, timeoutMs, credentials, spawnImpl = childSpawn, onSpawn, controls = {}, onFirstStep,
}) => new Promise((resolve, reject) => {
  let proc;
  try {
    proc = spawnImpl(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    reject(err);
    return;
  }
  observeSpawn(proc, onSpawn, controls);
  let stderr = '';
  let timedOut = false;
  let killTimer = null;
  const events = makeEventParser();
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => proc.kill('SIGKILL'), TERMINATION_GRACE_MS);
  }, timeoutMs);
  const clearTimers = () => {
    clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  };
  let stepSeen = false;
  let stepHookError = null;
  proc.stdout?.on('data', (chunk) => {
    events.consume(chunk);
    if (!stepSeen && events.stepStarted) {
      stepSeen = true;
      // Synchronous, in the same tick the event is parsed, so the gap before
      // the model's first tool call is as short as this process can make it.
      // A hook that throws ends the turn: the child is killed, and the error
      // is the turn's result.
      try {
        onFirstStep?.();
      } catch (err) {
        stepHookError = err;
        proc.kill('SIGKILL');
      }
    }
  });
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => {
    clearTimers();
    reject(err);
  });
  proc.on('close', (code) => {
    clearTimers();
    events.flush();
    if (stepHookError) return reject(stepHookError);
    if (timedOut) return reject(new Error(`opencode timed out after ${timeoutMs}ms`));
    if (events.errorMessage) {
      const err = adapterFailure('opencode turn failed', events.errorMessage, {
        credentials, limit: 2000,
      });
      err.staleSession = !events.turnOutput && STALE_SESSION_PATTERN.test(events.errorMessage);
      return reject(err);
    }
    if (code !== 0) {
      const err = adapterFailure('opencode', stderr.trim(), {
        credentials, exitCode: code, limit: 500,
      });
      err.staleSession = !events.turnOutput && STALE_SESSION_PATTERN.test(stderr);
      return reject(err);
    }
    resolve({
      sessionId: events.sessionId, text: events.text, usage: events.usage, toolErrors: events.toolErrors,
    });
  });
});

const seatIdentity = (ctx) => [
  ctx.agentName || 'agent',
  ctx.metadata?.event?.podId || 'default-pod',
].join('\0');

const prepareOpenCodeDataHome = async (ctx, { publicSeat = false } = {}) => {
  const operatorDataHome = ctx.env?.XDG_DATA_HOME
    || process.env.XDG_DATA_HOME
    || join(homedir(), '.local', 'share');
  if (!publicSeat) {
    return {
      root: null,
      appData: null,
      dataHome: ctx.env?.XDG_DATA_HOME || process.env.XDG_DATA_HOME || null,
      authPath: null,
    };
  }
  const identity = createHash('sha256').update(seatIdentity(ctx)).digest('hex').slice(0, 24);
  const root = ctx._opencodeHomeRoot || join(homedir(), '.commonly', 'opencode-homes', identity);
  const operatorAppData = join(pathResolve(operatorDataHome), 'opencode');
  if (pathResolve(root) === pathResolve(operatorAppData)) {
    throw new Error('OpenCode seat data must be isolated from the operator OpenCode data directory');
  }
  const rootStat = await statOrNull(root);
  if (rootStat && (!rootStat.isDirectory() || rootStat.isSymbolicLink())) {
    throw new Error(`refusing non-directory OpenCode seat state: ${root}`);
  }
  const dataHome = join(root, 'data');
  const appData = join(dataHome, 'opencode');
  await mkdir(appData, { recursive: true, mode: 0o700 });
  for (const path of [dataHome, appData]) {
    const pathStat = await statOrNull(path);
    if (!pathStat?.isDirectory() || pathStat.isSymbolicLink()) {
      throw new Error(`refusing non-directory OpenCode seat state: ${path}`);
    }
  }
  await chmod(root, 0o700);
  await chmod(dataHome, 0o700);
  await chmod(appData, 0o700);

  const sourceAuth = join(operatorAppData, 'auth.json');
  const targetAuth = join(appData, 'auth.json');
  if (publicSeat) {
    // A public model must never inherit the operator's OpenCode login. The
    // provider proxy is the only supported credential path for public seats.
    const targetStat = await statOrNull(targetAuth);
    if (targetStat && !targetStat.isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink OpenCode seat credential: ${targetAuth}`);
    }
    if (targetStat) await unlink(targetAuth);
    return {
      root,
      appData,
      dataHome,
      authPath: null,
    };
  }
  const sourceStat = await statOrNull(sourceAuth);
  const targetStat = await statOrNull(targetAuth);
  const authPath = sourceStat ? realpathSync(sourceAuth) : null;
  const resolvedSourceStat = authPath ? await statOrNull(authPath) : null;
  if (sourceStat && (!resolvedSourceStat?.isFile() || resolvedSourceStat.isSymbolicLink())) {
    throw new Error(`refusing non-regular operator OpenCode credential: ${sourceAuth}`);
  }
  if (targetStat && !targetStat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-symlink OpenCode seat credential: ${targetAuth}`);
  }
  if (sourceStat) {
    const currentTarget = targetStat
      ? pathResolve(dirname(targetAuth), await readlink(targetAuth))
      : null;
    if (currentTarget !== pathResolve(authPath)) {
      if (targetStat) await unlink(targetAuth);
      await symlink(authPath, targetAuth);
    }
  } else if (targetStat) {
    await unlink(targetAuth);
  }
  return { root, appData, dataHome, authPath };
};

const sourceAuthEnvNames = (env) => Object.keys(env || {}).filter((name) => (
  /(?:^|_)(?:API_KEY|ACCESS_TOKEN|ACCESS_KEY|CLIENT_SECRET|PASSWORD|TOKEN|SECRET)$/i.test(name)
));

const makeChildEnvironment = ({
  source,
  tempDir,
  configPath,
  configDir,
  dataHome,
  stateHome,
  cacheHome,
  home,
  tempWork,
  credentialFile,
  publicSeat = false,
}) => {
  const env = { ...source };
  // A parent launcher may itself have received injected OpenCode config. These
  // higher-precedence values must not be inherited into a seat spawn.
  for (const key of [
    'OPENCODE_CONFIG_CONTENT', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR',
    'OPENCODE_TUI_CONFIG', 'OPENCODE_AUTO_SHARE',
  ]) delete env[key];
  env.OPENCODE_CONFIG = configPath;
  env.OPENCODE_CONFIG_DIR = configDir;
  env.OPENCODE_DISABLE_PROJECT_CONFIG = '1';
  env.XDG_CONFIG_HOME = join(tempDir, 'xdg-config');
  if (dataHome) env.XDG_DATA_HOME = dataHome;
  else delete env.XDG_DATA_HOME;
  if (stateHome) env.XDG_STATE_HOME = stateHome;
  if (cacheHome) env.XDG_CACHE_HOME = cacheHome;
  if (home) env.HOME = home;
  env.TMPDIR = tempWork;
  env.OPENCODE_AUTO_SHARE = 'false';
  for (const key of DISABLED_ENV) env[key] = '1';
  if (publicSeat) Object.assign(env, PUBLIC_GIT_ENV);
  return withholdRuntimeCredential(env, { credentialFile });
};

const spawnBinaryPath = (env) => {
  try {
    const where = spawnSync('which', ['opencode'], { encoding: 'utf8', env });
    if (where.status === 0 && typeof where.stdout === 'string' && where.stdout.trim()) {
      return realpathSync(where.stdout.trim());
    }
  } catch { /* use PATH resolution in spawn */ }
  return 'opencode';
};

const parseOpenCodeVersion = (output) => {
  const match = String(output || '').trim().match(
    /^(?:opencode\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)$/i,
  );
  return match?.[1] || null;
};

const readOpenCodeVersion = (binary, env) => {
  try {
    const probeEnv = { ...env };
    for (const key of DISABLED_ENV) probeEnv[key] = '1';
    const result = spawnSync(binary, ['--version'], {
      encoding: 'utf8', env: probeEnv, timeout: VERSION_CHECK_TIMEOUT_MS,
    });
    if (result.error || result.status !== 0) return null;
    return parseOpenCodeVersion(result.stdout);
  } catch {
    return null;
  }
};

const isOpenCodePrerelease = (version) => version.split('+', 1)[0].includes('-');

const compareOpenCodeVersions = (left, right) => {
  const leftParts = left.split(/[+-]/, 1)[0].split('.').map(Number);
  const rightParts = right.split(/[+-]/, 1)[0].split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (leftParts[index] !== rightParts[index]) {
      return leftParts[index] > rightParts[index] ? 1 : -1;
    }
  }
  // The smoke-tested boundaries are stable releases. A matching prerelease
  // must not inherit their native signature-replay guarantee.
  const leftPrerelease = isOpenCodePrerelease(left);
  const rightPrerelease = isOpenCodePrerelease(right);
  if (leftPrerelease !== rightPrerelease) return leftPrerelease ? -1 : 1;
  return 0;
};

const describeOpenCodeVersionMismatch = (installedVersion) => {
  const tested = TESTED_OPENCODE_VERSIONS.join(', ');
  if (!installedVersion) return `installed OpenCode version is unknown; smoke-tested versions: ${tested}`;
  const oldest = TESTED_OPENCODE_VERSIONS[0];
  const newest = TESTED_OPENCODE_VERSIONS[TESTED_OPENCODE_VERSIONS.length - 1];
  if (compareOpenCodeVersions(installedVersion, newest) > 0) {
    return `installed OpenCode ${installedVersion} is newer than smoke-tested versions ${tested}`;
  }
  if (compareOpenCodeVersions(installedVersion, oldest) < 0) {
    return `installed OpenCode ${installedVersion} is older than smoke-tested versions ${tested}`;
  }
  return `installed OpenCode ${installedVersion} differs from smoke-tested versions ${tested}`;
};

export default {
  get requiresModel() { return seatModelRequired(); },
  name: 'opencode',
  runtimeType: 'opencode',
  supportsProvider: true,
  // `provider.api`: an OpenAI-compatible endpoint, or Anthropic's Messages API
  // through OpenCode's own @ai-sdk/anthropic provider.
  providerApis: ['openai-chat', 'anthropic-messages'],

  async validateEnvironment(environment, workspacePath) {
    return validateProviderEnvironment(environment, workspacePath);
  },

  async detect() {
    try {
      const res = spawnSync('opencode', ['--version'], { encoding: 'utf8', timeout: VERSION_CHECK_TIMEOUT_MS });
      if (res.error || res.status !== 0) return null;
      const stdout = (res.stdout || '').trim();
      const version = parseOpenCodeVersion(stdout) || stdout || 'unknown';
      const where = spawnSync('which', ['opencode'], { encoding: 'utf8' });
      const path = where.status === 0 ? (where.stdout || '').trim() || 'opencode' : 'opencode';
      return { path, version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, rawCtx = {}) {
    try {
      return await this.spawnTurn(prompt, rawCtx);
    } catch (err) {
      if (!rawCtx.sessionId || !isStaleSessionError(err)) throw err;
      // The saved id is one OpenCode does not know: a seat switched from another
      // adapter carries a Claude id, and a pruned session fails the same way. Nothing
      // ran, so one fresh turn is safe (pi #1726 does the same fallback).
      return this.spawnTurn(prompt, { ...rawCtx, sessionId: null });
    }
  },

  async spawnTurn(prompt, rawCtx = {}) {
    const seatModel = requireSeatModel(rawCtx.environment, 'opencode');
    const sandbox = normalizeSandboxTrust(rawCtx.environment?.sandbox);
    refuseWorkspaceTrust(sandbox, 'opencode');
    const ctx = rawCtx.environment
      ? { ...rawCtx, environment: { ...rawCtx.environment, sandbox } }
      : rawCtx;
    if (isLegacySandboxTrust(rawCtx.environment?.sandbox)) {
      // eslint-disable-next-line no-console
      console.warn('[opencode] legacy sandbox.trust=internal resolves to public and remains confined');
    }
    const isPublic = sandbox?.trust === 'public';
    const sandboxMode = isPublic ? resolvePublicSandboxMode(sandbox) : null;
    if (isPublic && !['workspace', 'read-only', 'bwrap'].includes(sandboxMode)) {
      throw new Error(`public OpenCode agents require an enforced sandbox mode, got ${sandboxMode || 'unset'}`);
    }

    const provider = ctx.environment?.provider;
    if (isPublic && !provider) {
      throw new Error('public OpenCode seats require environment.provider; the implicit public tier and operator auth.json are unsupported for public trust');
    }
    if (ctx.providerKey && (!isPublic || !['workspace', 'read-only', 'bwrap'].includes(sandboxMode))) {
      throw new Error('Own provider keys require a confined OpenCode runtime');
    }
    const providerKeyFile = ctx.providerKey ? null : await validateProviderEnvironment(ctx.environment, ctx.cwd);

    const sourceEnv = ctx.env || process.env;
    const childSourceEnv = Object.fromEntries(Object.entries(sourceEnv)
      .filter(([key]) => key !== ALLOW_UNTESTED_OPENCODE_VERSION_ENV));
    const runtimeEnv = isPublic
      ? Object.fromEntries(Object.entries(childSourceEnv).filter(([key]) => PUBLIC_SAFE_ENV.test(key)))
      : childSourceEnv;
    const binary = ctx._binaryPath || spawnBinaryPath(runtimeEnv);
    const installedVersion = readOpenCodeVersion(binary, runtimeEnv);
    // Trusted seats otherwise allow old binaries. Gemini requires a stable
    // release with native signature replay now that the proxy shim is gone.
    if (provider && new URL(provider.baseURL).hostname.toLowerCase() === 'generativelanguage.googleapis.com'
      && (!installedVersion || isOpenCodePrerelease(installedVersion)
        || compareOpenCodeVersions(installedVersion, TESTED_OPENCODE_VERSIONS[0]) < 0)) {
      throw new Error(
        `Gemini requires stable OpenCode ${TESTED_OPENCODE_VERSIONS[0]} or later for native thought-signature replay; `
        + `installed version is ${installedVersion || 'unknown'}`,
      );
    }
    if (!TESTED_OPENCODE_VERSIONS.includes(installedVersion)) {
      const mismatch = describeOpenCodeVersionMismatch(installedVersion);
      const allowOverride = process.env[ALLOW_UNTESTED_OPENCODE_VERSION_ENV] === '1';
      const patchAfterTested = isPatchAfterNewestTested(installedVersion, TESTED_OPENCODE_VERSIONS);
      if (isPublic && !allowOverride && !patchAfterTested) {
        throw new Error(
          `Public OpenCode seats refuse to run: ${mismatch}. `
          + `To override from the host process, set ${ALLOW_UNTESTED_OPENCODE_VERSION_ENV}=1.`,
        );
      }
      let outcome = 'trusted seat continues';
      if (isPublic) {
        outcome = allowOverride
          ? `continuing because the host process set ${ALLOW_UNTESTED_OPENCODE_VERSION_ENV}=1`
          : 'a patch release on the newest smoke-tested line, so the public seat continues';
      }
      // eslint-disable-next-line no-console
      console.warn(`[opencode] ${mismatch}; ${outcome}`);
    }

    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
      // F118: a public seat reads its memory but is not offered a write.
      memoryReadOnly: isPublic,
    });
    const tempDir = await mkdtemp(join(ctx._tempRoot || tmpdir(), 'commonly-opencode-'));
    await chmod(tempDir, 0o700);
    const configPath = join(tempDir, 'opencode.json');
    const configDir = join(tempDir, 'config-dir');
    const xdgConfig = join(tempDir, 'xdg-config');
    const home = isPublic ? join(tempDir, 'home') : null;
    // OpenCode initializes its global and XDG config directories during
    // startup, so create those roots and their ignore files before wrapping.
    // Keep public HOME per-spawn, but leave $HOME/.opencode absent: OpenCode
    // loads it after OPENCODE_CONFIG when present, which could persist config
    // or MCP injection into later spawns.
    const xdgConfigDir = join(xdgConfig, 'opencode');
    await Promise.all([
      mkdir(configDir),
      mkdir(xdgConfigDir, { recursive: true }),
    ]);
    await Promise.all([configDir, xdgConfigDir].map((directory) => writeFile(
      join(directory, '.gitignore'),
      OPENCODE_CONFIG_GITIGNORE,
      { encoding: 'utf8', mode: 0o600, flag: 'wx' },
    )));
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: tempDir,
    });
    let openCodeHome = null;
    let providerProxy = null;
    let instanceProxy = null;
    try {
      openCodeHome = await prepareOpenCodeDataHome(ctx, { publicSeat: isPublic });
      if (isPublic && provider) {
        // OpenCode can spend the configured model budget through this proxy;
        // the bearer only prevents unrelated local processes from using it.
        providerProxy = await startProviderProxy({
          provider,
          wire: provider.api || 'openai-chat',
          keyFile: providerKeyFile, keyMaterial: ctx.providerKey,
          tokenFile: join(tempDir, 'provider-proxy-token'),
          ...(sandboxMode === 'bwrap' ? {
            socketPath: join(tempDir, 'provider-proxy.sock'),
            isolatedPort: ISOLATED_PROXY_PORT,
          } : {}),
        });
      }
      if (isPublic && sandboxMode === 'bwrap' && ctx.instanceUrl) {
        instanceProxy = await startInstanceProxy({
          instanceUrl: ctx.instanceUrl,
          socketPath: join(tempDir, 'instance-proxy.sock'),
        });
      }
      const stateHome = isPublic ? join(openCodeHome.root, 'state') : null;
      const cacheHome = isPublic ? join(openCodeHome.root, 'cache') : null;
      const tempWork = isPublic ? join(openCodeHome.root, 'tmp') : join(tempDir, 'tmp');
      await Promise.all([
        mkdir(tempWork, { recursive: true, mode: 0o700 }),
        ...(stateHome ? [mkdir(stateHome, { recursive: true, mode: 0o700 })] : []),
        ...(cacheHome ? [mkdir(cacheHome, { recursive: true, mode: 0o700 })] : []),
      ]);
      const unavailableMcp = [];
      const mcpReadDirectories = [];
      const bearerFileServers = [];
      const mcp = buildMcpConfig(ctx.environment?.mcp, {
        runtimeToken: ctx.runtimeToken,
        instanceUrl: instanceProxy
          ? `http://127.0.0.1:${ISOLATED_INSTANCE_PORT}` : ctx.instanceUrl,
        credentialFile: credential?.path || null,
        publicSeat: isPublic,
        unavailableMcp,
        mcpReadDirectories,
        bearerFileServers,
      });
      if (unavailableMcp.length) throw publicMcpUnavailableError(unavailableMcp);
      // A remote server that holds this spawn's credential file can spend
      // whatever the credential reaches, a connector grant included. The broker
      // entry that reaches the adapter has passed the daemon's withhold
      // (grant-broker-guard.js), but buildMcpConfig hands the file to any http
      // entry declaring `Bearer ${COMMONLY_AGENT_TOKEN}`, whatever its URL, so
      // the walk's fail-closed rule keys on what was written (CodeRabbit #3487).
      const carriesGrant = bearerFileServers.length > 0;
      const config = {
        permission: isPublic
          ? publicPermissions(sandboxMode, Object.keys(mcp))
          : 'allow',
        share: 'disabled',
        autoupdate: false,
        // A public seat runs no LSP server or formatter: both execute workspace
        // code (a planted tsserver.js, a prettier config) inside the jail, where
        // the credential is readable. Off by OpenCode's default in 1.19.x
        // (`if (!cfg.lsp)`, `if (!cfg.formatter)`); pinned here so a default
        // flip in a later release changes nothing.
        ...(isPublic ? { lsp: false, formatter: false } : {}),
        ...(provider ? {
          enabled_providers: [provider.id],
          provider: buildProviderConfig(providerProxy
            ? { ...provider, baseURL: providerProxy.baseURL }
            : provider, ctx.environment.model, providerProxy?.tokenFile || providerKeyFile),
        } : {}),
        ...(Object.keys(mcp).length ? { mcp } : {}),
      };
      await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
        encoding: 'utf8', mode: 0o600,
      });
      await chmod(configPath, 0o600);

      const childEnv = makeChildEnvironment({
        source: runtimeEnv,
        tempDir,
        configPath,
        configDir,
        dataHome: openCodeHome.dataHome,
        stateHome,
        cacheHome,
        home,
        tempWork,
        credentialFile: credential?.path || null,
        publicSeat: isPublic,
      });
      if (isPublic) {
        // After the child env exists: the git check runs under the very env
        // OpenCode gets (its HOME, its XDG config, no GIT_* from the launcher).
        assertSpawnRootOutsideWorkspace(ctx.cwd || process.cwd(), tempDir, {
          carriesGrant,
          bounds: ctx._symlinkWalkBounds || SYMLINK_WALK_BOUNDS,
          dependencyBounds: ctx._dependencyWalkBounds || DEPENDENCY_WALK_BOUNDS,
          gitEnv: childEnv,
        });
      }
      const args = buildArgs({
        prompt: fullPrompt,
        sessionId: ctx.sessionId,
        cwd: ctx.cwd,
        model: qualifiedProviderModel(provider, seatModel),
        effort: ctx.environment?.effort,
        title: ctx.agentName,
      });
      const platform = ctx._platform || process.platform;
      let cmd = binary;
      let spawnArgs = args;
      if (isPublic && sandboxMode === 'bwrap') {
        if (!binary.startsWith('/')) {
          throw new Error('public OpenCode agents require opencode to resolve to an absolute executable path');
        }
        const bwrap = (ctx._detectBwrap || detectBwrap)();
        if (!bwrap.available) throw new Error(`public OpenCode agents require bwrap: ${bwrap.error}`);
        const wrapped = (ctx._wrapArgvWithBwrap || wrapArgvWithBwrap)([
          process.execPath, LOOPBACK_BRIDGE,
          providerProxy.socketPath, String(ISOLATED_PROXY_PORT),
          instanceProxy?.socketPath || '-', String(ISOLATED_INSTANCE_PORT), binary, ...args,
        ], {
          ...ctx.environment,
          sandbox: {
            ...sandbox,
            network: { ...sandbox?.network, policy: 'restricted' },
            filesystem: {
              ...(sandbox?.filesystem || {}),
              'write-outside': [
                ...(Array.isArray(sandbox?.filesystem?.['write-outside'])
                  ? sandbox.filesystem['write-outside'] : []),
                openCodeHome.root,
              ],
            },
          },
        }, {
          workspacePath: ctx.cwd,
          readOnlyPaths: [
            tempDir,
            binary,
            process.execPath,
            LOOPBACK_BRIDGE,
            ...mcpReadDirectories,
          ],
          optionalReadOnlyPaths: ['/usr/sbin', '/sbin'],
          enableLoopback: true,
        });
        [cmd, ...spawnArgs] = wrapped;
      } else if (isPublic) {
        if (platform !== 'darwin') {
          throw new Error(`public OpenCode sandbox.mode=${sandboxMode} requires Seatbelt on macOS or bwrap on Linux`);
        }
        const wrapped = (ctx._wrapArgvWithSeatbelt || wrapArgvWithSeatbelt)([binary, ...args], {
          workspacePath: ctx.cwd,
          workspaceAccess: sandboxMode === 'read-only' ? 'read' : 'write',
          executablePath: binary,
          statePath: openCodeHome.root,
          mcpConfigDir: tempDir,
          // Public seat: the CLI made this workspace, so it is pinned (F197).
          pinWorkspace: true,
          loopbackNetworkPorts: providerProxy ? [providerProxy.port] : [],
          readOnlyPaths: [],
          readOnlyDirectories: mcpReadDirectories,
        });
        [cmd, ...spawnArgs] = wrapped;
      }
      const credentials = [...spawnCredentials(ctx, sourceAuthEnvNames(sourceEnv)), ctx.providerKey].filter(Boolean);
      const result = await runOpenCode({
        cmd,
        args: spawnArgs,
        cwd: ctx.cwd,
        env: childEnv,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        credentials,
        spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(args.slice(0, -1), { modelFlag: '-m', effortFlag: '--variant', valueFlags: ['-s', '--dir', '--title', '--format'] }),
        // CodeRabbit #3487: the walk cannot prove a whole node_modules tree
        // free of a deep link to the temp root, so a credential handed to a
        // remote server stops existing once OpenCode has read it. Measured in
        // the 1.19.4 binary: {file:} is expanded once, over the config text at
        // load; every MCP connect (a reconnect included) takes its headers from
        // that cached config; and `run` emits step_start only after tools are
        // resolved and each MCP server, the shipped stdio one included (it reads
        // COMMONLY_TOKEN_FILE at startup), has connected. A config reload after
        // this point would fail on the missing file, closed, not open.
        // A delete that fails leaves the credential readable, so the turn ends
        // rather than run on with it (`force` already ignores a missing file).
        onFirstStep: isPublic && carriesGrant && credential
          ? () => {
            try {
              (ctx._rmSync || rmSync)(credential.path, { force: true });
            } catch (err) {
              throw new Error(
                `public OpenCode seat could not delete its connector credential (${credential.path}) once OpenCode `
                + `had loaded its config: ${err?.message || err}; the turn was stopped so the credential does not `
                + 'stay readable to its tools',
              );
            }
          }
          : undefined,
      });
      if (isPublic) {
        const failure = publicToolFailure(result.toolErrors, ctx.environment?.mcp);
        if (failure) throw publicToolFailedError(failure);
      }
      return {
        text: result.text.trim(),
        newSessionId: result.sessionId || ctx.sessionId || null,
        ...(result.usage ? { usage: result.usage } : {}),
      };
    } finally {
      try { await instanceProxy?.close(); } catch { /* ignore */ }
      try { await providerProxy?.close(); } catch { /* ignore */ }
      try { await rm(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};

export {
  ALLOW_UNTESTED_OPENCODE_VERSION_ENV,
  DISABLED_ENV,
  TESTED_OPENCODE_VERSIONS,
  buildArgs,
  buildMcpConfig,
  buildProviderConfig,
  makeEventParser,
  prepareOpenCodeDataHome,
  publicPermissions,
  readOpenCodeVersion,
  qualifiedProviderModel,
  resolveProviderKeyFile,
  scanWorkspaceLinks,
  startProviderProxy,
};
