/**
 * claude adapter — wraps the local `claude` CLI as a Commonly agent.
 *
 * Contract: ADR-005 §Adapter pattern.
 *
 * Memory preamble: if ctx.memoryLongTerm is non-empty, the adapter prepends
 * it to the prompt as a system-context preamble (§Memory bridge).
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
    const isResume = !!ctx.sessionId;
    const sessionId = ctx.sessionId || randomUUID();
    const fullPrompt = buildPrompt(prompt, ctx.memoryLongTerm || '');
    const sessionFlag = isResume ? '--resume' : '--session-id';
    const args = ['-p', fullPrompt, '--output-format', 'text', sessionFlag, sessionId];

    try {
      const stdout = await runClaude({
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
        const stdout = await runClaude({
          args: ['-p', fullPrompt, '--output-format', 'text', '--session-id', freshId],
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
