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
 * final reply from the file written via `--output-last-message <FILE>` —
 * cleaner than parsing every event-type variant the model can emit.
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
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // ADR-005 §Spawning semantics

const buildPrompt = (prompt, memoryLongTerm) => {
  if (!memoryLongTerm) return prompt;
  return `=== Context (your persistent memory) ===\n${memoryLongTerm}\n=== Current turn ===\n${prompt}`;
};

// Build the argv after the `codex` binary. Resume vs new turn is a
// subcommand-level distinction in modern codex, not an option flag — keep
// that detail isolated here so the spawn path stays linear.
const buildArgs = ({ sessionId, prompt, outputFile }) => {
  const common = ['--json', '--skip-git-repo-check', '-o', outputFile];
  if (sessionId) {
    return ['exec', 'resume', ...common, sessionId, prompt];
  }
  return ['exec', ...common, prompt];
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
  const proc = spawnImpl('codex', args, { cwd, env });
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
      const args = buildArgs({
        sessionId: ctx.sessionId || null,
        prompt: fullPrompt,
        outputFile,
      });

      const { threadId } = await runCodex({
        args,
        cwd: ctx.cwd,
        env: ctx.env,
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
