/**
 * One adapter shape for agent CLIs that run one turn per process in their own
 * headless mode (`copilot -p`, `qwen -o stream-json`, `aider --message`, …).
 * The CLI-specific part is a `launch(prompt, ctx)` that returns argv and env,
 * a `read(event, state)` for each stdout line, and a `settle(state)` that
 * turns what was read into a reply. Everything else is here, once: the
 * provider route check, an isolated HOME, the process group, the turn
 * deadline, cancellation, the trace and the scrubbed failure text.
 *
 * The provider key travels in the child env or a 0600 file, never in argv,
 * which any same-user process can read.
 */
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RunFailure, runFailure } from '../failures.js';
import { observeSpawn } from '../runtime-observation.js';
import { traceOf } from '../trace/events.js';
import { scrubAdapterFailure } from '../upstream-refusal.js';

const SAFE_ENV = /^(?:PATH|LANG|LC_[A-Z_]+|TERM|USER|LOGNAME|NO_COLOR|CI|TMPDIR|SSL_CERT_FILE|SSL_CERT_DIR)$/;
const VERSION_TIMEOUT_MS = 15000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const KILL_GRACE_MS = 2000;
const MAX_STDERR_CHARS = 8192;
const MAX_LINE_CHARS = 1024 * 1024;
const FAILURE_LIMIT = 500;
const REFUSAL_WORDING = /content[ _-]?policy|refus|rejected by/i;
const OWN_GROUP = process.platform !== 'win32';

/** The provider route, checked: a plain HTTP(S) base URL, a key and a model. */
export const providerOf = (ctx, label) => {
  const { baseURL, apiKey, model } = ctx?.provider || {};
  let url;
  try { url = new URL(String(baseURL)); } catch {
    throw runFailure('unsupported', `${label}: ctx.provider.baseURL must be an HTTP(S) URL`);
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw runFailure('unsupported', `${label}: ctx.provider.baseURL must be a plain HTTP(S) URL with no credentials, query or fragment`);
  }
  if (typeof apiKey !== 'string' || !apiKey) throw runFailure('unsupported', `${label}: ctx.provider.apiKey is missing`);
  if (typeof model !== 'string' || !model) throw runFailure('unsupported', `${label}: ctx.provider.model is missing`);
  return { url, baseURL: url.href.replace(/\/$/, ''), apiKey, model };
};

/**
 * Safe launch variables plus HOME and XDG roots. HOME comes from ctx.env when
 * the caller gives one, because a resume reads the sessions kept there;
 * without one the spawn gets a throwaway HOME that is removed afterwards.
 */
export const isolatedEnv = async (ctx, label) => {
  const source = ctx.env || process.env;
  const env = Object.fromEntries(Object.entries(source).filter(([name]) => SAFE_ENV.test(name)));
  const callerHome = ctx.env?.HOME;
  const home = callerHome || await mkdtemp(join(tmpdir(), `seats-${label}-home-`));
  env.HOME = home;
  env.XDG_CONFIG_HOME = ctx.env?.XDG_CONFIG_HOME || join(home, '.config');
  env.XDG_DATA_HOME = ctx.env?.XDG_DATA_HOME || join(home, '.local', 'share');
  env.XDG_STATE_HOME = ctx.env?.XDG_STATE_HOME || join(home, '.local', 'state');
  env.XDG_CACHE_HOME = ctx.env?.XDG_CACHE_HOME || join(home, '.cache');
  env.NO_COLOR = '1';
  const removeHome = callerHome ? async () => {} : () => rm(home, { recursive: true, force: true });
  return { env, home, removeHome };
};

/** `<binary> --version`, read with `pattern`; null when the binary is absent or fails. */
export const readVersion = (binary, pattern, { args = ['--version'], env = process.env, spawnSyncImpl = spawnSync } = {}) => {
  const probe = spawnSyncImpl(binary, args, { encoding: 'utf8', env, timeout: VERSION_TIMEOUT_MS });
  if (probe.error || probe.status !== 0) return null;
  const version = pattern.exec(`${probe.stdout || ''}\n${probe.stderr || ''}`)?.[1];
  return version ? { path: binary, version } : null;
};

/**
 * A CLI's own failure text, as a named failure: a 4xx or refusal wording is a
 * refusal (never retried), anything else is the process ending unsettled.
 */
