/**
 * The per-target harness the checks run against. It owns everything a check
 * must not improvise: the fake provider, the run env, one memoized turn per
 * prompt, the argv watch and the cleanup of anything an adapter left running.
 *
 * Checks see only the generic Adapter contract (src/contract.js) plus
 * ctx.provider, so any adapter — stub, fake-cli, ACP — plugs in unchanged.
 */
import { execFile, spawn as childSpawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { RunFailure, runFailure } from '../src/failures.js';
import { isEventType } from '../src/trace/events.js';

const PS_ARGS = ['-A', '-ww', '-o', 'pid=,ppid=,args='];
const POLL_MS = 100;
const SELF = new RegExp(`^(\\S*/)?ps ${PS_ARGS.join(' ')}\\s*$`);

// One `ps` listing, reduced to this process's descendants. Argv is matched
// against the key here and never kept, so a leak cannot travel further.
// `ownPids` are the watch's own ps probes. Matching them by argv alone is not
// enough: a probe that has exited but is not yet reaped lists as
// "[ps] <defunct>", and one caught mid-exec lists as "[node]" or with this
// runner's argv. Neither is the adapter's.
export const descendantsFrom = (listing, rootPid, key, ownPids = new Set()) => {
  const rows = [];
  for (const line of String(listing || '').split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
    if (!match || SELF.test(match[3]) || ownPids.has(Number(match[1]))) continue;
    rows.push({ pid: Number(match[1]), ppid: Number(match[2]), leaks: !!key && match[3].includes(key) });
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
  // Every probe's pid, kept for the watch's life: a poll's listing can show a
  // sync probe mid-exec and is only absorbed after spawnSync has returned it.
  const probes = new Set();
  let available = true;
  let stopped = false;
  const absorb = (listing) => {
    for (const row of descendantsFrom(listing, rootPid, key, probes)) {
      seen.add(row.pid);
      if (row.leaks) leaked.add(row.pid);
    }
  };
  const snapshot = () => {
    const probe = spawnSync('ps', PS_ARGS, { encoding: 'utf8', timeout: 5000 });
    if (Number.isInteger(probe.pid)) probes.add(probe.pid);
    if (probe.error || probe.status !== 0) { available = false; return; }
    absorb(probe.stdout);
  };
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    const child = execFile('ps', PS_ARGS, { encoding: 'utf8', timeout: 5000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      inFlight = false;
      // A poll that lands after stop() would change a report already read.
      if (stopped) return;
      if (error) available = false; else absorb(stdout);
    });
    if (Number.isInteger(child.pid)) probes.add(child.pid);
  }, POLL_MS);
  timer.unref();
  return {
    snapshot,
    stop() { clearInterval(timer); snapshot(); stopped = true; },
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

const WIRE_LIMIT = 2000;

/**
 * A spawn that also records the child's newline-delimited JSON on stdin and
 * stdout, so a probe sees what the agent said before any adapter read it.
 * Lines that are not JSON are not protocol messages and are not kept. The
 * listener is attached in the spawning tick, before the adapter's own, so no
 * chunk is lost to either reader. `stamp()` adds fields to each record; the
 * harness stamps how many provider requests the turn had made by then.
 */
export const tapSpawn = (wire, spawnImpl = childSpawn, { stamp = () => ({}) } = {}) => (command, args, options) => {
  const child = spawnImpl(command, args, options);
  const started = Date.now();
  const reader = (dir) => {
    const decoder = new StringDecoder('utf8');
    let buffer = '';
    return (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let at;
      while ((at = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, at).trim();
        buffer = buffer.slice(at + 1);
        if (!line || wire.length >= WIRE_LIMIT) continue;
        try { wire.push({ dir, ms: Date.now() - started, ...stamp(), msg: JSON.parse(line) }); } catch { /* not a protocol line */ }
      }
    };
  };
  child.stdout?.on('data', reader('in'));
  if (child.stdin) {
    const write = child.stdin.write.bind(child.stdin);
    const out = reader('out');
    child.stdin.write = (chunk, ...rest) => { out(chunk); return write(chunk, ...rest); };
  }
  return child;
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
 * @param {{ turnMs: number, stallMs: number, retryWindowMs?: number }} opts.timeouts
 * @param {import('../src/contract.js').Adapter} [opts.probeAdapter]  the same adapter with
 *   the target's `probeOptions` applied, for checks that read the agent itself
 */
export const createHarness = ({ adapter, provider, binaryPath = null, timeouts, probeAdapter = null }) => {
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

  const runTurn = async (prompt, { sessionId, timeoutMs = timeouts.turnMs, via = adapter, tap = false } = {}) => {
    const events = [];
    const wire = [];
    const tapped = { spawned: false };
    const firstRequest = provider.requests.length;
    // How many provider requests this turn had made at a given instant; an
    // event and a wire line stamped with it can be placed among the retries.
    const stamp = () => ({ requests: provider.requests.length - firstRequest });
    const controller = new AbortController();
    pending.add(controller);
    const watch = watchArgv(provider.apiKey);
    const trace = {
      emit(type, data = {}) { events.push({ seq: events.length + 1, type, data, known: isEventType(type), ...stamp() }); },
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
      // ACP adapters take ctx._spawnImpl; one that ignores it leaves the
      // wire empty and spawned stays false, which the probe checks report.
      ...(tap ? { _spawnImpl: (...args) => { tapped.spawned = true; return tapSpawn(wire, childSpawn, { stamp })(...args); } } : {}),
    };
    const started = Date.now();
    let outcome;
    try {
      const result = await via.spawn(prompt, ctx);
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
      ...(tap ? { wire, tapped: tapped.spawned } : {}),
    };
  };

  /** The same named turn is run once per target and shared by every check that reads it. */
  const turn = (name, prompt, opts) => {
    if (!turns.has(name)) turns.set(name, runTurn(prompt, opts));
    return turns.get(name);
  };

  /**
   * A named turn on the probe adapter with the agent's stdio recorded, or
   * null when the target declares no probe. Memoized like turn().
   */
  const probeTurn = (name, prompt, opts = {}) => {
    if (!probeAdapter) return null;
    const key = `probe:${name}`;
    if (!turns.has(key)) turns.set(key, runTurn(prompt, { ...opts, via: probeAdapter, tap: true }));
    return turns.get(key);
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
    adapter, probeAdapter, provider, binaryPath, timeouts, env, cwd,
    detect, turn, probeTurn, cancelPending, dispose,
  };
};

export const isNamedFailure = (error) => error instanceof RunFailure
  || (error?.name === 'RunFailure' && typeof error?.kind === 'string');
