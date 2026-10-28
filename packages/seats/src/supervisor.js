/**
 * The run supervisor: one prompt, one traced run, and a guarantee that the run
 * settles. A turn that hangs is named `stuck` in the trace, cancelled, and if
 * the adapter will not let go, abandoned and settled anyway. Nothing this
 * module starts is allowed to sit in "running" forever.
 *
 * Liveness is read from progress signals, not from the reply: any trace event
 * the adapter emits, and any byte on the stdout/stderr of a child the adapter
 * reports through `ctx.onSpawn`. A run that is busy but quiet past the window
 * is indistinguishable from a hung one, which is why the window is long.
 *
 * The adapter is told (ctx.ownProcessGroup) that it may start its child as the
 * leader of a new process group; a child it marks as one is killed as a group,
 * so the CLI's own children (MCP servers, a native binary behind a launcher)
 * die with it. See process-group.js, which also kills those groups when the
 * wrapper itself is signalled or exits.
 */
import { RunFailure, runFailure, failureKindOf, FAILURE_KINDS } from './failures.js';
import { redactKnownCredentials, scrubAdapterFailure, spawnCredentials } from './upstream-refusal.js';
import { killProcessTree, trackSupervisedGroup, OWN_PROCESS_GROUP } from './process-group.js';

export const SUPERVISOR_DEFAULTS = Object.freeze({
  // Longer than the quiet stretches a healthy turn has: a long-context first
  // token, or a tool (an install, a test suite) whose output the CLI buffers.
  stallMs: 120_000,
  // Covers an adapter's own SIGTERM -> 5 s -> SIGKILL ladder with room to spare.
  cancelGraceMs: 10_000,
  // The turn budget the run loop already enforces (COMMONLY_AGENT_RUN_TIMEOUT_MS's
  // fallback), so supervising a turn does not shorten or lengthen it.
  timeoutMs: 15 * 60 * 1000,
});

export const DEFAULT_RETRY_ON = Object.freeze(['stuck', 'exited', 'timeout']);

// setTimeout overflows past this and fires immediately.
const MAX_TIMER_MS = 2_147_483_647;

/**
 * A turn's wall-clock budget from a caller's request: a positive number of ms,
 * clamped to what a timer can hold. Anything else (absent, zero, negative,
 * not a number) is the default budget. The run loop and the standalone runner
 * both read their budget through this.
 */
export const resolveTurnTimeoutMs = (requested) => {
  const number = Number(requested);
  return Number.isFinite(number) && number > 0 ? Math.min(number, MAX_TIMER_MS) : SUPERVISOR_DEFAULTS.timeoutMs;
};

// The supervisor's own events; an adapter writing them would forge the run's outcome.
const SUPERVISOR_EVENTS = new Set(['run.started', 'run.settled']);

const windowOf = (value, fallback) => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (number === 0 || number === Infinity) return null; // explicitly off
  if (!Number.isFinite(number) || number < 0) throw new Error(`supervisor window must be a non-negative number, got ${value}`);
  return Math.min(number, MAX_TIMER_MS);
};

const resolvePolicy = (policy = {}) => {
  const retry = policy.retry || {};
  return {
    stallMs: windowOf(policy.stallMs, SUPERVISOR_DEFAULTS.stallMs),
    cancelGraceMs: windowOf(policy.cancelGraceMs, SUPERVISOR_DEFAULTS.cancelGraceMs) ?? 0,
    timeoutMs: windowOf(policy.timeoutMs, SUPERVISOR_DEFAULTS.timeoutMs),
    retryMax: Math.max(0, Math.floor(Number(retry.max) || 0)),
    retryOn: Array.isArray(retry.on) ? retry.on : DEFAULT_RETRY_ON,
    onStalled: typeof policy.onStalled === 'function' ? policy.onStalled : null,
  };
};

const isChild = (value) => !!value && typeof value.kill === 'function' && typeof value.once === 'function';
const isAlive = (child) => child.exitCode === null && child.signalCode === null;

// The retryable flag in FAILURE_KINDS outranks the caller's list: a refusal
// listed in `on` is still never re-sent.
const shouldRetry = (failure, attempt, settings) => {
  const kind = failureKindOf(failure);
  return attempt <= settings.retryMax
    && !!kind && FAILURE_KINDS[kind].retryable
    && settings.retryOn.includes(kind)
    && !failure.adapterIgnoredCancel;
};

const outcomeOf = (failure) => {
  if (!failure) return 'ok';
  const kind = failureKindOf(failure);
  if (kind === 'stuck') return 'stuck';
  if (kind === 'cancelled') return 'cancelled';
  return 'failed';
};

