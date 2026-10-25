/**
 * The compatibility suite. Each check is
 *   { id, title, run(target, env) → { status: 'pass'|'fail'|'skip', detail, ms? } }
 * where `env` is the per-target harness (compat/harness.js). Checks share turns
 * through env.turn(name, …) so a fresh PONG is paid for once, not five times.
 *
 * Every check runs under its own timeout (runCheck); a check that never
 * settles is reported as a failure, and its open turns are cancelled.
 */
import { isNamedFailure } from './harness.js';

const pass = (detail) => ({ status: 'pass', detail });
const fail = (detail) => ({ status: 'fail', detail });
const skip = (detail) => ({ status: 'skip', detail });

const PONG = 'PONG';
const RESUMED = 'PONG-2';

// Prompts carry a fake-provider directive, so a real CLI's own system prompt
// cannot change what the provider answers.
const freshTurn = (env) => env.turn('fresh', `Reply with the single word ${PONG}. [[reply:${PONG}]]`);
const resumedTurn = async (env) => {
  const first = await freshTurn(env);
  const sessionId = first.ok ? first.result.newSessionId : null;
  if (!sessionId) return null;
  return env.turn('resumed', `Reply with the single word ${RESUMED}. [[reply:${RESUMED}]]`, { sessionId });
};
const refusalTurn = (env) => env.turn('refusal', 'Answer this. [[refuse]]');
const upstreamTurn = (env) => env.turn('upstream-5xx', 'Answer this. [[fail:503]]');
const stallTurn = (env) => env.turn('stall', 'Answer this. [[stall]]', { timeoutMs: env.timeouts.stallMs });
const ALL_TURNS = [freshTurn, resumedTurn, refusalTurn, upstreamTurn, stallTurn];

const describeError = (error) => (isNamedFailure(error)
  ? `RunFailure ${error.kind}: ${error.detail || error.message}`
  : `unnamed ${error?.name || typeof error}: ${String(error?.message ?? error)}`);
const quote = (text, limit = 160) => JSON.stringify(String(text ?? '').slice(0, limit));

// The turn checks need a binary; without one they would only repeat detect's
// failure in five more confusing words.
const needsBinary = async (env, then) => {
  const { found } = await env.detect();
  return found ? then() : skip('detect() found no binary');
};

