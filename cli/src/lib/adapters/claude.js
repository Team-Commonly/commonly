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
 * config file at `<cwd>/.commonly/mcp-config.json` when `mcp` is declared,
 * and wraps the argv with bwrap when `sandbox.mode === 'bwrap'`. The spawn
 * binary becomes `bwrap` in that case — claude moves to the inner argv.
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
import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

import { linkSkills } from '../environment.js';
import { wrapArgvWithBwrap } from '../sandbox/bwrap.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // ADR-005 §Spawning semantics

const buildPrompt = (prompt, memoryLongTerm) => {
  if (!memoryLongTerm) return prompt;
  return `=== Context (your persistent memory) ===\n${memoryLongTerm}\n=== Current turn ===\n${prompt}`;
};

const runClaude = ({ cmd, args, cwd, env, timeoutMs, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  const proc = spawnImpl(cmd, args, { cwd, env });
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
    if (code !== 0) return reject(new Error(`claude exited with code ${code}: ${stderr.trim()}`));
    resolve(stdout);
  });
});

// ── MCP config write — claude consumes this via --mcp-config <path> ─────────

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
    if (server.env) entry.env = server.env;
    mcpServersMap[server.name] = entry;
  }
  return { mcpServers: mcpServersMap };
};

// Regenerated on every spawn from the env spec; do not hand-edit — the file
// is overwritten before each `claude` invocation, so any local changes are
// silently clobbered. ADR-008 §invariant #5 (edits propagate on next spawn).
const writeMcpConfig = async (cwd, mcpServers) => {
  const dir = join(cwd, '.commonly');
  await mkdir(dir, { recursive: true });
  const file = join(dir, 'mcp-config.json');
  await writeFile(file, JSON.stringify(buildMcpConfig(mcpServers), null, 2), 'utf8');
  return file;
};

// ── argv preparation — environment-aware ────────────────────────────────────

const prepareArgv = async (innerArgv, ctx) => {
  const env = ctx.environment;
  if (!env) return { cmd: 'claude', args: innerArgv };

  if (Array.isArray(env.mcp) && env.mcp.length > 0 && ctx.cwd) {
    const configPath = await writeMcpConfig(ctx.cwd, env.mcp);
    // Insert --mcp-config immediately after the subcommand-style `-p` block
    // so claude parses it before prompt collection begins.
    innerArgv = [...innerArgv, '--mcp-config', configPath];
  }

  const sandboxMode = env.sandbox?.mode;
  if (sandboxMode === 'bwrap') {
    const wrapped = wrapArgvWithBwrap(['claude', ...innerArgv], env, {
      workspacePath: ctx.cwd,
    });
    return { cmd: wrapped[0], args: wrapped.slice(1) };
  }

  return { cmd: 'claude', args: innerArgv };
};

export default {
  name: 'claude',

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
    const baseArgs = ['-p', fullPrompt, '--output-format', 'text', sessionFlag, sessionId];

    if (ctx.environment && ctx.cwd) {
      const skills = await linkSkills(ctx.environment, ctx.cwd);
      if (skills.conflicted.length > 0) {
        for (const c of skills.conflicted) {
          // eslint-disable-next-line no-console
          console.warn(`[claude] skill not linked (${c.reason}): ${c.path}`);
        }
      }
      if (ctx.onSkillsLinked) ctx.onSkillsLinked(skills);
    }

    const { cmd, args } = await prepareArgv(baseArgs, ctx);

    try {
      const stdout = await runClaude({
        cmd,
        args,
        cwd: ctx.cwd,
        env: ctx.env,
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
        const retryBase = ['-p', fullPrompt, '--output-format', 'text', '--session-id', freshId];
        const retry = await prepareArgv(retryBase, ctx);
        const stdout = await runClaude({
          cmd: retry.cmd,
          args: retry.args,
          cwd: ctx.cwd,
          env: ctx.env,
          timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
          spawnImpl: ctx._spawnImpl,
        });
        return { text: stdout.trim(), newSessionId: freshId };
      }
      throw err;
    }
  },
};