// An adapter that threw a bare Error broke the RunFailure rule; its text is
// still scrubbed before it reaches the trace, and it carries no kind rather
// than a guessed one. A RunFailure's detail keeps its shape but loses any
// credential this spawn was handed, whoever built it.
const failureData = (failure, credentials) => (failure instanceof RunFailure
  ? { kind: failure.kind, detail: redactKnownCredentials(failure.detail, credentials) }
  : { kind: null, detail: scrubAdapterFailure(String(failure?.message ?? failure ?? ''), { credentials }).detail });

const sessionIdOf = (failure) => {
  const id = failure?.sessionId ?? failure?.newSessionId;
  return typeof id === 'string' && id ? id : null;
};

const ignoredCancel = (reason, graceMs) => {
  const failure = new RunFailure(reason.kind, `${reason.detail}; the adapter did not settle within ${graceMs}ms of cancellation`);
  failure.adapterIgnoredCancel = true;
  return failure;
};

const callerCancel = (signal) => (failureKindOf(signal.reason) === 'cancelled'
  ? signal.reason : runFailure('cancelled', 'cancelled by the caller'));

/** One attempt. Resolves { result } or { failure }; never rejects, never stays pending. */
const runAttempt = ({ adapter, prompt, ctx, run, settings, attempt, sessionId, external }) => new Promise((resolve) => {
  const controller = new AbortController();
  const children = new Set();
  let live = true;
  let abortedBy = null;
  let lastSignal = Date.now();
  let stallTimer = null;
  let wallTimer = null;
  let graceTimer = null;

  const touch = () => { if (live) lastSignal = Date.now(); };

  const killChildren = () => {
    let killed = 0;
    for (const child of children) {
      if (!isAlive(child)) continue;
      if (killProcessTree(child, 'SIGKILL')) killed += 1;
    }
    return killed;
  };

  const onExternal = () => cancel(callerCancel(external), { recovery: false });

  const finish = (outcome) => {
    if (!live) return;
    live = false;
    clearTimeout(stallTimer);
    clearTimeout(wallTimer);
    clearTimeout(graceTimer);
    external?.removeEventListener?.('abort', onExternal);
    // An adapter that honoured the abort can still leave its child behind.
    if (abortedBy && !outcome.failure?.adapterIgnoredCancel && killChildren() > 0) {
      run.emit('liveness.recovery', { action: 'kill', attempt });
    }
    resolve(outcome);
  };

  function cancel(reason, { recovery = true } = {}) {
    if (abortedBy || !live) return;
    abortedBy = reason;
    clearTimeout(stallTimer);
    clearTimeout(wallTimer);
    if (recovery) run.emit('liveness.recovery', { action: 'cancel', attempt });
    controller.abort(reason);
    graceTimer = setTimeout(() => {
      if (!live) return;
      run.emit('liveness.recovery', { action: 'kill', attempt });
      killChildren();
      finish({ failure: ignoredCancel(reason, settings.cancelGraceMs) });
    }, settings.cancelGraceMs);
  }

  const checkStall = () => {
    if (!live || abortedBy) return;
    const idleMs = Date.now() - lastSignal;
    if (idleMs < settings.stallMs) {
      stallTimer = setTimeout(checkStall, settings.stallMs - idleMs);
      return;
    }
    const windowMs = settings.stallMs;
    run.emit('liveness.stalled', { idleMs, windowMs });
    if (settings.onStalled) {
      // A host's notifier failing must not keep the run from recovering.
      try {
        Promise.resolve(settings.onStalled({ runId: run.runId, adapter: adapter.name, attempt, idleMs, windowMs })).catch(() => {});
      } catch { /* notifier only */ }
    }
    cancel(runFailure('stuck', `no progress signal for ${idleMs}ms (window ${windowMs}ms)`));
  };

  // Counts as progress only while this attempt is live, so a cancelled
  // attempt's late output cannot keep the next one alive or reach the trace.
  // The emit options (the entry's actor) pass through unchanged. `redact` is
  // offered only when the run has one, so prepareRunEnv cannot hand its
  // values to a no-op; it is not gated on `live`, since adding a value to
  // scrub is never unsafe.
  const trace = {
    emit(type, data, options) {
      if (!live || SUPERVISOR_EVENTS.has(type)) return null;
      touch();
      return run.emit(type, data, options);
    },
    ...(typeof run.redact === 'function' ? { redact: (values) => run.redact(values) } : {}),
  };

  // Wraps the caller's onSpawn: every argument reaches it unchanged.
  // A group-leading child is tracked for the wrapper's exit even when it
  // arrives after this attempt ended: it is outside the seat's own group, so
  // nothing else would kill it.
  const onSpawn = (...args) => {
    for (const child of args.filter(isChild)) trackSupervisedGroup(child);
    if (live) {
      touch();
      for (const child of args.filter(isChild)) {
        children.add(child);
        child.stdout?.on?.('data', touch);
        child.stderr?.on?.('data', touch);
      }
    }
    return typeof ctx.onSpawn === 'function' ? ctx.onSpawn(...args) : undefined;
  };

  if (external?.aborted) {
    abortedBy = callerCancel(external);
    finish({ failure: abortedBy });
    return;
  }
  external?.addEventListener?.('abort', onExternal, { once: true });
  if (settings.stallMs) stallTimer = setTimeout(checkStall, settings.stallMs);
  if (settings.timeoutMs) {
    wallTimer = setTimeout(() => cancel(runFailure('timeout', `exceeded the ${settings.timeoutMs}ms wall-clock budget`)), settings.timeoutMs);
  }

  let pending;
  try {
    pending = Promise.resolve(adapter.spawn(prompt, {
      ...ctx, ...(sessionId ? { sessionId } : {}), trace, signal: controller.signal, onSpawn, [OWN_PROCESS_GROUP]: true,
    }));
  } catch (error) {
    pending = Promise.reject(error);
  }
  // Once the supervisor has aborted, the abort's reason is the outcome, even
  // if the adapter answers inside the grace window: the trace already says why.
  pending.then(
    (result) => finish(abortedBy ? { failure: abortedBy } : { result }),
    (error) => finish({ failure: abortedBy || error }),
  );
});