export const failureFromText = (label, text, { credentials = [], exitCode = null } = {}) => {
  const raw = String(text ?? '').trim();
  const { status, detail } = scrubAdapterFailure(raw, { credentials, limit: FAILURE_LIMIT });
  const refusal = (status !== null && status >= 400 && status <= 499) || REFUSAL_WORDING.test(raw);
  const code = exitCode === null ? '' : ` (exit ${exitCode})`;
  const upstream = status === null ? '' : ` upstream ${status}`;
  return runFailure(refusal ? 'refusal' : 'exited', `${label}${code}${upstream}: ${detail || 'no error text'}`, {
    credentials, limit: FAILURE_LIMIT,
  });
};

const signal = (child, sig) => {
  if (OWN_GROUP && child.pid !== undefined) {
    try { process.kill(-child.pid, sig); return; } catch { /* group gone; fall through */ }
  }
  try { child.kill(sig); } catch { /* already gone */ }
};

/**
 * @param {object} spec
 * @param {string} spec.name             adapter name
 * @param {string} spec.cli              CLI name in traces and failures
 * @param {string} spec.command          the command when no binaryPath is given
 * @param {RegExp} spec.versionPattern   reads the version out of `--version`
 * @param {string[]} [spec.versionArgs]
 * @param {(prompt: string, ctx: object, run: { command: string, provider: object, env: object, home: string }) =>
 *   Promise<{ args: string[], env?: object, stdin?: string, state?: object, cleanup?: () => Promise<void> }>} spec.launch
 *   (`state` seeds what read() and settle() see, e.g. a session id the adapter made)
 * @param {(line: string, state: object) => void} spec.read   one stdout line; may set state.text,
 *   state.sessionId, state.error, state.chunks (pushed text, traced as agent.message_chunk)
 * @param {(state: object, end: { code: number|null, stderr: string, credentials: string[] }) =>
 *   { text: string, newSessionId?: string }} [spec.settle]
 */
export const createHeadlessAdapter = (spec) => ({ binaryPath } = {}) => {
  const command = binaryPath || spec.command;
  const versionArgs = spec.versionArgs || ['--version'];
  const settle = spec.settle || ((state, { code, stderr, credentials }) => {
    if (state.error || code !== 0) {
      throw failureFromText(spec.cli, state.error || stderr || `exit ${code}`, { credentials, exitCode: code });
    }
    if (typeof state.text !== 'string') throw runFailure('protocol', `${spec.cli} exited 0 without a reply`);
    return { text: state.text, ...(state.sessionId ? { newSessionId: state.sessionId } : {}) };
  });

  return {
    name: spec.name,
    runtimeType: spec.name,

    async detect() {
      return readVersion(command, spec.versionPattern, { args: versionArgs });
    },

    async spawn(prompt, ctx = {}) {
      const trace = traceOf(ctx);
      const started = Date.now();
      const settled = (outcome, failure) => trace.emit('run.settled', {
        outcome, durationMs: Date.now() - started, attempts: 1,
        ...(failure ? { failure: { kind: failure.kind, detail: failure.detail } } : {}),
      });
      trace.emit('run.started', { adapter: spec.name, cli: { name: spec.cli }, sessionId: ctx.sessionId, attempt: 1 });
      let launched;
      let removeHome = async () => {};
      try {
        const provider = providerOf(ctx, spec.cli);
        const isolated = await isolatedEnv(ctx, spec.cli);
        removeHome = isolated.removeHome;
        launched = await spec.launch(String(prompt ?? ''), ctx, { command, provider, env: isolated.env, home: isolated.home });
      } catch (error) {
        await removeHome();
        const failure = error instanceof RunFailure ? error : runFailure('unsupported', `${spec.cli}: ${error?.message || error}`);
        settled('failed', failure);
        throw failure;
      }
      const credentials = [ctx.provider?.apiKey, ctx.runtimeToken].filter((v) => typeof v === 'string' && v.length >= 8);
      const requested = Number(ctx.timeoutMs);
      const timeoutMs = Number.isFinite(requested) && requested > 0 ? requested : DEFAULT_TIMEOUT_MS;
      trace.emit('turn.prompt_sent', { chars: String(prompt ?? '').length });
      try {
        const end = await run({
          command, launched, ctx, timeoutMs, read: spec.read, trace,
        });
        if (end.ended === 'aborted') {
          throw ctx.signal?.reason instanceof RunFailure ? ctx.signal.reason : runFailure('cancelled', 'the caller cancelled the turn');
        }
        if (end.ended === 'timeout') throw runFailure('timeout', `${spec.cli} made no answer within ${timeoutMs}ms`);
        if (end.ended === 'spawn-error') throw runFailure('exited', `${spec.cli} could not be started: ${end.spawnError}`, { credentials });
        if (end.ended === 'protocol') throw runFailure('protocol', `${spec.cli}: ${end.protocolError}`, { credentials });
        const result = settle(end.state, { code: end.code, stderr: end.stderr, credentials });
        settled('ok');
        return result;
      } catch (error) {
        const failure = error instanceof RunFailure ? error : runFailure('protocol', `${spec.cli}: ${error?.message || error}`, { credentials });
        settled(failure.kind === 'cancelled' ? 'cancelled' : 'failed', failure);
        throw failure;
      } finally {
        await launched.cleanup?.().catch(() => {});
        await removeHome().catch(() => {});
      }
    },
  };
};

