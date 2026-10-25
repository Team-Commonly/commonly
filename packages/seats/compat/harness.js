/**
 * The per-target harness the checks run against. It owns everything a check
 * must not improvise: the fake provider, the run env, one memoized turn per
 * prompt, the argv watch and the cleanup of anything an adapter left running.
 *
 * Checks see only the generic Adapter contract (src/contract.js) plus
 * ctx.provider, so any adapter — stub, fake-cli, ACP — plugs in unchanged.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { RunFailure, runFailure } from '../src/failures.js';
import { isEventType } from '../src/trace/events.js';

const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,args='];
const POLL_MS = 100;
const SELF = new RegExp(`^(\\S*/)?ps ${PS_ARGS.join(' ')}\\s*$`);

// One `ps` listing, reduced to this process's descendants. Argv is matched
// against the key here and never kept, so a leak cannot travel further.
const descendantsFrom = (listing, rootPid, key) => {
  const rows = [];
  for (const line of String(listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    // The watch's own ps listings are descendants too; they are not the adapter's.
    if (match && !SELF.test(match[3])) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), leaks: !!key && match[3].includes(key) });
  }
  const tree = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (!tree.has(row.pid) && tree.has(row.ppid)) { tree.add(row.pid); grew = true; }
    }
  }
  tree.delete(rootPid);
  return rows.filter((row) => tree.has(row.pid));
};

/**
 * Watch argv of every process this runner descends to while a turn is open.
 * Sampled on the adapter's onSpawn (the child is alive at that instant) and on
 * a short poll, which catches grandchildren and long-lived agent processes.
 */
export const watchArgv = (key, { rootPid = process.pid } = {}) => {
  const seen = new Set();
  const leaked = new Set();
  let available = true;
  const absorb = (listing) => {
    for (const row of descendantsFrom(listing, rootPid, key)) {
      seen.add(row.pid);
      if (row.leaks) leaked.add(row.pid);
    }
  };
  const snapshot = () => {
    const probe = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 5000 });
    if (probe.error || probe.status !== 0) { available = false; return; }
    absorb(probe.stdout);
  };
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    execFile('ps', PS_ARGS, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      inFlight = false;
      if (error) available = false; else absorb(stdout);
    });
  }, POLL_MS);
  timer.unref();
  return {
    snapshot,
    stop() { clearInterval(timer); snapshot(); },
    get report() { return { available, processes: seen.size, leaks: leaked.size }; },
  };
};

/** Kill whatever an adapter left behind under this runner (best effort). */
export const killDescendants = (rootPid = process.pid) => {
  const probe = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 5000 });
  if (probe.error || probe.status !== 0) return 0;
  const rows = descendantsFrom(probe.stdout, rootPid, '');
  for (const row of rows) {
    try { process.kill(row.pid, 'SIGKILL'); } catch { /* already gone */ }
  }
  return rows.length;
};

// Only names a CLI needs to start: never the host's own secrets.
const runEnv = ({ home, binaryPath }) => {
  const xdg = (name) => { const dir = join(home, name); mkdirSync(dir, { recursive: true }); return dir; };
  const path = [binaryPath ? dirname(binaryPath) : null, process.env.PATH].filter(Boolean).join(delimiter);
  return {
    PATH: path,
    HOME: home,
    TMPDIR: xdg('tmp'),
    XDG_CONFIG_HOME: xdg('.config'),
    XDG_DATA_HOME: xdg('.local/share'),
    XDG_STATE_HOME: xdg('.local/state'),
    XDG_CACHE_HOME: xdg('.cache'),
    LANG: process.env.LANG || 'C.UTF-8',
    NO_COLOR: '1',
  };
};

/**
 * @param {object} opts
 * @param {import('../src/contract.js').Adapter} opts.adapter
 * @param {{ baseURL: string, apiKey: string, model: string, requests: object[] }} opts.provider
 * @param {string} [opts.binaryPath]
 * @param {{ turnMs: number, stallMs: number }} opts.timeouts
 */
export const createHarness = ({ adapter, provider, binaryPath = null, timeouts }) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-compat-'));
  const home = join(root, 'home');
  const cwd = join(root, 'work');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const env = runEnv({ home, binaryPath });
  const pending = new Set();
  const turns = new Map();
  let detection;

  const detect = () => {
    if (!detection) {
      detection = Promise.resolve().then(() => adapter.detect({ env, binaryPath }))
        .then((found) => ({ found: found || null }), (error) => ({ found: null, error }));
    }
    return detection;
  };

  const runTurn = async (prompt, { sessionId, timeoutMs = timeouts.turnMs } = {}) => {
    const events = [];
    const controller = new AbortController();
    pending.add(controller);
    const watch = watchArgv(provider.apiKey);
    const trace = {
      emit(type, data = {}) { events.push({ seq: events.length + 1, type, data, known: isEventType(type) }); },
    };
    const ctx = {
      provider: { baseURL: provider.baseURL, apiKey: provider.apiKey, model: provider.model },
      env: { ...env },
      cwd,
      trace,
      signal: controller.signal,
      onSpawn: () => watch.snapshot(),
      timeoutMs,
      agentName: 'compat',
      ...(sessionId ? { sessionId } : {}),
    };
    const firstRequest = provider.requests.length;
    const started = Date.now();
    let outcome;
    try {
      const result = await adapter.spawn(prompt, ctx);
      outcome = { ok: true, result: result || {} };
    } catch (error) {
      outcome = { ok: false, error };
    } finally {
      watch.stop();
      pending.delete(controller);
    }
    return {
      ...outcome,
      ms: Date.now() - started,
      events,
      argv: watch.report,
      requests: provider.requests.slice(firstRequest),
    };
  };

  /** The same named turn is run once per target and shared by every check that reads it. */
  const turn = (name, prompt, opts) => {
    if (!turns.has(name)) turns.set(name, runTurn(prompt, opts));
    return turns.get(name);
  };

  // A check that ran out of time leaves its turn open; cancel it so the next
  // check starts clean and the adapter is told to stop its child.
  const cancelPending = (why) => {
    for (const controller of pending) controller.abort(runFailure('cancelled', why));
  };

  const dispose = () => {
    cancelPending('the compatibility run finished');
    rmSync(root, { recursive: true, force: true });
  };

  return {
    adapter, provider, binaryPath, timeouts, env, cwd,
    detect, turn, cancelPending, dispose,
  };
};

export const isNamedFailure = (error) => error instanceof RunFailure
  || (error?.name === 'RunFailure' && typeof error?.kind === 'string');
