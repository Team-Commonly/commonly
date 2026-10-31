/**
 * One model turn of `commonly agent run`, on one of two paths. The supervised
 * path also writes one metadata line per turn (the turn log), once the
 * turn's outcome has reached the pod or failed to.
 *
 *   COMMONLY_SUPERVISE_RUNS=1  (read by performRun as `superviseRuns`)
 *     the turn runs under `superviseRun` from @commonlyai/seats: a stall
 *     window, a wall-clock backstop, and a guarantee the turn settles with a
 *     named failure. No provider relay: the CLI talks to its provider directly,
 *     exactly as on the plain path.
 *   anything else
 *     the plain path: `adapter.spawn(prompt, ctx)` with the caller's ctx object
 *     untouched, and nothing written: the flag-off run loop is main's.
 *
 * A turn is ok only when its outcome reached the pod: the reply was delivered
 * or the agent chose silence. The run loop names the outcome after delivery
 * settles (turn.finish); a spawn that threw is `failed` at once.
 *
 * NO RECORD WRITER. The supervisor needs a trace store. The one here
 * (createMetadataStore) is in memory, lives for one turn, and keeps event type
 * names, times and the recovery action word. It drops every event's data, so
 * no agent text, prompt, reply, failure detail or credential is kept, and
 * nothing is written to disk (a redaction review on #2701).
 *
 * Metrics: ~/.commonly/state/turns/<seat>.jsonl (COMMONLY_TURN_LOG_DIR
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
 * Stall windows per adapter, in ms; 0 is off. Unlisted adapters: off.
 *
 * codex: `codex exec --json` writes a JSONL event per item, so its stdout is a
 *   real progress signal, and the quiet stretch is the longest single item (a
 *   reasoning step or one shell command). Measured 2026-10-25 from per-turn
 *   timestamp gaps in October codex rollouts on one host (~/.codex/sessions):
 *   9,703 turns, max quiet gap 162 s, p99 53 s; 9 turns would have tripped the
 *   package default of 120 s. 15 min is 5.5x the worst gap seen and still
 *   30 min inside the seats' 45 min turn budget.
 * claude: the adapter runs `claude -p --output-format text`, which writes
 *   nothing to stdout until the reply is done. A healthy 14-minute claude turn
 *   is 14 minutes of silence to the supervisor, so any window
 *   under the turn budget would be a turn-length cap, not a liveness check.
 *   Off; claude is guarded by the wall-clock backstop and the cancel ladder.
 */
export const STALL_DEFAULTS_MS = Object.freeze({ codex: 15 * 60 * 1000, claude: 0 });
// How long after the supervisor's abort before it SIGKILLs the child's tree
// (process-group.js). The claude and codex adapters do not act on the abort,
// so on a stall the child is alive at the kill and its whole tree goes with it:
// a SIGTERM to the CLI alone would let it exit first and orphan the MCP
// servers it started in groups of their own, which the tree kill then skips.
// An adapter that honours ctx.signal gets this long to settle.
export const CANCEL_GRACE_MS = 15_000;
// The wall clock sits past the adapter's own timeout, so the adapter's timeout
// (the same SIGTERM and error as on the plain path) fires first; the
// supervisor's only settles a child that outlived it.
export const WALL_BACKSTOP_MS = 60_000;
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
  const dir = env?.COMMONLY_TURN_LOG_DIR || join(homedir(), '.commonly', 'state', 'turns');
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

// What happened to a turn, named by the run loop once delivery settles.
export const TURN_OUTCOMES = Object.freeze([
  'delivered', // the reply reached the pod (wrapper post, the agent's own post, or an ask response)
  'silent', // NO_REPLY, a heartbeat control word, or empty output: nothing to post
  'reply_lost', // the model answered and every delivery rung threw
  'claim_lost', // the lease lapsed mid-turn and a peer owns the message; reply suppressed
  'server_skipped', // the server answered and created nothing (a duplicate, a kept heartbeat)
  'server_refused', // the server refused the post (a run cap)
  'upstream_refused', // the model route refused; the CLI exited with nothing to say
]);
export const OK_OUTCOMES = Object.freeze(['delivered', 'silent']);

const EVENT_TYPE_RE = /^[A-Za-z0-9._-]{1,40}$/;
const iso = (ms) => new Date(ms).toISOString();
const int = (value) => (Number.isInteger(value) ? value : null);

/**
 * The metric line. Every field is listed here, each a number, boolean, null or
 * a short fixed word; nothing from the prompt, the reply, a failure's detail or
 * the environment can reach it.
 */
export const metricLine = (f) => {
  const failed = f.outcome === 'failed';
  const outcome = failed || TURN_OUTCOMES.includes(f.outcome) ? f.outcome : 'unknown';
  return {
    v: 1,
    ts: iso(f.settledMs ?? f.endMs),
    seat: String(f.seat || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 64),
    adapter: String(f.adapter || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32),
    path: f.path === 'supervised' ? 'supervised' : 'legacy',
    eventType: EVENT_TYPE_RE.test(String(f.eventType || '')) ? f.eventType : null,
    turnStart: iso(f.startMs),
    turnEnd: iso(f.endMs),
    durationMs: Math.max(0, f.endMs - f.startMs),
    outcome,
    ok: OK_OUTCOMES.includes(outcome),
    failure: failed ? (f.failureName || 'adapter_error') : null,
    failureSource: failed ? (f.failureSource || null) : null,
    failureClass: failed && typeof f.failureClass === 'string' ? f.failureClass : null,
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
  };
};

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
      + 'trace=memory (no record written); '
      + `metrics → ${metricsPath}${warnings.length ? `; ${warnings.join('; ')}` : ''}`;
  };

  const runSupervised = async (adapter, prompt, ctx, eventType, hold) => {
    const startMs = now();
    const policy = supervisedRunPolicy(turnTimeoutMs, { adapterName: adapter?.name, env });
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
      label: EVENT_TYPE_RE.test(String(eventType || '')) ? eventType : undefined,
    });

    const ok = !supervised.failure;
    if (!ok) await waitForExit(child, EXIT_WAIT_MS);
    const events = store.lastRun()?.events() || [];
    const recovered = (action) => events.some((e) => e.type === 'liveness.recovery' && e.action === action);
    const killed = recovered('kill');
    const named = ok ? null : failureNameOf(supervised.failure);
    const fields = {
      adapter: adapter?.name,
      path: 'supervised',
      eventType,
      startMs,
      endMs: now(),
      outcome: ok ? undefined : 'failed',
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
    };
    // A spawn that resolved is not yet an ok turn: the line waits for the run
    // loop to say what became of the reply.
    if (ok) { hold(fields); return supervised.result; }
    record(fields);
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
    /**
     * One model turn. `run` has adapter.spawn's contract; `finish(outcome)`
     * writes the line once delivery has settled. Only the first finish counts,
     * and a finish with no spawned turn behind it writes nothing.
     */
    begin({ eventType } = {}) {
      let held = null;
      let done = false;
      return {
        run(adapter, prompt, ctx) {
          if (!supervise) return adapter.spawn(prompt, ctx);
          return runSupervised(adapter, prompt, ctx, eventType, (fields) => { held = fields; });
        },
        finish(outcome) {
          if (done || !held) return;
          done = true;
          record({ ...held, outcome, settledMs: now() });
        },
      };
    },
  };
};
