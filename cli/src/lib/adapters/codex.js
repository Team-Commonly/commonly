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
import { existsSync } from 'fs';
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

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

const buildPrompt = (prompt, memoryLongTerm) => {
  if (!memoryLongTerm) return prompt;
  return `=== Context (your persistent memory) ===\n${memoryLongTerm}\n=== Current turn ===\n${prompt}`;
}
const COMMONLY_MCP_BLOCK = '[mcp_servers.commonly]\\ncommand = \"npx\"\\nargs = [\"-y\", \"@commonlyai/mcp@latest\"]\\nenv = { COMMONLY_API_URL = \"${COMMONLY_API_URL}\", COMMONLY_AGENT_TOKEN = \"${COMMONLY_AGENT_TOKEN}\" }\\n';
const substituteMcpPlaceholders = (value, ctx = {}) => {
  return value
    .replace(/\$\{COMMONLY_API_URL\}/g, ctx.instanceUrl || '${COMMONLY_API_URL}')
    .replace(/\$\{COMMONLY_AGENT_TOKEN\}/g, ctx.runtimeToken || '${COMMONLY_AGENT_TOKEN}');
};

const writeCodexMcpConfig = async (cwd, ctx = {}) => {
  const configPath = join(cwd, '.codex', 'config.toml');
  const existing = existsSync(configPath) ? await readFile(configPath, 'utf8') : '';
  const merged = existing.replace(/\n?\[mcp_servers\.commonly\][\s\S]*?(?=\n\[|$)/, '').trimEnd();
  const next = `${merged}${merged ? '\n\n' : ''}${COMMONLY_MCP_BLOCK}`;
  await writeFile(configPath, substituteMcpPlaceholders(next, ctx), 'utf8');
  return configPath;
};

// Build the argv after the `codex` binary. Resume vs new turn is a
// subcommand-level distinction in modern codex, not an option flag — keep
// that detail isolated here so the spawn path stays linear.
const buildArgs = ({ sessionId, prompt, outputFile }) => {
  // `--dangerously-bypass-approvals-and-sandbox` disables codex CLI's
  // bubblewrap (bwrap) sandbox + approval prompts. bwrap needs CAP_SYS_ADMIN
  // or unprivileged user-namespaces — neither available to standard k8s
  // containers without elevated securityContext. Without this flag, every
  // shell tool call (git, ls, pwd, ...) fails with "bwrap: Failed to make /
  // slave: Permission denied" inside cloud-codex pods (verified 2026-05-15).
  // The pod is the security perimeter — agent identity is isolated, workspace
  // is PVC-scoped, no host mounts. bwrap inside the pod is redundant.
  // On a laptop wrapper run (sam-local-codex etc.) the same flag is fine: the
  // operator's machine is already the security boundary they signed up for
  // when running `commonly agent run`.
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--dangerously-bypass-approvals-and-sandbox',
    '-o',
    outputFile,
  ];
  if (sessionId) {
    // Place <sessionId> immediately after the `exec resume` subcommand so a
    // future codex parser change can't accidentally consume it as the value
    // of a preceding flag (e.g. -o). Codex's CLI signature is documented as
    // `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`, and this ordering
    // matches that intent unambiguously regardless of clap version.
    return ['exec', 'resume', sessionId, ...common, prompt];
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

    if (ctx.cwd && ctx.environment?.mcp?.length) {
      await writeCodexMcpConfig(ctx.cwd, {
        runtimeToken: ctx.runtimeToken,
        instanceUrl: ctx.instanceUrl,
      });
    }

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
