/**
 * claude adapter — wraps the local `claude` CLI as a Commonly agent.
 *
 * Contract: ADR-005 §Adapter pattern.
 *
 * Memory preamble: if ctx.memoryLongTerm is non-empty, the adapter prepends
 * it to the prompt as a system-context preamble (§Memory bridge).
 *
 * Environment (ADR-008 Phase 1): if ctx.environment is present, the adapter
 * symlinks declared Claude skills into `<cwd>/.claude/skills/`, writes an MCP
 * config file into a mode-0700 per-spawn temp directory outside the workspace
 * when `mcp` is declared, and wraps the argv with bwrap when
 * `sandbox.mode === 'bwrap'`. The spawn binary becomes `bwrap` in that case —
 * claude moves to the inner argv.
 * A public `workspace` / `read-only` sandbox maps to an outer deny-default
 * Seatbelt profile on macOS. Claude gets an isolated HOME, a credential-starved
 * child environment, and an explicit tool allow/deny policy; Claude and every
 * declared MCP child inherit the same kernel filesystem boundary.
 * When ctx.environment is absent, behaviour is identical to pre-ADR-008.
 *
 * Session continuity (IMPORTANT — the two claude flags are not interchangeable):
 *   - First turn (no persisted id): mint a UUID and pass `--session-id <uuid>`.
 *     claude treats `--session-id` as "CREATE a session with this exact UUID"
 *     and rejects with "Session ID ... is already in use" if the UUID was
 *     already used.
 *   - Subsequent turns (persisted id present): pass `--resume <uuid>` instead.
 *     `--resume` means "continue this existing session."
 *   The wrapper persists the UUID so the SAME id is used across turns — this
 *   adapter just picks the right flag for it.
 *
 * Purity (§Load-bearing invariants #1): input = argv + env + prompt;
 * output = text + session id. No direct network, no direct CAP calls.
 *
 * Test seam: `ctx._spawnImpl` is the sanctioned way for any adapter in this
 * codebase to swap `child_process.spawn` out for a mock. Unit tests pass a
 * fake that returns an EventEmitter; production never sets `_spawnImpl` so
 * the default `childSpawn` is used. Future adapters should follow the same
 * convention rather than inventing their own seam.
 *
 * Timeout caveat: we SIGTERM at `timeoutMs` and wait for `close`. If claude
 * ignores SIGTERM the promise never resolves — the run loop stalls silently.
 * SIGKILL escalation is a post-v1 concern (ADR-005 §Spawning semantics).
 */

import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { realpathSync } from 'fs';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import { isAbsolute, join } from 'path';

import { mountSkills } from '../environment.js';
import { wrapArgvWithBwrap } from '../sandbox/bwrap.js';
import {
  publicClaudeStateRoot,
  wrapArgvWithSeatbelt,
} from '../sandbox/seatbelt.js';
import { buildMemoryPreamble } from '../memory-bridge.js';

