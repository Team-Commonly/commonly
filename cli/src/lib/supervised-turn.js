/**
 * One model turn of `commonly agent run`, on one of two paths, and one
 * metadata line per turn on BOTH so they can be compared (the seats canary).
 *
 *   COMMONLY_SUPERVISE_RUNS=1  (read by performRun as `superviseRuns`)
 *     the turn runs under `superviseRun` from @commonlyai/seats: a stall
 *     window, a wall-clock backstop, a per-run provider relay where it is on,
 *     and a guarantee the turn settles with a named failure.
 *   anything else
 *     the plain path: `adapter.spawn(prompt, ctx)` with the caller's ctx object
 *     untouched. Only the metric line is new.
 *
 * NO RECORD WRITER. The supervisor needs a trace store. The one here
 * (createMetadataStore) is in memory, lives for one turn, and keeps event type
 * names, times and the recovery action word. It drops every event's data, so
 * no agent text, prompt, reply, failure detail or credential is kept, and
 * nothing is written to disk (CTO's redact blocker on #2701). The relay
 * branch's file store under ~/.commonly/traces is not used.
 *
 * Metrics: ~/.commonly/state/seats-canary/<seat>.jsonl (COMMONLY_SEATS_CANARY_DIR
 * overrides the directory). Whitelisted fields only; see metricLine.
 */
import { appendFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { superviseRun as defaultSuperviseRun } from '@commonlyai/seats/supervisor';
import { isEventType } from '@commonlyai/seats/trace/events';
import { failureKindOf } from '@commonlyai/seats/failures';
import { classifySpawnFailure } from './spawn-retry.js';

const MAX_TIMER_MS = 2_147_483_647;

/**
 * Stall windows per adapter, in ms; 0 is off. Unlisted adapters: off, as on
 * the relay branch.
 *
 * codex: `codex exec --json` writes a JSONL event per item, so its stdout is a
 *   real progress signal, and the quiet stretch is the longest single item (a
 *   reasoning step or one shell command). Measured 2026-10-25 from per-turn
 *   timestamp gaps in this host's October codex rollouts (~/.codex/sessions):
 *   9,703 turns, max quiet gap 162 s, p99 53 s; 9 turns would have tripped the
 *   package default of 120 s. 15 min is 5.5x the worst gap seen and still
 *   30 min inside the seats' 45 min turn budget.
 * claude: the adapter runs `claude -p --output-format text`, which writes
 *   nothing to stdout until the reply is done. A healthy 14-minute quire turn
 *   (in its log) is 14 minutes of silence to the supervisor, so any window
 *   under the turn budget would be a turn-length cap, not a liveness check.
 *   Off; claude is guarded by the wall-clock backstop and the cancel ladder.
 */
export const STALL_DEFAULTS_MS = Object.freeze({ codex: 15 * 60 * 1000, claude: 0 });
// Above the package default (10 s): the CLI closes its MCP servers on SIGTERM,
// and a SIGKILL that lands mid-shutdown is the orphan we least want.
export const CANCEL_GRACE_MS = 15_000;
// The wall clock sits past the adapter's own timeout, so the adapter's timeout
// (the same SIGTERM and error as on the plain path) fires first; the
// supervisor's only settles a child that outlived it. As on the relay branch.
export const WALL_BACKSTOP_MS = 60_000;
// The provider relay is off for claude by default: ANTHROPIC_BASE_URL against
// a seat's real OAuth login through ~/.claude is untested with the real CLI.
// On for everything else, as on the relay branch.
export const RELAY_DEFAULT_OFF = Object.freeze(['claude']);
// After a failed turn, how long to wait for the child's exit status before
// writing the metric line anyway (the kill lands just before settle).
const EXIT_WAIT_MS = 3_000;

const envName = (prefix, adapterName) => `${prefix}_${String(adapterName || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

const envMs = (env, name, warnings) => {
  const raw = env?.[name];
  if (raw === undefined || raw === '') return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    warnings.push(`${name} ignored (want a non-negative integer of ms)`);
    return undefined;
  }
  return Math.min(value, MAX_TIMER_MS);
};

/**
 * The supervisor policy for one adapter's turn. Env overrides, most specific
 * first: COMMONLY_SUPERVISE_STALL_MS_<ADAPTER>, COMMONLY_SUPERVISE_STALL_MS,
 * COMMONLY_SUPERVISE_CANCEL_GRACE_MS, COMMONLY_SUPERVISE_WALL_BACKSTOP_MS.
 * 0 turns a window off. No retries: the run loop keeps those.
 */
export const supervisedRunPolicy = (turnTimeoutMs, { adapterName = null, env = process.env, warnings = [] } = {}) => {
  const stallMs = envMs(env, envName('COMMONLY_SUPERVISE_STALL_MS', adapterName), warnings)
    ?? envMs(env, 'COMMONLY_SUPERVISE_STALL_MS', warnings)
    ?? STALL_DEFAULTS_MS[adapterName] ?? 0;
  const cancelGraceMs = envMs(env, 'COMMONLY_SUPERVISE_CANCEL_GRACE_MS', warnings) ?? CANCEL_GRACE_MS;
  const backstopMs = envMs(env, 'COMMONLY_SUPERVISE_WALL_BACKSTOP_MS', warnings) ?? WALL_BACKSTOP_MS;
  return {
    stallMs,
    cancelGraceMs,
    timeoutMs: Math.min(Number(turnTimeoutMs) + backstopMs, MAX_TIMER_MS),
  };
};

/** COMMONLY_SUPERVISE_RELAY_<ADAPTER>=1 turns the relay on, =0 off. */
export const relayEnabledFor = (adapterName, env = process.env) => {
  const raw = env?.[envName('COMMONLY_SUPERVISE_RELAY', adapterName)];
  if (raw === '1') return true;
  if (raw === '0') return false;
  return !RELAY_DEFAULT_OFF.includes(adapterName);
};

/**
 * A trace store that keeps no agent text and writes nothing. superviseRun
 * calls startRun once per turn; each event keeps { type, at, action? }.
 */
export const createMetadataStore = ({ now = Date.now } = {}) => {
  let current = null;
  let seq = 0;
  return {
    startRun({ runId } = {}) {
      seq += 1;
      const events = [];
      let settled = false;
      current = {
        runId: runId || `turn-${now().toString(36)}-${seq}`,
        emit(type, data) {
          if (!isEventType(type)) throw new Error(`unknown trace event type: ${type}`);
          if (settled) return null;
          const entry = { type, at: now() };
          if (type === 'liveness.recovery' && typeof data?.action === 'string') entry.action = data.action;
          events.push(entry);
          if (type === 'run.settled') settled = true;
          return entry;
        },
        get settled() { return settled; },
        events: () => events.map((entry) => ({ ...entry })),
      };
      return current;
    },
    lastRun: () => current,
  };
};

export const metricsPathFor = (seat, env = process.env) => {
  const dir = env?.COMMONLY_SEATS_CANARY_DIR || join(homedir(), '.commonly', 'state', 'seats-canary');
  const safe = String(seat || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64) || 'unknown';
  return join(dir, `${safe}.jsonl`);
};

/** A failure's name, never its text. RunFailure kinds are the supervisor's words. */
export const failureNameOf = (error) => {
  const kind = failureKindOf(error) || (typeof error?.kind === 'string' && /^[a-z_]{1,40}$/.test(error.kind) ? error.kind : null);
  if (kind) return { name: kind, source: 'supervisor' };
  const message = String(error?.message ?? error ?? '');
  if (/\btimed out after \d+ms\b/.test(message)) return { name: 'adapter_timeout', source: 'adapter' };
  if (/\bexited with code\b/.test(message)) return { name: 'adapter_exit', source: 'adapter' };
  return { name: 'adapter_error', source: 'adapter' };
};

const failureClassOf = (error) => {
  try { return classifySpawnFailure(error); } catch { return null; }
};

const inferredExitCode = (error) => {
  const match = /\bexited with code (-?\d+)\b/.exec(String(error?.message ?? ''));
  return match ? Number(match[1]) : null;
};

const EVENT_TYPE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const iso = (ms) => new Date(ms).toISOString();
const int = (value) => (Number.isInteger(value) ? value : null);

/**
 * The metric line. Every field is listed here, each a number, boolean, null or
 * a short fixed word; nothing from the prompt, the reply, a failure's detail or
 * the environment can reach it.
 */
export const metricLine = (f) => ({
  v: 1,
  ts: iso(f.endMs),
  seat: String(f.seat || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64),
  adapter: String(f.adapter || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32),
  path: f.path === 'supervised' ? 'supervised' : 'legacy',
  eventType: EVENT_TYPE_RE.test(String(f.eventType || '')) ? f.eventType : null,
  turnStart: iso(f.startMs),
  turnEnd: iso(f.endMs),
  durationMs: Math.max(0, f.endMs - f.startMs),
  outcome: f.ok ? 'ok' : 'failed',
  failure: f.ok ? null : (f.failureName || 'adapter_error'),
  failureSource: f.ok ? null : (f.failureSource || null),
  failureClass: f.ok || typeof f.failureClass !== 'string' ? null : f.failureClass,
  stalled: !!f.stalled,
  cancelled: !!f.cancelled,
  killed: !!f.killed,
  exitCode: int(f.exitCode),
  signal: typeof f.signal === 'string' && /^SIG[A-Z0-9]+$/.test(f.signal) ? f.signal : null,
  exitObserved: !!f.exitObserved,
  childLeftRunning: typeof f.childLeftRunning === 'boolean' ? f.childLeftRunning : null,
  attempts: int(f.attempts),
  stallMs: int(f.policy?.stallMs),
  cancelGraceMs: int(f.policy?.cancelGraceMs),
  timeoutMs: int(f.policy?.timeoutMs),
  relay: f.path === 'supervised' ? !!f.relayOn : null,
  relayStatus: ['covered', 'not_covered'].includes(f.relay?.status) ? f.relay.status : null,
  relayRequests: int(f.relay?.requests),
  relayRefusals: Array.isArray(f.relay?.refusals) ? f.relay.refusals.length : null,
});

const isChild = (value) => !!value && typeof value.once === 'function' && typeof value.kill === 'function';
const isAlive = (child) => !!child && child.exitCode === null && child.signalCode === null;

const waitForExit = (child, ms) => new Promise((resolve) => {
  if (!isAlive(child)) { resolve(); return; }
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  child.once('exit', () => { clearTimeout(timer); resolve(); });
});

/**
 * @param {object} args
 * @param {string} args.seat            agent name; names the metrics file
 * @param {number} args.turnTimeoutMs   the run loop's effective turn budget
 * @param {boolean} args.supervise      performRun's superviseRuns
 * @param {(line: string) => void} [args.log]
 * @param {object} [args.env]
 * @param {Function} [args.superviseRun]  injectable for tests
 */
export const createTurnRunner = ({
  seat,
  turnTimeoutMs,
  supervise = false,
  log = () => {},
  env = process.env,
  now = Date.now,
  superviseRun = defaultSuperviseRun,
} = {}) => {
  const metricsPath = metricsPathFor(seat, env);
  let metricsWarned = false;

  const record = (fields) => {
    try {
      mkdirSync(dirname(metricsPath), { recursive: true, mode: 0o700 });
      appendFileSync(metricsPath, `${JSON.stringify(metricLine({ seat, ...fields }))}\n`, { mode: 0o600 });
    } catch (error) {
      // Metrics never fail a turn. Said once per process, not per turn.
      if (!metricsWarned) {
        metricsWarned = true;
        log(`turn metrics not written (${error?.code || 'error'}); turns are unaffected`);
      }
    }
  };

  /** The boot line for the supervised path; the plain path logs nothing new. */
  const describe = (adapterName) => {
    const warnings = [];
    const policy = supervisedRunPolicy(turnTimeoutMs, { adapterName, env, warnings });
    return `supervised runs ON for ${adapterName}: stall=${policy.stallMs ? `${policy.stallMs}ms` : 'off'}, `
      + `cancel grace=${policy.cancelGraceMs}ms, wall=${policy.timeoutMs}ms, `
      + `relay=${relayEnabledFor(adapterName, env) ? 'on' : 'off'}, trace=memory (no record written); `
      + `metrics → ${metricsPath}${warnings.length ? `; ${warnings.join('; ')}` : ''}`;
  };

  const runPlain = async (adapter, prompt, ctx, eventType) => {
    const startMs = now();
    try {
      const result = await adapter.spawn(prompt, ctx);
      // claude and codex resolve only on exit 0.
      record({ adapter: adapter?.name, path: 'legacy', eventType, startMs, endMs: now(), ok: true, exitCode: 0 });
      return result;
    } catch (error) {
      const { name, source } = failureNameOf(error);
      record({
        adapter: adapter?.name,
        path: 'legacy',
        eventType,
        startMs,
        endMs: now(),
        ok: false,
        failureName: name,
        failureSource: source,
        failureClass: failureClassOf(error),
        exitCode: inferredExitCode(error),
      });
      throw error;
    }
  };

  const runSupervised = async (adapter, prompt, ctx, eventType) => {
    const startMs = now();
    const policy = supervisedRunPolicy(turnTimeoutMs, { adapterName: adapter?.name, env });
    const relayOn = relayEnabledFor(adapter?.name, env);
    const store = createMetadataStore({ now });
    let child = null;
    let exit = null;
    const callerOnSpawn = ctx?.onSpawn;
    const onSpawn = (...args) => {
      const proc = args.find(isChild);
      if (proc) {
        child = proc;
        exit = null;
        proc.once('exit', (code, signal) => { if (child === proc) exit = { code, signal }; });
      }
      return typeof callerOnSpawn === 'function' ? callerOnSpawn(...args) : undefined;
    };

    const supervised = await superviseRun({
      adapter,
      prompt,
      ctx: { ...ctx, onSpawn },
      store,
      policy,
      relay: relayOn ? {} : false,
      label: EVENT_TYPE_RE.test(String(eventType || '')) ? eventType : undefined,
    });

    const ok = !supervised.failure;
    if (!ok) await waitForExit(child, EXIT_WAIT_MS);
    const events = store.lastRun()?.events() || [];
    const recovered = (action) => events.some((e) => e.type === 'liveness.recovery' && e.action === action);
    const killed = recovered('kill');
    const named = ok ? null : failureNameOf(supervised.failure);
    record({
      adapter: adapter?.name,
      path: 'supervised',
      eventType,
      startMs,
      endMs: now(),
      ok,
      failureName: named?.name,
      failureSource: named?.source,
      failureClass: ok ? null : failureClassOf(supervised.failure),
      stalled: events.some((e) => e.type === 'liveness.stalled'),
      cancelled: recovered('cancel'),
      killed,
      exitCode: exit ? exit.code : null,
      signal: exit ? exit.signal : null,
      exitObserved: !!exit,
      childLeftRunning: child ? isAlive(child) : null,
      attempts: supervised.attempts,
      policy,
      relayOn,
      relay: supervised.relay || null,
    });
    if (ok) return supervised.result;
    if (named.source === 'supervisor') {
      // The name goes in the seat log. The throw takes the road a plain-path
      // failure takes: unacked, the run loop's retry policy, onError.
      log(`[${eventType}] supervised turn failed: ${named.name}${killed ? ' (child killed)' : ''}`
        + `${isAlive(child) ? ' (child still running)' : ''}`);
    }
    throw supervised.failure;
  };

  return {
    supervise,
    metricsPath,
    describe,
    /** One model turn. Same contract as adapter.spawn(prompt, ctx). */
    run(adapter, prompt, ctx, { eventType } = {}) {
      return supervise ? runSupervised(adapter, prompt, ctx, eventType) : runPlain(adapter, prompt, ctx, eventType);
    },
  };
};
