/**
 * claude adapter — wraps the local `claude` CLI as a Commonly agent.
 *
 * Contract: ADR-005 §Adapter pattern. Argv shape per ADR-005 §Adapters
 * shipped in v1: `claude -p "$prompt" --output-format text --session-id $sid`.
 *
 * Memory preamble: if ctx.memoryLongTerm is non-empty, the adapter prepends
 * it to the prompt as a system-context preamble (§Memory bridge).
 *
 * Session continuity: we pass the same stable session id to claude on every
 * turn and return it as `newSessionId` so the run loop persists it. First
 * turn mints a UUID; subsequent turns re-use it. claude keeps the
 * conversation alive on its side for this id.
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

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // ADR-005 §Spawning semantics

const buildPrompt = (prompt, memoryLongTerm) => {
  if (!memoryLongTerm) return prompt;
  return `=== Context (your persistent memory) ===\n${memoryLongTerm}\n=== Current turn ===\n${prompt}`;
};

const runClaude = ({ args, cwd, env, timeoutMs, spawnImpl = childSpawn }) => new Promise((resolve, reject) => {
  const proc = spawnImpl('claude', args, { cwd, env });
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
    const sessionId = ctx.sessionId || randomUUID();
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm || '');
    const args = ['-p', fullPrompt, '--output-format', 'text', '--session-id', sessionId];

    const stdout = await runClaude({
      args,
      cwd: ctx.cwd,
      env: ctx.env,
      timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
      spawnImpl: ctx._spawnImpl, // test seam only — do not use in production
    });

    return { text: stdout.trim(), newSessionId: sessionId };
  },
};
