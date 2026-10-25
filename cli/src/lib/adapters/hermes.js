import { observeSpawn, controlsFromArguments } from '../runtime-observation.js';
/** Hermes 0.22.2 local CLI wrapper. Hermes owns provider I/O; this file only spawns it. */
import { requireSeatModel, seatModelRequired } from './seat-model.js';
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdir } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import { buildMemoryPreamble } from '../memory-bridge.js';
import { effectiveSandboxTrust } from '../environment.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

export const TESTED_HERMES_VERSION = '0.22.2';
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15000;
const MAX_STDERR_CHARS = 4096;
const MAX_LINE_CHARS = 1024 * 1024;

const readVersion = (env, spawnSyncImpl = spawnSync) => {
  let probe;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    probe = spawnSyncImpl('hermes', ['--version'], {
      encoding: 'utf8', env, timeout: VERSION_TIMEOUT_MS,
    });
    if (probe.error?.code === 'ENOENT') return null;
    if (probe.error || probe.status !== 0) continue;
    const version = String(probe.stdout || '').match(/Hermes Agent v([^\s]+)/i)?.[1];
    if (version !== TESTED_HERMES_VERSION) {
      throw new Error(`Hermes ${version || 'unknown'} is unsupported; this adapter requires ${TESTED_HERMES_VERSION}`);
    }
    return version;
  }
  const status = probe.status ?? 'none';
  const signal = probe.signal ?? 'none';
  const code = probe.error?.code ?? 'none';
  throw new Error(`Hermes version probe failed after 2 attempts (status=${status}, signal=${signal}, code=${code}, timeout=${VERSION_TIMEOUT_MS}ms); check the Hermes installation or startup log`);
};

export const readHermesJsonl = (line, state) => {
  let event;
  try { event = JSON.parse(line); } catch { throw new Error('Hermes emitted invalid JSONL'); }
  if (state.result) throw new Error('Hermes emitted data after its terminal result');
  if (event?.type === 'system' && event.subtype === 'init') {
    state.started = true;
  } else if (event?.type === 'result') {
    state.result = event;
  } else if (!state.started) {
    throw new Error('Hermes emitted an event before init');
  }
};

const runHermes = ({ args, prompt, cwd, env, timeoutMs, spawnImpl, credentials, onSpawn, controls = {} }) => new Promise((resolve, reject) => {
  const child = (spawnImpl || childSpawn)('hermes', args, {
    cwd, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  observeSpawn(child, onSpawn, controls);
  const state = { started: false, result: null };
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let timedOut = false;
  let settled = false;
  let closed = false;
  let stopping = false;
  let killTimer;
  const finish = (error, result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (error) reject(error); else resolve(result);
  };
  const stop = () => {
    if (stopping || closed) return;
    stopping = true;
    child.kill('SIGTERM');
    killTimer = setTimeout(() => {
      if (!closed) child.kill('SIGKILL');
    }, 5000);
  };
  const failAndStop = (error) => {
    stop();
    finish(error);
  };
  const timer = setTimeout(() => {
    timedOut = true;
    stop();
  }, timeoutMs);
  child.on('error', (error) => failAndStop(adapterFailure('Hermes', error?.message || 'spawn failed', { credentials })));
  child.stdout.on('data', (chunk) => {
    if (settled) return;
    buffer += decoder.write(chunk);
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      if (newline > MAX_LINE_CHARS) {
        failAndStop(new Error('Hermes JSONL line exceeded 1 MiB'));
        return;
      }
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) {
        try { readHermesJsonl(line, state); } catch (error) {
          failAndStop(error);
          return;
        }
      }
      newline = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_LINE_CHARS) {
      failAndStop(new Error('Hermes JSONL line exceeded 1 MiB'));
    }
  });
  child.stdout.on('error', (error) => failAndStop(adapterFailure('Hermes stdout', error?.message || 'read failed', { credentials })));
  child.stderr.on('data', (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-MAX_STDERR_CHARS);
  });
  child.on('close', (code) => {
    closed = true;
    clearTimeout(killTimer);
    if (settled) return;
    if (timedOut) return finish(new Error(`Hermes timed out after ${timeoutMs}ms`));
    buffer += decoder.end();
    if (buffer.trim()) {
      try { readHermesJsonl(buffer.trim(), state); } catch (error) { return finish(error); }
    }
    const result = state.result;
    if (!result || !state.started) return finish(new Error('Hermes exited without a complete JSONL result'));
    if (code !== 0 || result.exit_code !== 0) {
      return finish(adapterFailure('Hermes', result.error || stderr || `exit ${code}`, {
        credentials, exitCode: code,
      }));
    }
    if (typeof result.text !== 'string' || !result.session_id) {
      return finish(new Error('Hermes result omitted text or session_id'));
    }
    return finish(null, { text: result.text, newSessionId: result.session_id });
  });
  child.stdin.on('error', (error) => failAndStop(adapterFailure('Hermes stdin', error?.message || 'write failed', { credentials })));
  child.stdin.end(prompt);
});

export default {
  get requiresModel() { return seatModelRequired(); },
  name: 'hermes',
  runtimeType: 'hermes',
  supportsProvider: false,
  providerKeyEnv: 'OPENROUTER_API_KEY',

  async validateEnvironment(environment) {
    if (environment?.provider !== undefined) {
      throw new Error('Hermes adapter does not consume environment.provider; supply OPENROUTER_API_KEY in the host environment');
    }
    if (environment?.mcp?.length) {
      throw new Error('Hermes adapter does not yet consume environment.mcp declarations');
    }
    if (effectiveSandboxTrust(environment?.sandbox?.trust) === 'public'
      || (environment?.sandbox?.mode && environment.sandbox.mode !== 'none')) {
      throw new Error('Hermes public or sandbox-declared seats are unsupported: no enforced confinement adapter exists');
    }
  },

  async detect() {
    const version = readVersion(process.env);
    return version ? { path: 'hermes', version } : null;
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'hermes');
    await this.validateEnvironment(ctx.environment);
    // Keep Hermes away from the operator's default profile, including any
    // Nous Portal/Cloud credentials there. The wrapper provides the sole key.
    const seat = `${ctx.agentName || ''}\0${ctx.cwd || ''}`;
    const home = ctx._hermesHome || join(homedir(), '.commonly', 'hermes', 'profiles',
      createHash('sha256').update(seat).digest('hex').slice(0, 24));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const env = { ...(ctx.env || process.env), HERMES_HOME: home };
    if (!readVersion(env, ctx._spawnSyncImpl)) {
      throw new Error('Hermes Agent 0.22.2 is not on PATH');
    }
    if (!env.OPENROUTER_API_KEY) {
      throw new Error('Supply the operator OPENROUTER_API_KEY through Secret Manager before running Hermes');
    }
    const args = ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json',
      '--provider', 'openrouter', '--source', 'tool', '--no-restore-cwd'];
    if (seatModel) args.push('--model', seatModel);
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    const fullPrompt = buildMemoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
    });
    const requestedTimeout = Number(ctx.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    return runHermes({
      args, prompt: fullPrompt, cwd: ctx.cwd, env, timeoutMs,
      spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(args, { modelFlag: '--model', valueFlags: ['--query-file', '--format', '--provider', '--source', '--resume'] }),
      credentials: spawnCredentials(ctx, ['OPENROUTER_API_KEY']),
    });
  },
};
