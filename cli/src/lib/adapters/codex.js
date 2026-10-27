import { codexRuntimeInventory } from '../native-runtime-inventory.js';
import { observeSpawn, controlsFromArguments } from '../runtime-observation.js';
import { spawnInOwnGroup, wantsOwnProcessGroup } from '@commonlyai/seats/process-group';
/**
 * codex adapter — wraps the local `codex` CLI as a Commonly agent.
 *
 * Contract: ADR-005 §Adapter pattern.
 *
 * Tested against codex-cli 0.125.0. The argv shape diverges from the
 * ADR-005 §Adapters-shipped-in-v1 table (which was written against an
 * earlier codex-acp variant): modern codex uses `codex exec resume <id>`
 * as a subcommand to continue a session, NOT a `--session <id>` flag.
 * If a future codex bumps the surface again, this adapter is the single
 * file to update.
 *
 * Output shape:
 *   - stdout = JSONL events: `{"type":"thread.started","thread_id":"<uuid>"}`,
 *     `{"type":"turn.started"}`, `{"type":"turn.failed","error":{...}}`, etc.
 *   - stderr = Rust tracing logs (timestamped), unrelated to model output.
 *
 * We capture session id from the `thread.started` event and read the agent's
 * final reply from the file written via `-o <FILE>` (codex's
 * `--output-last-message` short alias) — cleaner than parsing every
 * event-type variant the model can emit.
 *
 * Memory preamble: the adapter prepends the kernel's long-term memory context
 * on every turn. A fresh underlying session additionally receives the
 * read-first and durable-state-at-boundary cues, matching the Claude adapter
 * so the run loop's memory plumbing works identically across drivers.
 *
 * Purity (§Load-bearing invariants #1): input = argv + env + prompt;
 * output = text + session id. No direct network, no direct CAP calls.
 *
 * Test seam: `ctx._spawnImpl` is the sanctioned way for any adapter in this
 * codebase to swap `child_process.spawn` out for a mock. Same convention as
 * claude.js so future adapters stay uniform.
 *
 * Timeout caveat: SIGTERM at `timeoutMs`, then wait for `close`. If codex
 * ignores SIGTERM the promise never resolves — same caveat as claude.js;
 * SIGKILL escalation is a post-v1 concern (ADR-005 §Spawning semantics).
 */

import { requireSeatModel, seatModelRequired } from './seat-model.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { accessSync, constants, existsSync, realpathSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { createRequire } from 'module';
import {
  basename,
  delimiter,
  dirname,
  isAbsolute,
  join,
  resolve as pathResolve,
  sep,
} from 'path';
import { CREDENTIAL_KEY, writeCredentialFile } from '../credential-file.js';
import { supportedGitHooks } from '../commit-attribution.js';
import { deliverSeatCredential, withholdRuntimeCredential } from '../mcp-credential-delivery.js';
import { prepareMcpSpawn, publicMcpUnavailableError, selectedMcpVersionDir } from '../mcp-home.js';
import { buildMemoryPreamble, ROW_SLICING_CUE } from '../memory-bridge.js';
import { resolveSkillSource, skillsAsText } from '../skill-prompt.js';
import { isLegacySandboxTrust, normalizeSandboxTrust, refuseWorkspaceTrust } from '../environment.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

