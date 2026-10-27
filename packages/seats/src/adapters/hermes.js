/** Hermes 0.22 local CLI wrapper. Hermes owns provider I/O; this file only spawns it. */
import { spawn as childSpawn, spawnSync } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';
import { StringDecoder } from 'string_decoder';
import { observeSpawn, controlsFromArguments } from '../runtime-observation.js';
import { requireSeatModel } from '../seat-model.js';
import { adapterFailure, spawnCredentials } from '../upstream-refusal.js';

export const SUPPORTED_HERMES_VERSION_RANGE = '>=0.22.5 <0.23.0';
const supportsHermesVersion = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version || '');
  if (!match) return false;
  return Number(match[1]) === 0 && Number(match[2]) === 22 && Number(match[3]) >= 5;
};
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const VERSION_TIMEOUT_MS = 15000;
const MAX_STDERR_CHARS = 4096;
const MAX_LINE_CHARS = 1024 * 1024;
// Keys the wrapper owns in the profile's .env. Every other line is the user's.
const PROFILE_ENV_KEYS = ['OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL'];
const PLAIN_ENV_VALUE = /^[A-Za-z0-9_\-.:/+=@%~]+$/;

const definedKey = (line) => {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
  return match ? match[1] : null;
};

// From 0.22.5 the detached gateway serves a profiles/<hash> home with a child
// env scrubbed of credentials and overlaid with that profile's own .env
// (tools/environments/local.py, served_profile_child_env), so a key in the
// spawn env never reaches the model. Hermes documents <profile>/.env as where
// a profile's API keys live (website/docs/user-guide/profiles.md). The file
// stays after the turn: the gateway outlives the spawn and rereads it.
export const syncProfileEnv = async (home, env) => {
  const owned = PROFILE_ENV_KEYS.filter((key) => env[key]);
  for (const key of owned) {
    if (!PLAIN_ENV_VALUE.test(env[key])) {
      throw new Error(`${key} contains characters a Hermes .env line cannot carry unquoted; refusing to write it`);
    }
  }
  const path = join(home, '.env');
  let current = '';
  try {
    current = await readFile(path, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw new Error(`Cannot read the Hermes profile .env (${error?.code || 'read failed'})`);
  }
  const kept = current.split(/\r?\n/).filter((line, index, lines) => (
    !owned.includes(definedKey(line)) && !(index === lines.length - 1 && line === '')
  ));
  const next = `${[...kept, ...owned.map((key) => `${key}=${env[key]}`)].join('\n')}\n`;
  await chmod(home, 0o700);
  if (next === current) {
    await chmod(path, 0o600);
    return;
  }
  const temp = join(home, `.env.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(temp, next, { mode: 0o600, flag: 'wx' });
    await chmod(temp, 0o600);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw new Error(`Cannot write the Hermes profile .env (${error?.code || 'write failed'})`);
  }
};

const readVersion = (env, spawnSyncImpl = spawnSync) => {
  let probe;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    probe = spawnSyncImpl('hermes', ['--version'], {
      encoding: 'utf8', env, timeout: VERSION_TIMEOUT_MS,
    });
    if (probe.error?.code === 'ENOENT') return null;
    if (probe.error || probe.status !== 0) continue;
    const version = String(probe.stdout || '').match(/Hermes Agent v([^\s]+)/i)?.[1];
    if (!supportsHermesVersion(version)) {
      throw new Error(`Hermes ${version || 'unknown'} is unsupported; this adapter supports ${SUPPORTED_HERMES_VERSION_RANGE}. Run hermes update to install a supported release`);
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

/**
 * @param {import('../contract.js').SeatHost & { profileRoot?: string }} [host]
 *   profileRoot is where each seat's isolated HERMES_HOME is created.
 */
export const createHermesAdapter = ({
  memoryPreamble = (prompt) => prompt,
  effectiveTrust = (trust) => trust,
  seatModelRequired = () => false,
  profileRoot = join(homedir(), '.seats', 'hermes', 'profiles'),
} = {}) => ({
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
    if (effectiveTrust(environment?.sandbox?.trust) === 'public'
      || (environment?.sandbox?.mode && environment.sandbox.mode !== 'none')) {
      throw new Error('Hermes public or sandbox-declared seats are unsupported: no enforced confinement adapter exists');
    }
  },

  async detect() {
    const version = readVersion(process.env);
    return version ? { path: 'hermes', version } : null;
  },

  async spawn(prompt, ctx = {}) {
    const seatModel = requireSeatModel(ctx.environment, 'hermes', seatModelRequired());
    await this.validateEnvironment(ctx.environment);
    // Keep Hermes away from the operator's default profile, including any
    // Nous Portal/Cloud credentials there. The wrapper provides the sole key.
    const seat = `${ctx.agentName || ''}\0${ctx.cwd || ''}`;
    const home = ctx._hermesHome || join(profileRoot,
      createHash('sha256').update(seat).digest('hex').slice(0, 24));
    await mkdir(home, { recursive: true, mode: 0o700 });
    const env = { ...(ctx.env || process.env), HERMES_HOME: home };
    if (!readVersion(env, ctx._spawnSyncImpl)) {
      throw new Error(`Hermes Agent ${SUPPORTED_HERMES_VERSION_RANGE} is not on PATH; install for your OS: https://hermes-agent.nousresearch.com/docs/getting-started/installation`);
    }
    if (!env.OPENROUTER_API_KEY) {
      throw new Error('Supply the operator OPENROUTER_API_KEY through Secret Manager before running Hermes');
    }
    await syncProfileEnv(home, env);
    const cwd = ctx.cwd || process.cwd();
    // 0.22.5's gateway rejects --no-restore-cwd; --in pins the workspace on
    // both fresh and resumed turns. 0.22.2-0.22.4 are refused above, so no
    // version-keyed flag is needed.
    const args = ['chat', '--oneshot', '--query-file', '-', '--format', 'stream-json',
      '--provider', 'openrouter', '--source', 'tool', '--in', cwd];
    if (seatModel) args.push('--model', seatModel);
    if (ctx.sessionId) args.push('--resume', ctx.sessionId);
    const fullPrompt = memoryPreamble(prompt, ctx.memoryLongTerm, {
      freshSession: !ctx.sessionId,
    });
    const requestedTimeout = Number(ctx.timeoutMs);
    const timeoutMs = Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.min(requestedTimeout, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
    return runHermes({
      args, prompt: fullPrompt, cwd, env, timeoutMs,
      spawnImpl: ctx._spawnImpl, onSpawn: ctx.onSpawn, controls: controlsFromArguments(args, { modelFlag: '--model', valueFlags: ['--query-file', '--format', '--provider', '--source', '--in', '--resume'] }),
      credentials: spawnCredentials(ctx, ['OPENROUTER_API_KEY']),
    });
  },
});