/**
 * Run one prompt under liveness supervision.
 *
 * @param {object} args
 * @param {import('./contract.js').Adapter} args.adapter
 * @param {string} args.prompt
 * @param {object} [args.ctx]  passed to adapter.spawn; `trace`, `signal` and `onSpawn` are wrapped,
 *   and `ownProcessGroup` is set to true.
 *   `ctx.signal`, when given, cancels the run (outcome `cancelled`).
 * @param {ReturnType<import('./trace/store.js').createTraceStore>} args.store
 * @param {object} [args.policy]
 * @param {number} [args.policy.stallMs]        no-progress window; 0 turns it off
 * @param {number} [args.policy.cancelGraceMs]  how long a cancelled adapter has to settle
 * @param {number} [args.policy.timeoutMs]      wall-clock budget per attempt; 0 turns it off
 * @param {{max: number, on?: string[]}} [args.policy.retry]  off unless max > 0
 * @param {(info: {runId, adapter, attempt, idleMs, windowMs}) => void} [args.policy.onStalled]
 * @param {string} [args.runId]
 * @param {string} [args.label]
 * @param {string} [args.taskId]  the board task this run works; needs `podId`
 * @param {string} [args.podId]
 * @param {object} [args.actor]   the run's own party, {type, id, owner?, onBehalfOf?};
 *   entries the run writes without naming an actor (run.started, tool calls,
 *   permission requests) record this one instead of null
 * @returns {Promise<{ runId: string, outcome: string, attempts: number, result?: object, failure?: Error }>}
 */
export const superviseRun = async ({
  adapter, prompt, ctx = {}, store, policy = {}, runId, label, taskId, podId, actor,
} = {}) => {
  if (!adapter || typeof adapter.spawn !== 'function') throw new Error('superviseRun needs an adapter with spawn()');
  if (!store || typeof store.startRun !== 'function') throw new Error('superviseRun needs a trace store');
  const settings = resolvePolicy(policy);
  const run = store.startRun({
    runId, adapter: adapter.name, label, taskId, podId, actor,
  });
  // The runtime token rides in ctx, not through the valet, so the store would
  // not otherwise know to scrub it from agent text.
  if (typeof run.redact === 'function' && typeof ctx.runtimeToken === 'string' && ctx.runtimeToken) {
    run.redact([ctx.runtimeToken]);
  }
  const startedAt = Date.now();
  const external = ctx.signal;
  let attempt = 0;
  let sessionId = ctx.sessionId || null;
  let last = { failure: null };

  try {
    for (;;) {
      attempt += 1;
      run.emit('run.started', { adapter: adapter.name, ...(sessionId ? { sessionId } : {}), attempt });
      last = await runAttempt({ adapter, prompt, ctx, run, settings, attempt, sessionId, external });
      if (!last.failure || external?.aborted || !shouldRetry(last.failure, attempt, settings)) break;
      sessionId = sessionIdOf(last.failure) || sessionId;
      run.emit('liveness.recovery', { action: 'retry', attempt: attempt + 1 });
    }
  } catch (error) {
    // The supervisor's own fault (a trace write failing, say) still settles the run.
    last = { failure: error };
  }

  const outcome = outcomeOf(last.failure);
  const credentials = spawnCredentials(ctx, [adapter.providerKeyEnv].filter(Boolean));
  try {
    run.emit('run.settled', {
      outcome,
      ...(last.failure ? { failure: failureData(last.failure, credentials) } : {}),
      durationMs: Date.now() - startedAt,
      attempts: attempt,
    });
  } catch { /* the outcome is still returned */ }
  return {
    runId: run.runId,
    outcome,
    attempts: attempt,
    ...(last.failure ? { failure: last.failure } : { result: last.result }),
  };
};