// Default timeout for a single codex spawn (exec mode).
//
// 2026-05-20 smoke surface: Cody's cycle-0 research task ran 15+ web
// searches across openai/codex release notes (a legitimate research
// workload) and was SIGTERM'd at exactly 300_000ms — the adapter killed
// her before she could synthesize the final reply. 5 minutes is too
// tight for codex `exec` mode under real tool-use; the bigger model
// (gpt-5.4) + web.run + reasoning is just slower than a chat turn.
// Bumping to 15 minutes gives multi-step research / repo investigation
// room to finish without disabling the cap (pathological hangs still
// SIGTERM).
//
// Operators can override via the COMMONLY_AGENT_RUN_TIMEOUT_MS env var
// without rebuilding (caller-supplied `ctx.timeoutMs` still wins).
// Invalid / non-positive values fall through to the default rather
// than disabling the timeout entirely.
const DEFAULT_TIMEOUT_MS = (() => {
  const fallback = 15 * 60 * 1000;
  const raw = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

const buildPrompt = buildMemoryPreamble;

// ── MCP wiring — codex consumes MCP servers via `-c mcp_servers.*` overrides ─
//
// Same substitution contract as claude.js (see that file for the placeholder
// rationale): ${COMMONLY_AGENT_TOKEN} / ${COMMONLY_API_URL} in the declared
// env spec are replaced with the wrapper's per-(agent, pod) runtime values at
// spawn time. Before this block the codex adapter silently ignored
// `environment.mcp`, so a codex agent had NO sanctioned posting tool — the
// 2026-07-22 as-operator attribution incident was a codex agent falling back
// to the operator's CLI profile because commonly_* tools were never wired.
//
// Codex-specific constraints:
//   - stdio/command servers only (no url transport here); url-only entries
//     are skipped rather than half-wired.
//   - Only entries that DECLARE stdio (or name no transport) are emitted, even
//     when they also carry a `command`. `auditDeclaredMcp` classifies by
//     `transport` and never judges the command of an entry that declared an
//     http one, so emitting it here executes a command the guard did not
//     approve — the case Vera measured on 2026-09-18 (Connectors 69774).
//   - Token-bearing values ride through `env_vars`, never a `-c ...env=...`
//     argv override. Command lines are visible to other same-user processes
//     unless the OS sandbox blocks process inspection; keeping bearer tokens
//     out of argv is an independent defense.
const SUBSTITUTION_KEYS = ['COMMONLY_AGENT_TOKEN', 'COMMONLY_TOKEN_FILE', 'COMMONLY_API_URL', 'COMMONLY_INSTANCE_URL'];
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;

const substitutePlaceholders = (value, ctx) => {
  if (typeof value !== 'string') return value;
  if (!value.includes('${COMMONLY_')) return value;
  const subs = {
    COMMONLY_AGENT_TOKEN: ctx.runtimeToken || '',
    // The path, not the token: a declared server that can open a file reads the
    // credential from there, and the PATH is not a secret, so it may ride in the
    // argv override below (TASK-083).
    COMMONLY_TOKEN_FILE: ctx.credentialFile || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
  };
  return value.replace(PLACEHOLDER_RE, (whole, key) => (
    SUBSTITUTION_KEYS.includes(key) && subs[key] ? subs[key] : whole
  ));
};

// JSON string escaping is a valid subset of TOML basic-string escaping, so
// JSON.stringify doubles as the TOML quoter for command/args/env values.
const toml = (s) => JSON.stringify(String(s));

const buildMcpOverrideArgs = (mcpServers, ctx = {}) => {
  const flags = [];
  const forwardedEnv = {};
  const unavailableMcp = [];
  const mcpReadDirectories = [];
  for (const server of mcpServers || []) {
    const transport = typeof server?.transport === 'string' ? server.transport.trim().toLowerCase() : 'stdio';
    if (!server?.name || transport !== 'stdio'
      || !Array.isArray(server.command) || !server.command.length) continue;
    // TASK-174: the command that will EXECUTE — the warmed build from the seat's
    // MCP home when there is one — and the credential channel is decided on that
    // same command, so the two can never disagree about which release runs. The
    // rewrite is before `substitutePlaceholders` because it introduces no
    // placeholder: it is a path this host resolved.
    const spawnCommand = prepareMcpSpawn(server.command, {
      apiUrl: ctx.instanceUrl, publicSeat: ctx.publicSeat,
    });
    if (!spawnCommand) {
      unavailableMcp.push(server.name);
      continue;
    }
    // A declared credential is rewritten to the file channel before anything is
    // substituted, so for our server the token is not token-bearing at all: it
    // lands in `env={...}` as a path and never reaches `env_vars`, which is the
    // one path by which the value ends up in codex's own environment and from
    // there in every MCP child it spawns (TASK-083, measured on a live codex
    // seat before the change).
    const declaredEnv = deliverSeatCredential({ ...server, command: spawnCommand }, {
      credentialFile: ctx.credentialFile,
      label: 'codex',
    }).env;
    const [command, ...rest] = spawnCommand.map((a) => substitutePlaceholders(a, ctx));
    // The doc block above promises bearer tokens never ride in argv, and this is
    // the place that had to hold it: an env value that carries the token is
    // diverted to env_vars, but a COMMAND ARGUMENT has no such route — codex
    // substitutes it literally, and a command line is readable by every
    // same-user process. So an entry that needs the token in its argv is
    // refused whole (skipped, with the reason) rather than half-wired: emitting
    // its other flags would leave a server the guard approved and the seat
    // cannot use, and emitting this one would publish the secret. Measured
    // before writing this: substitution did put `cm_agent_*` into
    // `mcp_servers.<name>.args` on the -c command line (TASK-083).
    const carriesTokenInArgv = (value) => !!ctx.runtimeToken
      && typeof value === 'string'
      && value.includes(ctx.runtimeToken);
    if (carriesTokenInArgv(command) || rest.some(carriesTokenInArgv)) {
      // eslint-disable-next-line no-console
      console.warn(
        `[codex] MCP server ${server.name} wants the seat credential as a command `
        + 'argument, where codex substitutes a literal and every same-user process '
        + 'can read it. Skipping that entry: declare the credential on the entry\'s '
        + 'env, where it rides as a file path instead of a value.',
      );
      continue;
    }
    flags.push('-c', `mcp_servers.${server.name}.command=${toml(command)}`);
    const versionDir = ctx.publicSeat && selectedMcpVersionDir(spawnCommand);
    if (versionDir) mcpReadDirectories.push(versionDir);
    // The user opted into every server present in the environment spec.
    // Public permission profiles + approval_policy=never otherwise auto-deny
    // side-effecting MCP calls, silently removing the agent's Commonly tools.
    // Mirror Claude's --allowedTools behavior: declared MCP servers are the
    // capability boundary, and all of their tools are non-interactively
    // approved inside that boundary.
    flags.push(
      '-c',
      `mcp_servers.${server.name}.default_tools_approval_mode="approve"`,
    );
    if (rest.length) {
      flags.push('-c', `mcp_servers.${server.name}.args=[${rest.map(toml).join(',')}]`);
    }
    const envEntries = [];
    const envVars = [];
    for (const [key, rawValue] of Object.entries(declaredEnv)) {
      const value = substitutePlaceholders(rawValue, ctx);
      const carriesRuntimeToken = !!ctx.runtimeToken
        && typeof value === 'string'
        && value.includes(ctx.runtimeToken);
      if (carriesRuntimeToken) {
        if (forwardedEnv[key] !== undefined && forwardedEnv[key] !== value) {
          throw new Error(
            `codex MCP servers declare conflicting token-bearing values for env var ${key}`,
          );
        }
        forwardedEnv[key] = value;
        envVars.push(key);
      } else {
        envEntries.push(`${key} = ${toml(value)}`);
      }
    }
    if (envEntries.length) {
      flags.push('-c', `mcp_servers.${server.name}.env={${envEntries.join(', ')}}`);
    }
    if (envVars.length) {
      flags.push('-c', `mcp_servers.${server.name}.env_vars=[${envVars.map(toml).join(',')}]`);
    }
  }
  if (Object.keys(forwardedEnv).length > 0) {
    // The value is forwarded only for a declaration that needs the token as a
    // LITERAL somewhere a file path is not a value — command args, or a string
    // that merely contains it. That is the measured carve-out (TASK-082), and it
    // is not silent: this is the seat whose environment still carries a secret.
    // eslint-disable-next-line no-console
    console.warn(
      `[codex] this declaration needs ${CREDENTIAL_KEY} as a literal (command args, or a `
      + 'value that contains it), so the token is forwarded to codex for this spawn '
      + "and every MCP child inherits it. Put the credential on the entry's env to "
      + 'get the file channel.',
    );
  }
  return { flags, forwardedEnv, unavailableMcp, mcpReadDirectories };
};

const PUBLIC_PERMISSION_PROFILE = 'commonly_public';
const PUBLIC_SANDBOX_MODES = new Set(['workspace', 'read-only']);

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

// Codex reads $CODEX_HOME/AGENTS.md before model-generated commands enter the
// OS sandbox. Pointing a public run at the operator's normal ~/.codex would
// therefore expose global private instructions even though shell reads of
// ~/.codex are denied. Give every public wrapper identity its own persistent
// Codex home for sessions/state, with only an auth symlink back to the
// operator credential. On macOS the symlink lives under ~/.commonly, which the
// permission profile denies to model-generated commands; on Linux (below) its
// target, ~/.codex, is denied instead.
//
// On Linux the home cannot sit under ~/.commonly. Codex (0.164 and later)
// runs its file helper by exec'ing `$CODEX_HOME/tmp/arg0-linux/.../
// codex-linux-sandbox` inside bwrap, and grants read on that one file, but a
// denied ancestor always wins, so the profile's ~/.commonly deny made every
// public session fail at bootstrap with "bwrap: execvp ... Permission denied".
// Outside every granted root the home is still unreadable to model commands:
// Codex binds the helper file alone, not the home around it (measured on
// codex-cli 0.164.0, where a home there reached the model call). That holds
// only while the workspace does not contain the home, so such a workspace is
// refused. macOS has no arg0 helper and keeps its homes where they were.
const LEGACY_CODEX_HOMES = (home) => join(home, '.commonly', 'codex-homes');

const contains = (outer, inner) => inner === outer || inner.startsWith(outer.endsWith(sep) ? outer : outer + sep);

const stateHomeUnderCommonly = (ctx, home) => new Error(
  `XDG_STATE_HOME (${ctx.env?.XDG_STATE_HOME}) puts the public Codex home under ${join(home, '.commonly')}, `
  + 'which the public sandbox denies on Linux. Point it elsewhere or unset it.',
);

const publicCodexHomesRoot = (ctx) => {
  const home = ctx._homeDir || homedir();
  if ((ctx._platform || process.platform) !== 'linux') return LEGACY_CODEX_HOMES(home);
  const stateHome = ctx.env?.XDG_STATE_HOME;
  const root = join(stateHome && isAbsolute(stateHome) ? stateHome : join(home, '.local', 'state'),
    'commonly', 'codex-homes');
  // An override that lands back under the denied tree would bring the
  // bootstrap failure above back with it. Checked here by name, and again
  // through symlinks before anything is created (preparePublicCodexHome).
  if (contains(pathResolve(home, '.commonly'), pathResolve(root))) throw stateHomeUnderCommonly(ctx, home);
  return root;
};

// The real path of a path that may not exist yet: its nearest existing
// ancestor resolved, with the rest appended.
const realpathOfNearest = async (path) => {
  const rest = [];
  let current = pathResolve(path);
  for (;;) {
    try {
      return join(await realpath(current), ...rest);
    } catch (err) {
      // Only a missing path walks up. Anything else (EACCES, ELOOP) would leave
      // the containment check comparing a path nobody resolved: fail closed.
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current));
      current = parent;
    }
  }
};