export const CHECKS = [
  {
    id: 'detect',
    title: 'detect() finds the binary and reports a version',
    async run(target, env) {
      const { found, error } = await env.detect();
      if (error) return fail(`detect() threw: ${describeError(error)}`);
      if (!found) return fail(env.binaryPath ? `detect() returned null (expected ${target.binaryLabel || 'the pinned binary'})` : 'detect() returned null');
      if (!found.version) return fail('detect() returned no version');
      return pass(`found ${found.version}`);
    },
  },
  {
    id: 'version-pin',
    title: "the version matches the target's pin",
    async run(target, env) {
      const { found } = await env.detect();
      if (!found?.version) return skip('no version to compare');
      return String(found.version) === String(target.version)
        ? pass(`pinned ${target.version}`)
        : fail(`detected ${found.version}, pinned ${target.version}`);
    },
  },
  {
    id: 'fresh-turn',
    title: 'one fresh turn answers PONG through the fake provider',
    run: (target, env) => needsBinary(env, async () => {
      const turn = await freshTurn(env);
      if (!turn.ok) return fail(`turn failed: ${describeError(turn.error)}`);
      if (!turn.requests.length) return fail('the provider was never called');
      const text = String(turn.result.text ?? '');
      return text.includes(PONG)
        ? pass(`answered in ${turn.ms}ms with ${turn.requests.length} provider request(s)`)
        : fail(`reply ${quote(text)} does not contain ${PONG}`);
    }),
  },
  {
    id: 'exact-reply',
    title: 'the reply text is exact, with nothing extra',
    run: (target, env) => needsBinary(env, async () => {
      const turn = await freshTurn(env);
      if (!turn.ok) return skip('no reply (fresh turn failed)');
      const text = String(turn.result.text ?? '');
      if (text === PONG) return pass(`reply is exactly ${PONG}`);
      return text.trim() === PONG
        ? pass(`reply is ${PONG} with surrounding whitespace ${quote(text)}`)
        : fail(`reply ${quote(text)} is not exactly ${PONG}`);
    }),
  },
  {
    id: 'resume-session',
    title: 'a resumed second turn keeps the session id',
    run: (target, env) => needsBinary(env, async () => {
      const first = await freshTurn(env);
      if (!first.ok) return skip('no first turn to resume');
      const id = first.result.newSessionId;
      if (!id) return skip('the adapter returns no session id');
      const second = await resumedTurn(env);
      if (!second.ok) return fail(`resumed turn failed: ${describeError(second.error)}`);
      const text = String(second.result.text ?? '');
      if (!text.includes(RESUMED)) return fail(`resumed turn answered ${quote(text)}, expected ${RESUMED}`);
      const next = second.result.newSessionId;
      if (next && next !== id) return fail('resumed turn returned a different session id');
      return pass(next ? 'session id kept across turns' : 'resumed; the adapter returned no new id, so the first is kept');
    }),
  },
  {
    id: 'refusal',
    title: "a provider refusal surfaces as RunFailure kind 'refusal' and is not retried",
    run: (target, env) => needsBinary(env, async () => {
      const turn = await refusalTurn(env);
      // Real CLIs make more than one provider call per turn (opencode also
      // asks for a session title), so "retried" means more calls than an
      // ordinary turn makes, measured on this target's own fresh turn.
      const fresh = await freshTurn(env);
      const baseline = fresh.ok && fresh.requests.length ? fresh.requests.length : 1;
      const asked = turn.requests.filter((r) => r.directive === 'refuse').length;
      if (turn.ok) return fail(`a refused turn reported success: ${quote(turn.result.text)}`);
      if (!isNamedFailure(turn.error) || turn.error.kind !== 'refusal') return fail(`expected RunFailure refusal, got ${describeError(turn.error)}`);
      if (asked === 0) return fail('reported refusal without asking the provider');
      if (asked > baseline) return fail(`the provider was asked ${asked} times against ${baseline} on an ordinary turn; a refusal must not be retried`);
      return pass(`refusal named after ${asked} provider request(s), as on an ordinary turn`);
    }),
  },
  {
    id: 'provider-5xx',
    title: 'a provider 5xx surfaces as a named failure, not a hang',
    run: (target, env) => needsBinary(env, async () => {
      const turn = await upstreamTurn(env);
      if (turn.ok) return fail(`a 503 turn reported success: ${quote(turn.result.text)}`);
      if (!isNamedFailure(turn.error)) return fail(describeError(turn.error));
      // Ending only at the turn's own deadline means the 5xx was never
      // surfaced: the CLI kept retrying until the adapter gave up on it.
      if (['timeout', 'stuck'].includes(turn.error.kind)) return fail(`the 503 was not surfaced; the turn ran until RunFailure ${turn.error.kind} after ${turn.ms}ms`);
      return pass(`RunFailure ${turn.error.kind} after ${turn.ms}ms`);
    }),
  },
  {
    id: 'stall',
    title: "a stalled provider ends within the adapter's timeout as a named failure",
    timeoutMs: (env) => env.timeouts.stallMs + env.timeouts.graceMs * 2,
    run: (target, env) => needsBinary(env, async () => {
      const limit = env.timeouts.stallMs + env.timeouts.graceMs;
      const turn = await stallTurn(env);
      if (turn.ok) return fail(`a stalled turn reported success: ${quote(turn.result.text)}`);
      if (!isNamedFailure(turn.error)) return fail(describeError(turn.error));
      if (turn.error.kind === 'cancelled') return fail(`ended only when the runner cancelled it (${turn.ms}ms)`);
      if (turn.ms > limit) return fail(`RunFailure ${turn.error.kind} after ${turn.ms}ms, over the ${limit}ms bound`);
      return pass(`RunFailure ${turn.error.kind} after ${turn.ms}ms (timeout ${env.timeouts.stallMs}ms)`);
    }),
  },
  {
    id: 'key-not-in-argv',
    title: 'the provider key never appears in argv',
    timeoutMs: (env) => env.timeouts.turnMs + env.timeouts.stallMs + env.timeouts.graceMs * 2,
    run: (target, env) => needsBinary(env, async () => {
      const turns = (await Promise.all(ALL_TURNS.map((start) => start(env)))).filter(Boolean);
      const processes = turns.reduce((n, t) => n + t.argv.processes, 0);
      const leaks = turns.reduce((n, t) => n + t.argv.leaks, 0);
      if (turns.some((t) => !t.argv.available)) return skip('ps is not available on this host');
      if (leaks) return fail(`the key was in the argv of ${leaks} process(es)`);
      if (!processes) return skip(`the adapter spawned no child process across ${turns.length} turns`);
      return pass(`${processes} process(es) inspected across ${turns.length} turns`);
    }),
  },
  {
    id: 'key-not-in-output',
    title: 'the provider key never appears in the reply or the error text',
    timeoutMs: (env) => env.timeouts.turnMs + env.timeouts.stallMs + env.timeouts.graceMs * 2,
    run: (target, env) => needsBinary(env, async () => {
      const key = env.provider.apiKey;
      const turns = (await Promise.all(ALL_TURNS.map((start) => start(env)))).filter(Boolean);
      const where = [];
      turns.forEach((t, index) => {
        const surfaces = t.ok
          ? [['reply', t.result.text], ['memory summary', t.result.memorySummary]]
          : [['error', t.error?.message], ['error detail', t.error?.detail]];
        surfaces.push(['trace', JSON.stringify(t.events)]);
        for (const [name, text] of surfaces) {
          if (text && String(text).includes(key)) where.push(`${name} of turn ${index + 1}`);
        }
      });
      return where.length ? fail(`the key appeared in the ${where.join(', ')}`) : pass(`${turns.length} turns clean`);
    }),
  },
  {
    id: 'trace-order',
    title: 'the trace has run events in order, when the adapter emits any',
    run: (target, env) => needsBinary(env, async () => {
      const turns = [['fresh', await freshTurn(env)], ['refusal', await refusalTurn(env)]];
      const emitted = turns.reduce((n, [, t]) => n + t.events.length, 0);
      if (!emitted) return skip('the adapter emits no trace events');
      const problems = [];
      let withRunEvents = 0;
      for (const [name, t] of turns) {
        const unknown = t.events.filter((e) => !e.known).map((e) => e.type);
        if (unknown.length) problems.push(`${name}: unknown event types ${unknown.join(', ')}`);
        const types = t.events.map((e) => e.type);
        if (!types.some((type) => type.startsWith('run.'))) continue;
        withRunEvents += 1;
        const settled = types.filter((type) => type === 'run.settled').length;
        if (types[0] !== 'run.started') problems.push(`${name}: first event is ${types[0]}, not run.started`);
        if (settled !== 1) problems.push(`${name}: ${settled} run.settled events`);
        if (types[types.length - 1] !== 'run.settled') problems.push(`${name}: run.settled is not the last event`);
        const outcome = t.events.find((e) => e.type === 'run.settled')?.data?.outcome;
        const expected = t.ok ? 'ok' : 'failed';
        if (settled === 1 && outcome !== expected) problems.push(`${name}: settled ${outcome}, expected ${expected}`);
      }
      if (problems.length) return fail(problems.join('; '));
      if (!withRunEvents) return skip(`${emitted} event(s), none of them run events`);
      return pass(`${emitted} events, run events in order on ${withRunEvents} turn(s)`);
    }),
  },
];

/** Run one check with its own deadline. Never throws; never outlives the deadline. */
export const runCheck = async (check, target, env, { timeoutMs } = {}) => {
  const budget = timeoutMs ?? (typeof check.timeoutMs === 'function' ? check.timeoutMs(env) : check.timeoutMs)
    ?? env.timeouts.checkMs;
  const started = Date.now();
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), budget);
  });
  try {
    const outcome = await Promise.race([
      Promise.resolve().then(() => check.run(target, env)).then((value) => ({ value }), (error) => ({ error })),
      deadline,
    ]);
    if (outcome.timedOut) {
      env.cancelPending?.(`check ${check.id} ran out of time`);
      return { status: 'fail', detail: `check timed out after ${budget}ms`, ms: Date.now() - started };
    }
    if (outcome.error) return { status: 'fail', detail: `check threw: ${describeError(outcome.error)}`, ms: Date.now() - started };
    const { status, detail } = outcome.value || {};
    if (!['pass', 'fail', 'skip'].includes(status)) return { status: 'fail', detail: `check returned status ${quote(status)}`, ms: Date.now() - started };
    return { status, detail: String(detail ?? ''), ms: outcome.value.ms ?? Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
};
