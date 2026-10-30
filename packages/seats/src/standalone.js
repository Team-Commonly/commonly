/**
 * One supervised turn with no server: an adapter, a prompt, a trace store on
 * this machine, and an exit code. This is what `jellymoon run` runs; the
 * caller binds the adapters and parses the command line.
 *
 * Every way the turn can end is a supervised settle, so the trace and the
 * exit code always agree. A CLI that is not installed is found by the
 * adapter's own `detect()` inside the run and settles as `not_installed`; an
 * adapter that threw a bare Error is named from its text where the text names
 * a kind (failure-text.js), and is otherwise left unnamed, never guessed.
 */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { RunFailure, runFailure, failureKindOf } from './failures.js';
import { kindOfAdapterError, errorText } from './failure-text.js';
import { authEnvNames, redactKnownCredentials, spawnCredentials } from './upstream-refusal.js';
import { superviseRun, SUPERVISOR_DEFAULTS } from './supervisor.js';
import { exitCodeOf, failureLine } from './exit-codes.js';

/** Where traces go when the caller names no directory: the OS cache dir. */
export const defaultTraceDir = ({ platform = process.platform, env = process.env, home = homedir() } = {}) => {
  if (platform === 'darwin') return join(home, 'Library', 'Caches', 'jellymoon', 'traces');
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA && isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : join(home, 'AppData', 'Local');
    return join(local, 'jellymoon', 'Cache', 'traces');
  }
  const cache = env.XDG_CACHE_HOME && isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : join(home, '.cache');
  return join(cache, 'jellymoon', 'traces');
};

// The real path of `path`, or of its nearest existing ancestor with the rest
// appended, so a directory that does not exist yet still compares truly
// (macOS /var is /private/var).
const realish = (path) => {
  let head = resolve(path);
  const tail = [];
  while (!existsSync(head)) {
    const parent = dirname(head);
    if (parent === head) break;
    tail.unshift(basename(head));
    head = parent;
  }
  try { head = realpathSync(head); } catch { /* keep the resolved path */ }
  return join(head, ...tail);
};

const within = (root, path) => {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
};