const preparePublicCodexHome = async (ctx, childEnv) => {
  const operatorHome = ctx.env?.CODEX_HOME
    || process.env.CODEX_HOME
    || join(homedir(), '.codex');
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const homesRoot = publicCodexHomesRoot(ctx);
  const publicHome = ctx._publicCodexHome || join(homesRoot, identityHash);
  if (pathResolve(publicHome) === pathResolve(operatorHome)) {
    throw new Error('public codex home must be isolated from the operator CODEX_HOME');
  }

  // Checked before anything is created or moved, so a refused workspace
  // never receives the home or a migrated seat's sessions.
  if (!ctx._publicCodexHome && homesRoot !== LEGACY_CODEX_HOMES(ctx._homeDir || homedir())) {
    const home = ctx._homeDir || homedir();
    const [realRoot, realCommonly] = await Promise.all([realpathOfNearest(homesRoot), realpathOfNearest(join(home, '.commonly'))]);
    if (contains(realCommonly, realRoot)) throw stateHomeUnderCommonly(ctx, home);
    const workspacePath = pathResolve(ctx.cwd || process.cwd());
    const [workspace, realHome] = await Promise.all([
      // As in realpathOfNearest: only a missing workspace falls back to its own path.
      realpath(workspacePath).catch((err) => {
        if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return workspacePath;
        throw err;
      }),
      realpathOfNearest(publicHome),
    ]);
    if (contains(workspace, realHome)) {
      throw new Error(`public codex agents cannot run in ${ctx.cwd}: it contains the agent's own `
        + `Codex home (${publicHome}), which the sandbox would then expose. Run it in a project folder.`);
    }
  }

  // A Linux seat that ran before the move keeps its sessions, so a resumed
  // thread still resumes. Across filesystems it starts fresh instead, and
  // says so: the old sessions stay where they were, untouched, and a copy
  // that failed halfway would leave a home later runs never migrate again.
  const legacyHome = join(LEGACY_CODEX_HOMES(ctx._homeDir || homedir()), identityHash);
  if (!ctx._publicCodexHome && legacyHome !== publicHome && !(await statOrNull(publicHome))) {
    const legacy = await statOrNull(legacyHome);
    if (legacy?.isDirectory()) {
      await mkdir(homesRoot, { recursive: true, mode: 0o700 });
      try {
        await rename(legacyHome, publicHome);
      } catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        console.warn(
          `[codex] ${legacyHome} is on another filesystem from ${publicHome}; starting a fresh Codex home. `
          + 'Earlier sessions stay in the old home and will not resume; move it there by hand to keep them.',
        );
      }
    }
  }

  await mkdir(publicHome, { recursive: true, mode: 0o700 });
  await chmod(publicHome, 0o700);

  const sourceAuth = join(operatorHome, 'auth.json');
  const targetAuth = join(publicHome, 'auth.json');
  const sourceStat = await statOrNull(sourceAuth);
  const targetStat = await statOrNull(targetAuth);
  if (targetStat && !targetStat.isSymbolicLink()) {
    throw new Error(`refusing to replace non-symlink public Codex credential: ${targetAuth}`);
  }
  if (sourceStat) {
    const currentTarget = targetStat
      ? pathResolve(dirname(targetAuth), await readlink(targetAuth))
      : null;
    if (currentTarget !== pathResolve(sourceAuth)) {
      if (targetStat) await unlink(targetAuth);
      await symlink(sourceAuth, targetAuth);
    }
  } else if (targetStat) {
    // A stale symlink could unexpectedly authenticate through an old home
    // after the operator intentionally logged out. Remove it and let Codex
    // fail closed with its normal "not logged in" error.
    await unlink(targetAuth);
  }
  // Model commands are sandboxed through the arg0 helper in this folder, a
  // symlink to Codex's own binary, and unlike the file helper that path grants
  // itself neither the folder nor the binary. Without both, every command
  // fails with "bwrap: execvp ... No such file or directory" (measured on
  // codex-cli 0.164.0 with a user-prefix npm install). Only where the home
  // sits outside every deny can the folder's grant take effect.
  const helperReadPaths = [];
  if (homesRoot !== LEGACY_CODEX_HOMES(ctx._homeDir || homedir())) {
    const helperDirectory = join(publicHome, 'tmp', 'arg0-linux');
    await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
    helperReadPaths.push(helperDirectory);
    // Looked up on the PATH the child gets, so the grant names the binary it runs.
    const binary = (ctx._codexNativeBinary || codexNativeBinary)(childEnv);
    if (binary) helperReadPaths.push(binary);
  }
  return { home: publicHome, helperReadPaths };
};