const run = ({ command, launched, ctx, timeoutMs, read, trace }) => new Promise((resolve) => {
  const spawnImpl = ctx._spawnImpl || childSpawn;
  const child = spawnImpl(command, launched.args, {
    cwd: ctx.cwd, env: launched.env, stdio: ['pipe', 'pipe', 'pipe'], detached: OWN_GROUP,
  });
  observeSpawn(child, ctx.onSpawn, launched.controls || {});
  const state = { ...(launched.state || {}), chunks: [] };
  const decoder = new StringDecoder('utf8');
  let buffer = '';
  let stderr = '';
  let ended = null;
  let protocolError = null;
  let spawnError = null;
  let killTimer;
  let closed = false;
  const stop = (why) => {
    if (ended || closed) return;
    ended = why;
    signal(child, 'SIGTERM');
    killTimer = setTimeout(() => { if (!closed) signal(child, 'SIGKILL'); }, KILL_GRACE_MS);
    killTimer.unref?.();
  };
  const timer = setTimeout(() => stop('timeout'), timeoutMs);
  const onAbort = () => stop('aborted');
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  if (ctx.signal?.aborted) onAbort();
  const take = (line) => {
    if (!line || ended) return;
    const before = state.chunks.length;
    try { read(line, state); } catch (error) {
      protocolError = error?.message || String(error);
      stop('protocol');
      return;
    }
    for (const text of state.chunks.slice(before)) trace.emit('agent.message_chunk', { text });
  };
  child.stdout.on('data', (chunk) => {
    buffer += decoder.write(chunk);
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).replace(/\r$/, '');
      buffer = buffer.slice(at + 1);
      take(line);
    }
    if (buffer.length > MAX_LINE_CHARS) {
      protocolError = 'a stdout line exceeded 1 MiB';
      stop('protocol');
    }
  });
  child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-MAX_STDERR_CHARS); });
  child.on('error', (error) => { spawnError = error?.code || error?.message || 'spawn failed'; stop('spawn-error'); });
  child.on('close', (code, sig) => {
    closed = true;
    clearTimeout(timer);
    clearTimeout(killTimer);
    ctx.signal?.removeEventListener('abort', onAbort);
    take(`${buffer}${decoder.end()}`.trim());
    // Whatever the CLI started in its group (MCP servers, tool shells) goes too.
    if (OWN_GROUP && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group gone */ } }
    trace.emit('process.exited', { code, signal: sig });
    resolve({ state, code, stderr, ended, protocolError, spawnError });
  });
  child.stdin.on('error', () => {});
  child.stdin.end(launched.stdin ?? '');
});

/**
 * An adapter for a CLI that cannot be pointed at the run's provider. detect()
 * still reads the pinned binary, so the matrix proves it is installed; every
 * turn fails as RunFailure provider_unsupported with `detail`, before any
 * process starts, so a check reads a named reason rather than a hang.
 */
export const createProviderUnsupportedAdapter = ({ name, cli, command, versionPattern, versionArgs, detail }) => ({ binaryPath } = {}) => {
  const bin = binaryPath || command;
  return {
    name,
    runtimeType: name,
    supportsProvider: false,
    async detect() { return readVersion(bin, versionPattern, { args: versionArgs || ['--version'] }); },
    async spawn(_prompt, ctx = {}) {
      const trace = traceOf(ctx);
      const failure = runFailure('provider_unsupported', `${cli}: ${detail}`);
      trace.emit('run.started', { adapter: name, cli: { name: cli }, attempt: 1 });
      trace.emit('run.settled', { outcome: 'failed', failure: { kind: failure.kind, detail: failure.detail }, durationMs: 0, attempts: 1 });
      throw failure;
    },
  };
};