/** The git work tree `cwd` sits in (the nearest ancestor holding `.git`), or null. */
export const workTreeOf = (cwd) => {
  for (let dir = realish(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return dir;
    if (dirname(dir) === dir) return null;
  }
};

/**
 * Why a trace directory may not be used for a run in `cwd`, or null. A trace
 * holds the task and the agent's output, so it never lands inside the
 * repository the agent works in, where it could be committed.
 */
export const traceDirRefusal = (traceDir, cwd) => {
  const tree = workTreeOf(cwd);
  return tree && within(tree, realish(traceDir))
    ? `the trace directory ${traceDir} is inside the repository at ${tree}; pass --trace-dir outside it`
    : null;
};

/** A missing or non-directory cwd, as a reason, or null. */
export const cwdRefusal = (cwd) => {
  try {
    return statSync(cwd).isDirectory() ? null : `--cwd ${cwd} is not a directory`;
  } catch {
    return `--cwd ${cwd} does not exist`;
  }
};

// The key a `--provider-key-file` names. It reaches the CLI through the
// adapter's own config, never through `ctx.env`, so the env scan cannot find it.
const providerKeyFromFile = (ctx) => {
  const keyFile = ctx.environment?.provider?.keyFile;
  if (typeof keyFile !== 'string' || !keyFile) return [];
  try {
    const key = readFileSync(resolve(ctx.cwd || '.', keyFile), 'utf8').trim();
    return key ? [key] : [];
  } catch {
    return [];
  }
};

/**
 * Every credential value this spawn could echo back. The CLI inherits the
 * whole environment, so that is every auth-shaped variable in it (not only the
 * adapter's declared provider key, which claude and codex do not declare),
 * plus the runtime token and a provider key file's contents.
 */
export const standaloneCredentials = (ctx = {}, adapter = {}) => [...new Set([
  ...spawnCredentials(ctx, [...new Set([adapter.providerKeyEnv, ...authEnvNames(ctx.env || process.env)].filter(Boolean))]),
  ...providerKeyFromFile(ctx),
])];

// The same failure with every known credential replaced. A named failure keeps
// its kind; an unnamed Error keeps its identity and loses only the values.
const scrubbed = (error, credentials) => {
  if (!credentials.length || !error || typeof error !== 'object') return error;
  if (error instanceof RunFailure) {
    const clean = new RunFailure(error.kind, redactKnownCredentials(error.detail, credentials));
    for (const key of ['sessionId', 'newSessionId', 'status']) if (error[key] !== undefined) clean[key] = error[key];
    return clean;
  }
  if (typeof error.message === 'string') error.message = redactKnownCredentials(error.message, credentials);
  return error;
};

/**
 * The adapter as a standalone run sees it: `detect()` first, so a missing CLI
 * is a named settle rather than a spawn error, and every bare Error named
 * where its text allows. Every failure is scrubbed of the credentials this
 * spawn could see before it reaches the trace, and the trace store is told the
 * same values, so agent text it records is scrubbed too.
 */
export const standaloneAdapter = (adapter) => ({
  name: adapter.name,
  ...(adapter.providerKeyEnv ? { providerKeyEnv: adapter.providerKeyEnv } : {}),
  async spawn(prompt, ctx = {}) {
    const found = await adapter.detect();
    if (!found) {
      throw new RunFailure('not_installed', `${adapter.name} was not found on PATH`);
    }
    const credentials = standaloneCredentials(ctx, adapter);
    if (credentials.length) ctx.trace?.redact?.(credentials);
    try {
      return await adapter.spawn(prompt, ctx);
    } catch (error) {
      if (error instanceof RunFailure) throw scrubbed(error, credentials);
      const kind = kindOfAdapterError(error);
      if (!kind) throw scrubbed(error, credentials);
      const named = runFailure(kind, errorText(error) || String(error), { credentials, limit: 500 });
      if (error?.sessionId || error?.newSessionId) named.sessionId = error.sessionId || error.newSessionId;
      throw named;
    }
  },
});

/**
 * Run one turn. Never rejects for a run that failed: the failure is the
 * result. Rejects only when the caller's own arguments are unusable.
 *
 * @returns {Promise<{ runId, outcome, kind, exitCode, attempts, settle, text?, sessionId?, failure?, failureLine? }>}
 *   `settle` is the run's `run.settled` entry data as the trace recorded it.
 */
export const runStandaloneTurn = async ({
  adapter, prompt, store, cwd, timeoutMs = SUPERVISOR_DEFAULTS.timeoutMs, stallMs = SUPERVISOR_DEFAULTS.stallMs,
  cancelGraceMs = SUPERVISOR_DEFAULTS.cancelGraceMs, ctx = {}, signal, label, prog = 'jellymoon',
} = {}) => {
  if (!adapter || typeof adapter.spawn !== 'function' || typeof adapter.detect !== 'function') {
    throw new Error('runStandaloneTurn needs an adapter with detect() and spawn()');
  }
  // The supervisor owns the budget. The adapter's own timer is set past it,
  // with the cancel grace on top, so a slow turn settles as the supervisor's
  // named `timeout` and not as the adapter's bare "timed out" error.
  const adapterTimeoutMs = timeoutMs ? timeoutMs + cancelGraceMs + 5_000 : undefined;
  const supervised = await superviseRun({
    adapter: standaloneAdapter(adapter),
    prompt,
    store,
    label,
    policy: { stallMs, timeoutMs, cancelGraceMs, retry: { max: 0 } },
    ctx: {
      ...ctx,
      cwd,
      ...(adapterTimeoutMs ? { timeoutMs: adapterTimeoutMs } : {}),
      ...(signal ? { signal } : {}),
    },
  });
  const entries = store.readRun?.(supervised.runId) || [];
  const settle = entries.filter((entry) => entry.type === 'run.settled').pop()?.data
    || { outcome: supervised.outcome, attempts: supervised.attempts };
  const kind = supervised.outcome === 'ok'
    ? null
    : (failureKindOf(supervised.failure) ?? settle.failure?.kind ?? null);
  const exitCode = exitCodeOf({ outcome: supervised.outcome, failure: kind ? { kind } : null });
  return {
    runId: supervised.runId,
    outcome: supervised.outcome,
    kind,
    exitCode,
    attempts: supervised.attempts,
    settle,
    ...(supervised.result ? {
      text: String(supervised.result.text ?? ''),
      sessionId: supervised.result.newSessionId || null,
    } : {}),
    ...(supervised.failure ? { failure: supervised.failure, failureLine: failureLine(kind, { prog }) } : {}),
  };
};