// See codex.js for the rationale on bumping the default + env override.
// Keeping both adapters in lockstep so any wrapper agent runtime has the
// same timeout posture regardless of which CLI is underneath.
const DEFAULT_TIMEOUT_MS = (() => {
  const fallback = 15 * 60 * 1000;
  const raw = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

const buildPrompt = buildMemoryPreamble;

const PUBLIC_SANDBOX_MODES = new Set(['workspace', 'read-only']);
const PUBLIC_DENIED_TOOLS = [
  'WebSearch',
  'WebFetch',
  'Bash',
  'Write',
  'Edit',
  'NotebookEdit',
  'Task',
];
const PUBLIC_SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|SSL_CERT_FILE|SSL_CERT_DIR)$/;

const statOrNull = async (path) => {
  try {
    return await lstat(path);
  } catch (err) {
    if (err?.code === 'ENOENT') return null;
    throw err;
  }
};

// Claude's macOS OAuth credential lives in Keychain, but Claude also needs a
// small amount of non-secret account metadata from ~/.claude.json to locate
// it. Never bind or copy the operator's full file: it contains project paths,
// MCP configuration, usage history, and other host-private metadata. Public
// wrappers get a per-identity 0700 HOME carrying only this whitelist.
const preparePublicClaudeState = async (ctx) => {
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const statePath = ctx._publicClaudeState
    || publicClaudeStateRoot(identityHash);
  const tmpPath = join(statePath, 'tmp');
  const configPath = join(statePath, '.claude.json');
  const stateLibrary = join(statePath, 'Library');
  const stateKeychains = join(stateLibrary, 'Keychains');
  const operatorKeychains = join(homedir(), 'Library', 'Keychains');

  await mkdir(tmpPath, { recursive: true, mode: 0o700 });
  await mkdir(stateLibrary, { recursive: true, mode: 0o700 });
  await chmod(statePath, 0o700);
  await chmod(tmpPath, 0o700);
  await chmod(stateLibrary, 0o700);

  // `/usr/bin/security` resolves the default login keychain relative to HOME.
  // Keep HOME isolated while pointing that one standard location at the
  // operator's encrypted keychain database. Seatbelt admits the keychain
  // directory read-only; no bearer credential is copied into agent state.
  const keychainLink = await statOrNull(stateKeychains);
  if (keychainLink && !keychainLink.isSymbolicLink()) {
    throw new Error(`refusing to replace non-symlink Claude keychain path: ${stateKeychains}`);
  }
  if (keychainLink) {
    const target = await readlink(stateKeychains);
    if (target !== operatorKeychains) {
      await unlink(stateKeychains);
      await symlink(operatorKeychains, stateKeychains);
    }
  } else {
    await symlink(operatorKeychains, stateKeychains);
  }

  const operatorConfigPath = join(homedir(), '.claude.json');
  const sourceStat = await statOrNull(operatorConfigPath);
  let source = {};
  if (sourceStat) {
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      throw new Error(`refusing non-regular operator Claude config: ${operatorConfigPath}`);
    }
    try {
      source = JSON.parse(await readFile(operatorConfigPath, 'utf8'));
    } catch (err) {
      throw new Error(`failed to read operator Claude auth metadata: ${err.message}`);
    }
  }

  const sanitized = {
    hasCompletedOnboarding: true,
  };
  for (const key of ['installMethod', 'userID', 'machineID', 'oauthAccount']) {
    if (source[key] !== undefined) sanitized[key] = source[key];
  }
  await writeFile(
    configPath,
    `${JSON.stringify(sanitized, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
  await chmod(configPath, 0o600);
  return { statePath, tmpPath, configPath };
};

const buildClaudeEnv = (input, state, expansionEnv = {}) => {
  const source = input || process.env;
  const output = state ? {} : { ...source };
  if (state) {
    for (const [key, value] of Object.entries(source)) {
      if (PUBLIC_SAFE_ENV.test(key)) output[key] = value;
    }
    output.HOME = state.statePath;
    output.TMPDIR = state.tmpPath;
    output.XDG_CACHE_HOME = join(state.statePath, '.cache');
    output.XDG_CONFIG_HOME = join(state.statePath, '.config');
    output.XDG_DATA_HOME = join(state.statePath, '.local', 'share');
  }
  Object.assign(output, expansionEnv);
  return output;
};

const absoluteToolDeny = (path) => `Read(/${path}/**)`;

const buildPublicClaudePolicyArgs = (mcpToolPatterns) => {
  const home = homedir();
  const deniedReads = [
    absoluteToolDeny(join(home, '.commonly')),
    absoluteToolDeny(join(home, '.claude')),
    absoluteToolDeny(join(home, '.codex')),
    absoluteToolDeny(join(home, '.ssh')),
    absoluteToolDeny(join(home, '.aws')),
    absoluteToolDeny(join(home, '.config')),
    'Read(//private/tmp/**)',
    'Read(./.commonly/**)',
    'Read(./.codex/**)',
    'Read(./.env)',
  ];
  return [
    // HOME points at an isolated, sanitized state directory. Ignore settings
    // from user/project/local sources and disable slash-command extensions;
    // unlike --safe-mode, this preserves the explicit --mcp-config capability.
    '--setting-sources', '',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--no-chrome',
    '--permission-mode', 'dontAsk',
    '--allowedTools', 'Read(./**)', ...mcpToolPatterns,
    '--disallowedTools', ...PUBLIC_DENIED_TOOLS, ...deniedReads,
  ];
};

const runClaude = ({ cmd, args, cwd, env, timeoutMs, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  const proc = spawnImpl(cmd, args, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  let timedOut = false;

  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill('SIGTERM');
  }, timeoutMs);

  proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
  proc.on('error', (err) => {
    clearTimeout(timer);
    reject(err);
  });
  proc.on('close', (code) => {
    clearTimeout(timer);
    if (timedOut) return reject(new Error(`claude timed out after ${timeoutMs}ms`));
    if (code !== 0) {
      // Report stdout too, not just stderr. In `-p` mode claude writes terminal
      // conditions (usage limits especially) to stdout and exits non-zero with
      // stderr empty — 361 consecutive failures on 2026-08-03 carried no reason
      // at all because of this. It is not only a diagnosability problem: the
      // circuit breaker classifies from the error message, so a blank message
      // downgrades a hard quota failure to RUNTIME and its shortest backoff.
      const detail = [stderr.trim(), stdout.trim()].filter(Boolean).join(' | ');
      return reject(new Error(`claude exited with code ${code}: ${detail.slice(0, 2000)}`));
    }
    resolve(stdout);
  });
});

// ── MCP config write — claude consumes this via --mcp-config <path> ─────────

// Keep Commonly placeholders in the MCP JSON and expose their values only in
// Claude's per-spawn environment. Claude Code natively expands ${VAR} in MCP
// command/args/env/url fields. Substituting here used to materialize the raw
// cm_agent_* bearer token in a transient JSON file, which made the token
// readable to any co-confined child allowed to read that config directory.
//
// Recognised placeholders:
//   ${COMMONLY_AGENT_TOKEN}   — the per-(agent, pod) cm_agent_* runtime token
//   ${COMMONLY_API_URL}       — the instance URL the agent is attached to
//   ${COMMONLY_INSTANCE_URL}  — alias for COMMONLY_API_URL (clearer in context)
//
// Only values actually referenced by this MCP declaration are added to the
// child environment. Unknown placeholders remain in JSON so Claude's parser
// fails clearly instead of receiving a silent empty string.
const buildMcpExpansionEnv = (mcpConfig, ctx) => {
  const serialized = JSON.stringify(mcpConfig);
  const values = {
    COMMONLY_AGENT_TOKEN: ctx.runtimeToken || '',
    COMMONLY_API_URL: ctx.instanceUrl || '',
    COMMONLY_INSTANCE_URL: ctx.instanceUrl || '',
  };
  const output = {};
  for (const [key, value] of Object.entries(values)) {
    if (value && serialized.includes(`\${${key}}`)) output[key] = value;
  }
  return output;
};

const buildMcpConfig = (mcpServers) => {
  // Shape: `{ mcpServers: { <name>: { ... } } }` — the standard MCP client
  // config, which claude's `--mcp-config` reads directly.
  const mcpServersMap = {};
  for (const server of mcpServers) {
    const entry = { type: server.transport || 'stdio' };
    if (server.url) entry.url = server.url;
    if (server.command) {
      const [command, ...args] = server.command;
      entry.command = command;
      if (args.length) entry.args = args;
    }
    if (server.env) entry.env = { ...server.env };
    mcpServersMap[server.name] = entry;
  }
  return { mcpServers: mcpServersMap };
};

// Materialized once per spawn outside the workspace, then removed in the
// spawn's finally block. The JSON contains placeholders, never resolved
// Commonly credentials; Claude expands them from its one-run environment.
// Directory/file modes stay strict because this config still declares the
// agent's trusted MCP capabilities and endpoints.
const createMcpConfig = async (mcpServers, ctx = {}) => {
  const dir = await mkdtemp(join(tmpdir(), 'commonly-claude-mcp-'));
  const file = join(dir, 'mcp-config.json');
  const config = buildMcpConfig(mcpServers);
  try {
    await chmod(dir, 0o700);
    await writeFile(
      file,
      JSON.stringify(config, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
    // writeFile's mode only applies when creating. Pin the final mode too so
    // this stays correct if the implementation ever starts reusing the path.
    await chmod(file, 0o600);
    return {
      dir,
      file,
      expansionEnv: buildMcpExpansionEnv(config, ctx),
    };
  } catch (err) {
    try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    throw err;
  }
};

// ── argv preparation — environment-aware ────────────────────────────────────

// Resolve the absolute path of `claude` so bwrap's execvp doesn't depend on
// PATH being correctly populated inside the sandbox namespace. Surfaced live
// during the 2026-04-17 demo validation: bwrap silently inherits parent
// PATH but cannot reach the user's `~/.local/bin` without an absolute path
// argv[0], even when that directory is bound read-only into the sandbox.
const resolveClaudePath = () => {
  // Defensive: spawnSync can return undefined under aggressive mocks (the
  // adapters.claude.environment.test.mjs suite stubs child_process so no real
  // process runs). Treat any failure mode as "use the bare command name."
  let which;
  try { which = spawnSync('which', ['claude'], { encoding: 'utf8' }); } catch { /* ignore */ }
  if (which && which.status === 0) {
    const p = (which.stdout || '').trim();
    if (p) {
      try {
        return realpathSync(p);
      } catch {
        return p;
      }
    }
  }
  return 'claude';
};

const prepareArgv = async (innerArgv, ctx) => {
  const env = ctx.environment;
  if (!env) return { cmd: 'claude', args: innerArgv, env: ctx.claudeEnv };

  let allowedPatterns = [];
  if (Array.isArray(env.mcp) && env.mcp.length > 0) {
    if (!ctx.mcpConfigPath) {
      throw new Error('claude MCP config was declared but no per-spawn config path was prepared');
    }
    // Insert --mcp-config immediately after the subcommand-style `-p` block
    // so claude parses it before prompt collection begins.
    innerArgv = [...innerArgv, '--mcp-config', ctx.mcpConfigPath];
    // Pre-approve every MCP tool from the declared servers (`mcp__<name>__*`).
    // Without this claude runs in non-interactive `-p` mode and asks for
    // permission before invoking any MCP tool — the wrapper has no way to
    // approve, so the model just narrates the request and bails. The user
    // already opted into these servers by declaring them in the env spec, so
    // auto-allowing the corresponding tool prefix is the honest default.
    // Surfaced live during the 2026-04-17 cross-agent demo validation.
    allowedPatterns = env.mcp
      .map((server) => server && server.name)
      .filter(Boolean)
      .map((name) => `mcp__${name}__*`);
  }

  const sandboxMode = env.sandbox?.mode;
  const sandboxTrust = env.sandbox?.trust;
  const publicNativeSandbox = sandboxTrust === 'public'
    && PUBLIC_SANDBOX_MODES.has(sandboxMode);
  if (sandboxTrust === 'public' && sandboxMode === 'none') {
    throw new Error('public Claude agents require an enforced sandbox mode');
  }
  if (publicNativeSandbox) {
    if (process.platform !== 'darwin') {
      throw new Error(
        `public Claude sandbox.mode=${sandboxMode} maps to Seatbelt on macOS; `
        + 'use sandbox.mode=bwrap on Linux',
      );
    }
    if (!ctx.publicClaudeState) {
      throw new Error('public Claude state was not prepared before argv construction');
    }
    innerArgv = [
      ...innerArgv,
      ...buildPublicClaudePolicyArgs(allowedPatterns),
    ];
    const claudeBin = resolveClaudePath();
    const mcpExecutables = (env.mcp || [])
      .map((server) => server?.command?.[0])
      .filter((command) => isAbsolute(command));
    const wrapped = wrapArgvWithSeatbelt([claudeBin, ...innerArgv], {
      workspacePath: ctx.cwd,
      workspaceAccess: sandboxMode === 'read-only' ? 'read' : 'write',
      claudePath: claudeBin,
      statePath: ctx.publicClaudeState.statePath,
      mcpConfigDir: ctx.mcpConfigDir,
      executablePaths: mcpExecutables,
    });
    return {
      cmd: wrapped[0],
      args: wrapped.slice(1),
      env: ctx.claudeEnv,
    };
  }

  if (allowedPatterns.length > 0) {
    innerArgv = [...innerArgv, '--allowedTools', ...allowedPatterns];
  }
  if (sandboxMode === 'bwrap') {
    const claudeBin = resolveClaudePath();
    const wrapped = wrapArgvWithBwrap([claudeBin, ...innerArgv], env, {
      workspacePath: ctx.cwd,
      readOnlyPaths: ctx.mcpConfigDir ? [ctx.mcpConfigDir] : [],
    });
    return { cmd: wrapped[0], args: wrapped.slice(1), env: ctx.claudeEnv };
  }

  return { cmd: 'claude', args: innerArgv, env: ctx.claudeEnv };
};

export default {
  name: 'claude',
  // Identity-bearing runtime tag written into AgentInstallation.config.runtime
  // by `commonly agent attach`. The CLI command stays `commonly agent attach
  // claude` (ergonomic) but the persisted runtimeType matches AGENT_TYPES so
  // the inspector + API can classify it as the same thing as cloud Claude
  // Code. Pair with `host: 'byo'` (set in agent.js) to disambiguate from the
  // hosted variant.
  runtimeType: 'claude-code',

  async detect() {
    try {
      const res = spawnSync('claude', ['--version'], { encoding: 'utf8' });
      if (res.error || res.status !== 0) return null;
      // `claude --version` prints e.g. "2.5.1 (Claude Code)" — first token is enough
      const version = (res.stdout || '').trim().split(/\s+/)[0] || 'unknown';
      // Best-effort resolve of the binary path for clearer UX ("claude detected
      // at /usr/local/bin/claude"). Falls back to the bare command name on
      // platforms without `which` (e.g. Windows).
      const where = spawnSync('which', ['claude'], { encoding: 'utf8' });
      const path = where.status === 0 ? (where.stdout || '').trim() || 'claude' : 'claude';
      return { path, version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, ctx = {}) {
    const isResume = !!ctx.sessionId;
    const sessionId = ctx.sessionId || randomUUID();
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm || '');
    const sessionFlag = isResume ? '--resume' : '--session-id';
    // Model pin from the ADR-008 environment spec. Absent it, claude picks its
    // own default — which is how a fleet of ten agents ended up running three
    // different Opus versions that nobody chose and nothing recorded, with one
    // seat named after a model it does not run.
    //
    // Computed ONCE and spread into BOTH arg builders. The session-recovery
    // path at the bottom of this function constructs its own array, and a model
    // present in one but not the other means a retry silently runs a different
    // model than the turn it is replacing — the same drifting-copy shape that
    // has bitten this codebase repeatedly.
    const modelArgs = ctx.environment?.model ? ['--model', String(ctx.environment.model)] : [];
    const baseArgs = ['-p', fullPrompt, '--output-format', 'text', sessionFlag, sessionId, ...modelArgs];

    if (ctx.environment && ctx.cwd) {
      const skills = await mountSkills(ctx.environment, ctx.cwd);
      if (skills.conflicted.length > 0) {
        for (const c of skills.conflicted) {
          // eslint-disable-next-line no-console
          console.warn(`[claude] skill not mounted (${c.reason}): ${c.path}`);
        }
      }
      if (ctx.onSkillsLinked) ctx.onSkillsLinked(skills);
    }

    let mcpConfig = null;
    let publicClaudeState = null;
    try {
      const publicNativeSandbox = ctx.environment?.sandbox?.trust === 'public'
        && PUBLIC_SANDBOX_MODES.has(ctx.environment?.sandbox?.mode);
      if (publicNativeSandbox) {
        publicClaudeState = await preparePublicClaudeState(ctx);
      }
      if (Array.isArray(ctx.environment?.mcp) && ctx.environment.mcp.length > 0) {
        mcpConfig = await createMcpConfig(ctx.environment.mcp, {
          runtimeToken: ctx.runtimeToken,
          instanceUrl: ctx.instanceUrl,
        });
      }
      const spawnCtx = {
        ...ctx,
        mcpConfigPath: mcpConfig?.file || null,
        mcpConfigDir: mcpConfig?.dir || null,
        publicClaudeState,
        claudeEnv: buildClaudeEnv(
          ctx.env,
          publicClaudeState,
          mcpConfig?.expansionEnv,
        ),
      };
      const { cmd, args, env } = await prepareArgv(baseArgs, spawnCtx);
      const stdout = await runClaude({
        cmd,
        args,
        cwd: ctx.cwd,
        env,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        spawnImpl: ctx._spawnImpl, // test seam only — do not use in production
      });
      return { text: stdout.trim(), newSessionId: sessionId };
    } catch (err) {
      // Self-heal against a corrupted session store. If the persisted id is
      // already in use (or claude has forgotten about it), discard it and
      // restart the turn with a fresh UUID. Without this, a single bad
      // session id poisons every subsequent event re-delivery.
      if (isResume && /already in use|no conversation|no session/i.test(String(err.message))) {
        const freshId = randomUUID();
        const retryBase = ['-p', fullPrompt, '--output-format', 'text', '--session-id', freshId, ...modelArgs];
        const retry = await prepareArgv(retryBase, {
          ...ctx,
          mcpConfigPath: mcpConfig?.file || null,
          mcpConfigDir: mcpConfig?.dir || null,
          publicClaudeState,
          claudeEnv: buildClaudeEnv(
            ctx.env,
            publicClaudeState,
            mcpConfig?.expansionEnv,
          ),
        });
        const stdout = await runClaude({
          cmd: retry.cmd,
          args: retry.args,
          cwd: ctx.cwd,
          env: retry.env,
          timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
          spawnImpl: ctx._spawnImpl,
        });
        return { text: stdout.trim(), newSessionId: freshId };
      }
      throw err;
    } finally {
      if (mcpConfig?.dir) {
        try { await rm(mcpConfig.dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  },
};
