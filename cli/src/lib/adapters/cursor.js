/**
 * cursor adapter — wraps the local Cursor CLI (`cursor-agent` / `agent`).
 *
 * No @commonlyai/mcp child and no default MCP/sandbox/grant-broker wiring in
 * default-environment.js: this seat's hands are the Cursor CLI's own tools;
 * Commonly I/O stays in the `commonly agent run` loop, which posts the
 * returned text.
 *
 * Contract: ADR-005 §Adapter pattern.
 *
 * Headless: `agent -p --output-format json --trust --force "<prompt>"` with
 * `--resume <session_id>` for continuity. Legacy binary name: `cursor-agent`.
 *
 * Test seam: `ctx._spawnImpl` replaces `child_process.spawn` in unit tests.
 */

import { spawn as childSpawn, spawnSync } from 'child_process';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { adapterFailure } from '../upstream-refusal.js';

const DEFAULT_TIMEOUT_MS = (() => {
  const fallback = 15 * 60 * 1000;
  const raw = process.env.COMMONLY_AGENT_RUN_TIMEOUT_MS;
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
})();

const CURSOR_RE = /cursor/i;
const CANDIDATE_COMMANDS = ['cursor-agent', 'agent'];

const resolvePath = (cmd) => {
  const where = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (where.status === 0) return (where.stdout || '').trim() || cmd;
  return cmd;
};

const probeCommand = (cmd) => {
  const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return null;
  const stdout = (res.stdout || '').trim();
  const stderr = (res.stderr || '').trim();
  const versionText = `${stdout}\n${stderr}`.trim();
  const path = resolvePath(cmd);

  if (cmd !== 'cursor-agent') {
    if (!CURSOR_RE.test(versionText) && !CURSOR_RE.test(path)) return null;
  }

  const versionMatch = versionText.match(/(\d+\.\d+(?:\.\d+)?(?:[-+][\w.-]+)?)/);
  const version = versionMatch ? versionMatch[1] : (stdout.split(/\s+/)[0] || 'unknown');
  return { cmd, path, version };
};

const resolveBinary = () => {
  for (const cmd of CANDIDATE_COMMANDS) {
    const hit = probeCommand(cmd);
    if (hit) return hit;
  }
  return null;
};

const buildArgs = ({ prompt, sessionId, model, workspace }) => {
  const args = ['-p', '--output-format', 'json', '--trust', '--force'];
  if (sessionId) args.push('--resume', sessionId);
  if (model) args.push('--model', model);
  if (workspace) args.push('--workspace', workspace);
  args.push(prompt);
  return args;
};

const parseResultJson = (stdout) => {
  const trimmed = (stdout || '').trim();
  if (!trimmed) throw new Error('cursor produced no stdout');
  let payload;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    throw new Error('cursor stdout was not JSON');
  }
  if (payload.is_error) {
    throw adapterFailure('cursor', payload.result || 'cursor reported is_error', { limit: 2000 });
  }
  if (payload.type !== 'result' || payload.subtype !== 'success') {
    throw new Error(`cursor unexpected JSON shape: type=${payload.type} subtype=${payload.subtype}`);
  }
  return {
    text: String(payload.result ?? ''),
    newSessionId: payload.session_id || null,
  };
};

const runCursor = ({
  binary,
  args,
  cwd,
  env,
  timeoutMs,
  spawnImpl = childSpawn,
}) => new Promise((resolve, reject) => {
  const proc = spawnImpl(binary, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
    if (timedOut) return reject(new Error(`cursor timed out after ${timeoutMs}ms`));
    if (code !== 0) {
      return reject(adapterFailure('cursor', stderr.trim() || `exit ${code}`, { exitCode: code, limit: 500 }));
    }
    try {
      resolve(parseResultJson(stdout));
    } catch (err) {
      const tail = stderr.trim();
      reject(new Error(tail ? `${err.message}: ${tail}` : err.message));
    }
  });
});

export default {
  name: 'cursor',
  runtimeType: 'cursor',

  async detect() {
    try {
      const hit = resolveBinary();
      if (!hit) return null;
      return { path: hit.path, version: hit.version };
    } catch {
      return null;
    }
  },

  async spawn(prompt, ctx = {}) {
    const hit = resolveBinary();
    if (!hit) throw new Error('cursor CLI not found on PATH');

    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
    });
    const model = ctx.environment?.model;
    const workspace = ctx.cwd || ctx.workspacePath || null;
    const args = buildArgs({
      prompt: fullPrompt,
      sessionId: ctx.sessionId || null,
      model: typeof model === 'string' && model.trim() ? model.trim() : null,
      workspace,
    });

    const result = await runCursor({
      binary: hit.cmd,
      args,
      cwd: ctx.cwd,
      env: ctx.env || process.env,
      timeoutMs: ctx.timeoutMs || DEFAULT_TIMEOUT_MS,
      spawnImpl: ctx._spawnImpl,
    });

    return {
      text: result.text,
      newSessionId: result.newSessionId || ctx.sessionId || null,
    };
  },
};
