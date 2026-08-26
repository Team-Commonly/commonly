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
 * Memory preamble: if ctx.memoryLongTerm is non-empty, the adapter prepends
 * it to the prompt as a system-context preamble (§Memory bridge), matching
 * the claude adapter's shape so the run loop's per-event memory plumbing
 * works identically across drivers.
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

import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
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
} from 'fs/promises';
import { homedir, tmpdir } from 'os';
import {
  dirname,
  join,
  resolve as pathResolve,
} from 'path';
import { buildMemoryPreamble } from '../memory-bridge.js';

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
//   - Token-bearing values ride through `env_vars`, never a `-c ...env=...`
//     argv override. Command lines are visible to other same-user processes
//     unless the OS sandbox blocks process inspection; keeping bearer tokens
//     out of argv is an independent defense.
const SUBSTITUTION_KEYS = ['COMMONLY_AGENT_TOKEN', 'COMMONLY_API_URL', 'COMMONLY_INSTANCE_URL'];
const PLACEHOLDER_RE = /\$\{(COMMONLY_[A-Z_]+)\}/g;

const substitutePlaceholders = (value, ctx) => {
  if (typeof value !== 'string') return value;
  if (!value.includes('${COMMONLY_')) return value;
  const subs = {
    COMMONLY_AGENT_TOKEN: ctx.runtimeToken || '',
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
  for (const server of mcpServers || []) {
    if (!server?.name || !Array.isArray(server.command) || !server.command.length) continue;
    const [command, ...rest] = server.command.map((a) => substitutePlaceholders(a, ctx));
    flags.push('-c', `mcp_servers.${server.name}.command=${toml(command)}`);
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
    for (const [key, rawValue] of Object.entries(server.env || {})) {
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
  return { flags, forwardedEnv };
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
// operator credential. The symlink itself lives under ~/.commonly, which the
// permission profile denies to model-generated commands.
const preparePublicCodexHome = async (ctx) => {
  const operatorHome = ctx.env?.CODEX_HOME
    || process.env.CODEX_HOME
    || join(homedir(), '.codex');
  const identity = ctx.agentName || ctx.cwd || 'anonymous';
  const identityHash = createHash('sha256').update(identity).digest('hex').slice(0, 20);
  const publicHome = ctx._publicCodexHome
    || join(homedir(), '.commonly', 'codex-homes', identityHash);
  if (pathResolve(publicHome) === pathResolve(operatorHome)) {
    throw new Error('public codex home must be isolated from the operator CODEX_HOME');
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
  return publicHome;
};

const publicPermissionProfileFlags = (mode) => {
  if (!PUBLIC_SANDBOX_MODES.has(mode)) {
    throw new Error(
      `public codex agents require sandbox.mode=workspace or read-only, got ${mode || 'unset'}`,
    );
  }
  const workspaceAccess = mode === 'read-only' ? 'read' : 'write';
  const filesystem = [
    '":minimal"="read"',
    '"~/.commonly"="deny"',
    '"~/.claude"="deny"',
    '"~/.codex"="deny"',
    '"~/.ssh"="deny"',
    '"~/.aws"="deny"',
    '"~/.config"="deny"',
    '"/private/tmp"="deny"',
    `":workspace_roots"={"."="${workspaceAccess}",".commonly/**"="deny",".codex/**"="deny","*.env"="deny","*/*.env"="deny","*/*/*.env"="deny"}`,
  ].join(',');
  return [
    '-c', `default_permissions=${toml(PUBLIC_PERMISSION_PROFILE)}`,
    '-c', `permissions.${PUBLIC_PERMISSION_PROFILE}.filesystem={${filesystem}}`,
    '-c', `permissions.${PUBLIC_PERMISSION_PROFILE}.network.enabled=false`,
    // The MCP launcher receives explicitly forwarded env_vars separately.
    // Model-generated shell commands inherit only a small non-secret core.
    '-c', 'shell_environment_policy.inherit="core"',
    '-c', 'shell_environment_policy.ignore_default_excludes=false',
    '-c', 'shell_environment_policy.include_only=["PATH","HOME","TMPDIR","LANG","LC_*"]',
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
      ...publicPermissionProfileFlags(publicSandboxMode),
    ]
    : ['--dangerously-bypass-approvals-and-sandbox'];
  const common = [
    '--json',
    '--skip-git-repo-check',
    ...executionPolicy,
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

const runCodex = ({ args, cwd, env, timeoutMs, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  // stdio: ['ignore', 'pipe', 'pipe'] — without this, child_process.spawn
  // defaults stdin to a fresh pipe. Codex 0.125.0's `exec` then blocks on
  // `Reading additional input from stdin...` because it sees an open pipe
  // and waits for input that never arrives. Interactive runs are fine because
  // codex detects a TTY and uses the argv prompt directly. Setting stdin to
  // `'ignore'` gives codex /dev/null → immediate EOF → it falls back to the
  // argv prompt as intended. Surfaced live during ADR-005 Phase 2 smoke.
  const proc = spawnImpl('codex', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
      // a generic "non-zero exit" error.
      return reject(new Error(`codex turn failed: ${events.turnFailedMessage}`));
    }
    if (code !== 0) {
      return reject(new Error(`codex exited with code ${code}: ${stderr.trim().slice(0, 500)}`));
    }
    resolve({ threadId: events.threadId });
  });
});

export default {
  name: 'codex',
  // See claude.js for the rationale — identity-bearing runtime tag persisted
  // to AgentInstallation.config.runtime (paired with host:'byo') so a CLI-
  // attached Codex agent and a cloud-hosted Codex agent share the same
  // `runtimeType` and differ only on `host`.
  runtimeType: 'codex',

  async detect() {
    try {
      const res = spawnSync('codex', ['--version'], { encoding: 'utf8' });
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
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm || '');

    // Per-spawn temp dir for --output-last-message. Cleaned up in `finally`
    // so a crash in the middle of the spawn doesn't leak files in $TMPDIR.
    const dir = await mkdtemp(join(tmpdir(), 'commonly-codex-'));
    const outputFile = join(dir, 'last-message.txt');

    try {
      const mcp = buildMcpOverrideArgs(ctx.environment?.mcp, {
        runtimeToken: ctx.runtimeToken,
        instanceUrl: ctx.instanceUrl,
      });
      const publicSandboxMode = ctx.environment?.sandbox?.trust === 'public'
        ? ctx.environment?.sandbox?.mode || 'unset'
        : null;
      const args = buildArgs({
        sessionId: ctx.sessionId || null,
        prompt: fullPrompt,
        outputFile,
        mcpFlags: mcp.flags,
        publicSandboxMode,
      });
      const childEnv = { ...(ctx.env || process.env), ...mcp.forwardedEnv };
      if (publicSandboxMode !== null) {
        childEnv.CODEX_HOME = await preparePublicCodexHome(ctx);
      }

      const { threadId } = await runCodex({
        args,
        cwd: ctx.cwd,
        env: childEnv,
        timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
        spawnImpl: ctx._spawnImpl, // test seam only — do not use in production
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