// The native binary `codex` on PATH runs: itself when it is one, or the one
// the npm launcher (`bin/codex.js`) picks, resolved the way that launcher does.
// Only the Linux targets are named because only the Linux helper needs this.
const LINUX_CODEX_TARGETS = { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' };

export const codexNativeBinary = (env) => {
  const onPath = String(env?.PATH || '').split(delimiter).filter(Boolean)
    .map((dir) => join(dir, 'codex'))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  if (!onPath) return null;
  const real = realpathSync(onPath);
  if (basename(real) !== 'codex.js') return real;
  const target = LINUX_CODEX_TARGETS[process.arch];
  if (!target) return null;
  const packageRoot = dirname(dirname(real));
  let vendorRoot = join(packageRoot, 'vendor');
  try {
    const platformPackage = createRequire(real).resolve(`@openai/codex-linux-${process.arch}/package.json`);
    vendorRoot = join(dirname(platformPackage), 'vendor');
  } catch { /* the launcher falls back to its own vendor folder too */ }
  const binary = join(vendorRoot, target, 'bin', 'codex');
  return existsSync(binary) ? realpathSync(binary) : null;
};

// A public seat ran with none of its declared skills: this adapter never read
// `environment.skills`, so every outsider's Codex worked without the house
// rules buildDefaultEnvironment declares for it (found 2026-10-20 beside the
// Claude half of the same gap, #2354). `codex exec` has no skill loader a
// public seat can use, but it reads $CODEX_HOME/AGENTS.md as the user's own
// instructions, and the public home is one this CLI owns. Measured on
// codex-cli 0.162.1 with this adapter's public flags (`--ignore-user-config`
// skips config.toml only): a marker in that file came back verbatim on a new
// thread, and a changed marker came back on `exec resume` of the same thread,
// so a seat picks the skills up on its next turn either way.
//
// `skills.claude` is ADR-008's SKILL.md list ("drivers copy or symlink as
// appropriate"); Codex reads the same format, so no new key. Rewritten each
// spawn (staged, then renamed, so a concurrent read never sees half a file),
// and removed when nothing is declared so a dropped skill stops applying.
// The cap is our own, set at Codex's `project_doc_max_bytes` (32768 in
// codex-cli 0.162.1's shipped default config, read from the binary 2026-10-21).
// It is not a limit Codex applies to this file. At rust-v0.162.1 the global
// `$CODEX_HOME/AGENTS.md` is read whole and trimmed
// (codex-home/src/instructions/mod.rs) and passed in as user instructions,
// outside the project-doc budget, which counts only the project AGENTS.md files
// discovered from the working directory (core/src/agents_md.rs,
// load_project_instructions). So the skills never share a budget with a
// workspace's own AGENTS.md, and nothing past the cap would be cut. The cap is
// what keeps the injected text to the size Codex allows a project doc. It
// bounds the file as written, final newline included, and a skill that would
// cross it is left out whole.
const PUBLIC_CODEX_INSTRUCTIONS_MAX_BYTES = 32 * 1024;

const writePublicCodexInstructions = async (publicHome, ctx) => {
  // Codex loads this file before AGENTS.md when it exists. Clear any leftover
  // override on every spawn so it cannot shadow the seat's declared skills.
  await rm(join(publicHome, 'AGENTS.override.md'), { force: true });
  const declared = Array.isArray(ctx.environment?.skills?.claude) ? ctx.environment.skills.claude : [];
  const baseDir = ctx.cwd || process.cwd();
  const sources = declared.map((source) => resolveSkillSource(source, baseDir));
  const included = [];
  const text = await skillsAsText(
    sources,
    {
      maxBytes: PUBLIC_CODEX_INSTRUCTIONS_MAX_BYTES,
      label: 'codex',
      trailer: '\n',
      onIncluded: (source) => included.push(source),
    },
  );
  const target = join(publicHome, 'AGENTS.md');
  if (!text) {
    await rm(target, { force: true });
    ctx.onSkillsLinked?.({ mounted: [], conflicted: sources.map((path) => ({ path, reason: 'not-inlined' })) });
    return;
  }
  const staged = `${target}.${process.pid}.tmp`;
  await writeFile(staged, text, { encoding: 'utf8', mode: 0o600 });
  await rename(staged, target);
  ctx.onSkillsLinked?.({
    mounted: included,
    conflicted: sources.filter((source) => !included.includes(source)).map((path) => ({ path, reason: 'not-inlined' })),
  });
};

const publicPermissionProfileFlags = (
  mode,
  commitAttributionEnv = null,
  mcpReadDirectories = [],
  codexHelperReadPaths = [],
) => {
  if (!PUBLIC_SANDBOX_MODES.has(mode)) {
    throw new Error(
      `public codex agents require sandbox.mode=workspace or read-only, got ${mode || 'unset'}`,
    );
  }
  const workspaceAccess = mode === 'read-only' ? 'read' : 'write';
  const commitHooksPath = commitAttributionEnv?.COMMONLY_AGENT_HOOKS_PATH || null;
  const originalHooksPath = commitAttributionEnv?.COMMONLY_AGENT_ORIGINAL_HOOKS_PATH || null;
  const originalHookPaths = originalHooksPath
    ? supportedGitHooks()
      .map((hookName) => join(originalHooksPath, hookName))
      .filter((hookPath) => {
        try {
          accessSync(hookPath, constants.X_OK);
          return true;
        } catch {
          return false;
        }
      })
    : [];
  // Preserve caller-supplied git config entries alongside the appended
  // hooksPath entry. The explicit allowlist below admits only these concrete
  // variable names, not arbitrary environment variables.
  const gitConfigEnv = Object.keys(commitAttributionEnv || {})
    .filter((name) => /^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+)$/.test(name));
  const gitConfigKeySet = Object.entries(commitAttributionEnv || {})
    .filter(([name]) => /^GIT_CONFIG_KEY_\d+$/.test(name))
    .map(([name, value]) => `${toml(name)}=${toml(value)}`);
  const filesystem = [
    '":minimal"="read"',
    '"~/.commonly"="deny"',
    '"~/.claude"="deny"',
    '"~/.codex"="deny"',
    '"~/.ssh"="deny"',
    '"~/.aws"="deny"',
    '"~/.config"="deny"',
    '"/private/tmp"="deny"',
    `":workspace_roots"={"."="${workspaceAccess}",".commonly/**"="deny",".codex/**"="deny","*.env"="deny","*/*.env"="deny","*/*/*.env"="deny","**/.npmrc"="deny","**/.yarnrc*"="deny"}`,
    ...(commitHooksPath ? [`${toml(commitHooksPath)}="read"`] : []),
    ...originalHookPaths.map((hookPath) => `${toml(hookPath)}="read"`),
    ...mcpReadDirectories.map((path) => `${toml(path)}="read"`),
    ...codexHelperReadPaths.map((path) => `${toml(path)}="read"`),
  ].join(',');
  const shellEnvironment = [
    'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_*',
    ...(commitHooksPath ? [
      ...gitConfigEnv,
      'COMMONLY_AGENT_GIT_CONFIG_INDEX',
      'COMMONLY_AGENT_GIT_CONFIG_BASE_COUNT',
      'COMMONLY_AGENT_HOOKS_PATH',
      'COMMONLY_AGENT_ORIGINAL_HOOKS_PATH',
      'COMMONLY_AGENT_SEAT_NAME',
      'COMMONLY_AGENT_SEAT_ID',
      'COMMONLY_AGENT_ADAPTER',
      'COMMONLY_AGENT_MODEL',
      'COMMONLY_AGENT_EFFORT',
    ] : []),
  ];
  return [
    '-c', `default_permissions=${toml(PUBLIC_PERMISSION_PROFILE)}`,
    '-c', `permissions.${PUBLIC_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
    '-c', `permissions.${PUBLIC_PERMISSION_PROFILE}.network.enabled=false`,
    // The MCP launcher receives explicitly forwarded env_vars separately.
    // `core` drops explicit GIT_CONFIG_* and hook metadata before include_only
    // can admit them. When attribution is active, inherit all then constrain
    // model shells to the exact allowlist below; keep Codex's default secret
    // filters enabled.
    '-c', `shell_environment_policy.inherit="${commitHooksPath ? 'all' : 'core'}"`,
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', `shell_environment_policy.include_only=${JSON.stringify(shellEnvironment)}`,
    // Codex's default name filter treats GIT_CONFIG_KEY_n as sensitive. Set
    // only those key names after filtering; their corresponding values stay
    // in the allowlisted environment instead of riding argv.
    ...(gitConfigKeySet.length
      ? ['-c', `shell_environment_policy.set={${gitConfigKeySet.join(',')}}`]
      : []),
  ];
};

// Build the argv after the `codex` binary. Resume vs new turn is a
// subcommand-level distinction in modern codex, not an option flag — keep
// that detail isolated here so the spawn path stays linear.
const buildArgs = ({
  sessionId,
  prompt,
  outputFile,
  mcpFlags = [],
  publicSandboxMode = null,
  model = null,
  effort = null,
  commitAttributionEnv = null,
  mcpReadDirectories = [],
  codexHelperReadPaths = [],
}) => {
  const publicSandbox = publicSandboxMode !== null;
  // `--dangerously-bypass-approvals-and-sandbox` disables codex CLI's
  // bubblewrap (bwrap) sandbox + approval prompts. bwrap needs CAP_SYS_ADMIN
  // or unprivileged user-namespaces — neither available to standard k8s
  // containers without elevated securityContext. Without this flag, every
  // shell tool call (git, ls, pwd, ...) fails with "bwrap: Failed to make /
  // slave: Permission denied" inside cloud-codex pods (verified 2026-05-15).
  // The pod is the security perimeter — agent identity is isolated, workspace
  // is PVC-scoped, no host mounts. bwrap inside the pod is redundant.
  // Public laptop wrappers are different: untrusted pod content must never
  // inherit that bypass. Codex >=0.138 permission profiles provide a native
  // deny-by-default read/write/network boundary on macOS and Linux. Do not
  // pass legacy `--sandbox` alongside them: Codex documents that the legacy
  // mode disables permission-profile composition.
  const executionPolicy = publicSandbox
    ? [
      '--ignore-user-config',
      '--ignore-rules',
      ...publicPermissionProfileFlags(
        publicSandboxMode,
        commitAttributionEnv,
        mcpReadDirectories,
        codexHelperReadPaths,
      ),
    ]
    : ['--dangerously-bypass-approvals-and-sandbox'];
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...executionPolicy,
    ...(model ? ['--model', String(model)] : []),
    ...(effort ? ['-c', 'model_reasoning_effort=' + toml(effort)] : []),
    ...mcpFlags,
    '-o',
    outputFile,
  ];
  // Approval policy is a global option in Codex 0.144, so it must precede
  // the `exec` subcommand. A denied operation is returned to the model;
  // non-interactive public agents never hang waiting for an operator.
  const prefix = publicSandbox ? ['--ask-for-approval', 'never'] : [];
  if (sessionId) {
    // Place <sessionId> immediately after the `exec resume` subcommand so a
    // future codex parser change can't accidentally consume it as the value
    // of a preceding flag (e.g. -o). Codex's CLI signature is documented as
    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, and this ordering
    // matches that intent unambiguously regardless of clap version.
    return [...prefix, 'exec', 'resume', sessionId, ...common, prompt];
  }
  return [...prefix, 'exec', ...common, prompt];
};

// Stream-parse JSONL stdout. Codex emits one event per line; partial lines
// across chunk boundaries are buffered and flushed on the next newline.
const makeEventParser = () => {
  let buffer = '';
  let threadId = null;
  let turnFailedMessage = null;

  const consume = (chunk) => {
    buffer += chunk.toString();
    let nl;
    // eslint-disable-next-line no-cond-assign
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'thread.started' && evt.thread_id && !threadId) {
          threadId = evt.thread_id;
        } else if (evt.type === 'turn.failed') {
          // Capture the most recent — codex may emit multiple before exit.
          turnFailedMessage = evt.error?.message || 'codex turn failed';
        }
      } catch {
        // Non-JSON lines on stdout are unexpected but not fatal — skip.
      }
    }
  };

  return {
    consume,
    get threadId() { return threadId; },
    get turnFailedMessage() { return turnFailedMessage; },
  };
};

/**
 * Provider keys this adapter's route can authenticate with. `env_key` in
 * `~/.codex/config.toml` names one of them (ADR-014 — the HTTPS layer is
 * redirected, the CLI's semantics are not), and the adapter cannot know which
 * one this seat uses, so it snapshots whichever are present. A failure tail that
 * echoes a key must not reach a pod (TASK-103).
 */
const CODEX_PROVIDER_KEY_ENVS = [
  'LITELLM_API_KEY',
  'LITELLM_MASTER_KEY',
  'OPENAI_API_KEY',
  'CODEX_API_KEY',
];

// `ownGroup`: see runClaude in claude.js.
const runCodex = ({ args, cwd, env, timeoutMs, credentials = [], spawnImpl = childSpawn, onSpawn, controls = {}, ownGroup = false }) => new Promise((resolve, reject) => {  // stdio: ['ignore', 'pipe', 'pipe'] — without this, child_process.spawn
  // defaults stdin to a fresh pipe. Codex 0.125.0's `exec` then blocks on
  // `Reading additional input from stdin...` because it sees an open pipe
  // and waits for input that never arrives. Interactive runs are fine because
  // codex detects a TTY and uses the argv prompt directly. Setting stdin to
  // `'ignore'` gives codex /dev/null → immediate EOF → it falls back to the
  // argv prompt as intended. Surfaced live during ADR-005 Phase 2 smoke.
  const proc = spawnInOwnGroup(spawnImpl, 'codex', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] }, { ownGroup });
  observeSpawn(proc, onSpawn, controls);
  let stderr = '';
  let timedOut = false;
  const events = makeEventParser();

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, timeoutMs);

  proc.stdout?.on('data', (chunk) => events.consume(chunk));
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) return reject(new Error(`codex timed out after ${timeoutMs}ms`));
    if (events.turnFailedMessage) {
      // Surface the model-side failure message verbatim — the run loop posts
      // it as the agent's reply so the user sees what went wrong rather than
      // a generic "non-zero exit" error. Verbatim is about the WORDING: the
      // tail still goes through the shared reader (TASK-103), so a message that
      // echoed a credential this spawn was handed is redacted before it can be
      // posted into a pod, and a status it names is attached for the circuit
      // breaker rather than left to a regex.
      return reject(adapterFailure('codex turn failed', events.turnFailedMessage, {
        credentials,
        limit: 2000,
      }));
    }
    if (code !== 0) {
      return reject(adapterFailure('codex', stderr.trim(), { credentials, exitCode: code, limit: 500 }));
    }
    resolve({ threadId: events.threadId });
  });
});

export default {
  get requiresModel() { return seatModelRequired(); },
  name: 'codex',
  // See claude.js for the rationale — identity-bearing runtime tag persisted
  // to AgentInstallation.config.runtime (paired with host:'byo') so a CLI-
  // attached Codex agent and a cloud-hosted Codex agent share the same
  // `runtimeType` and differ only on `host`.
  runtimeType: 'codex',

  inventory: codexRuntimeInventory,

  async detect() {
    try {
      const res = spawnSync('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (res.error || res.status !== 0) return null;
      // `codex --version` prints e.g. "codex-cli 0.125.0" — last token is
      // the version. Defensive against future format tweaks: if no
      // dotted-numeric token is found, fall back to the raw stdout.
      const stdout = (res.stdout || '').trim();
      const versionMatch = stdout.match(/(\d+\.\d+(?:\.\d+)?)/);
      const version = versionMatch ? versionMatch[1] : (stdout || 'unknown');
      const where = spawnSync('which', ['codex'], { encoding: 'utf8' });
      const path = where.status === 0 ? (where.stdout || '').trim() || 'codex' : 'codex';
      return { path, version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'codex');
    const sandbox = normalizeSandboxTrust(ctx.environment?.sandbox);
    refuseWorkspaceTrust(sandbox, 'codex');
    // Passed through UNCOALESCED. `ctx.memoryLongTerm || ''` was here, and
    // `null || ''` is `''` — which routed the unreadable case straight into
    // the empty-memory branch and made the whole distinction unreachable from
    // the only two paths that build a real prompt. buildPrompt handles
    // undefined and '' as absence itself; it does not need a guard, it needs
    // the value.
    //
    // Codex has no subagent tool, so of D48's two habits (TASK-545) it is
    // taught row slicing alone; claude.js adds parallel reads. A public seat
    // answers strangers rather than working board rows, so it is taught neither.
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
      workCues: sandbox?.trust === 'public' ? [] : [ROW_SLICING_CUE],
    });

    // Per-spawn temp dir for --output-last-message. Cleaned up in `finally`
    // so a crash in the middle of the spawn doesn't leak files in $TMPDIR.
    const dir = await mkdtemp(join(tmpdir(), 'commonly-codex-'));
    const outputFile = join(dir, 'last-message.txt');
    // Written into the per-spawn directory this adapter already creates and
    // removes: codex reads and writes inside it for --output-last-message, so a
    // child it spawns can reach a file there, which is the one property this
    // file has to have. Outside it the path is an unreadable promise.
    const credential = writeCredentialFile(ctx.runtimeToken, {
      agentName: ctx.agentName || 'agent',
      root: dir,
    });

    try {
      const mcp = buildMcpOverrideArgs(ctx.environment?.mcp, {
        runtimeToken: ctx.runtimeToken,
        instanceUrl: ctx.instanceUrl,
        credentialFile: credential?.path || null,
        publicSeat: sandbox?.trust === 'public',
      });
      if (mcp.unavailableMcp.length) throw publicMcpUnavailableError(mcp.unavailableMcp);
      // A derived record stores `trust: 'public'` and no mode (the block is
      // platform-independent; see cli/src/lib/default-environment.js). Codex's
      // mode only selects read vs write access — its permission profiles run on
      // both macOS and Linux — so the derived default is `workspace`, and an
      // explicit mode in the record still wins. Before this, a mode-less public
      // record threw `got unset` and no codex seat spawned at all.
      if (isLegacySandboxTrust(ctx.environment?.sandbox)) {
        // eslint-disable-next-line no-console
        console.warn(
          '[codex] sandbox.trust=internal is no longer accepted: it reads as '
          + 'confinement and engaged none. Resolving this seat as trust=public '
          + '(Wren 69585).',
        );
      }
      const publicSandboxMode = sandbox?.trust === 'public'
        ? sandbox?.mode ?? 'workspace'
        : null;
      const childEnv = { ...(ctx.env || process.env), ...mcp.forwardedEnv };
      const publicCodexHome = publicSandboxMode !== null
        ? await preparePublicCodexHome(ctx, childEnv)
        : null;
      const args = buildArgs({
        sessionId: ctx.sessionId || null,
        prompt: fullPrompt,
        outputFile,
        mcpFlags: mcp.flags,
        mcpReadDirectories: mcp.mcpReadDirectories,
        publicSandboxMode,
        model: seatModel,
        effort: ctx.environment?.effort,
        commitAttributionEnv: ctx.commitAttributionEnv,
        codexHelperReadPaths: publicCodexHome?.helperReadPaths || [],
      });
      // childEnv is derived from the process environment, so the bootstrap export has to be
      // taken back out: the declaration above moved our server onto the file,
      // and a value left here is a value codex's own children inherit. Kept only
      // when the substitution genuinely needed it (`forwardedEnv` names that
      // carve-out, and the warning above it is emitted for the same spawn).
      withholdRuntimeCredential(childEnv, {
        credentialFile: credential?.path || null,
        keepsValue: mcp.forwardedEnv[CREDENTIAL_KEY] !== undefined,
      });
      if (publicSandboxMode !== null && ctx.commitAttributionEnv) {
        Object.assign(childEnv, ctx.commitAttributionEnv);
      }
      if (publicSandboxMode !== null) {
        childEnv.CODEX_HOME = publicCodexHome.home;
        await writePublicCodexInstructions(childEnv.CODEX_HOME, ctx);
      }

      const { threadId } = await runCodex({
        args,
        cwd: ctx.cwd,
        env: childEnv,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        // The values this spawn was handed, for the failure tail's exact-match
        // check: the seat credential and the provider key the route
        // authenticates with. Snapshot HERE — `withholdRuntimeCredential` above
        // already removed the token from the child copy, and after that there is
        // nothing left to compare a tail against.
        credentials: spawnCredentials(ctx, CODEX_PROVIDER_KEY_ENVS),
        spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(args.slice(args.indexOf('exec') + (args[args.indexOf('exec') + 1] === 'resume' ? 3 : 1), -1), { modelFlag: '--model', valueFlags: ['-c', '-o', '--permission-profile'], codex: true }), // test seam only — do not use in production
        ownGroup: wantsOwnProcessGroup(ctx),
      });

      let text = '';
      try {
        text = (await readFile(outputFile, 'utf8')).trim();
      } catch {
        // codex didn't write the file — empty turn or stream parsing edge.
        // Caller (run loop) treats empty text as a failed spawn and re-delivers.
        text = '';
      }

      // newSessionId precedence: thread_id from this turn (always emitted on
      // a new session, often re-emitted on resume) > the persisted id we
      // came in with > null. The wrapper persists whichever non-null value
      // we return so subsequent turns hit `codex exec resume <id>`.
      const newSessionId = threadId || ctx.sessionId || null;
      return { text, newSessionId };
    } finally {
      try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  },
};
