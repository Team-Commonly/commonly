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
// A provider watch that stops the CLI at the first refusal on the wire names
// it refusal_retry_loop; both kinds are final and never retried.
const REFUSAL_KINDS = new Set(['refusal', 'refusal_retry_loop']);
const upstreamTurn = (env) => env.turn('upstream-5xx', 'Answer this. [[fail:503]]');
const stallTurn = (env) => env.turn('stall', 'Answer this. [[stall]]', { timeoutMs: env.timeouts.stallMs });
const ALL_TURNS = [freshTurn, resumedTurn, refusalTurn, upstreamTurn, stallTurn];
// The same 503, on the probe adapter (the target's probeOptions, e.g. no
// provider watch), held open for a window so the agent's own retries happen.
const retryProbeTurn = (env) => env.probeTurn?.('retry-5xx', 'Answer this. [[fail:503]]', { timeoutMs: env.timeouts.retryWindowMs }) ?? null;

// Trace events an adapter emits on its own account rather than from what the
// agent streamed; they say nothing about whether a retry report got through.
const LIFECYCLE_EVENT = /^(?:run\.|session\.|turn\.|process\.|permission\.|liveness\.|credential\.)/;
// ACP update kinds that publish session state (commands, mode, config,
// context size). Agents send them whenever they like, and goose 1.56.0 sends
// two right as its first request goes out, so they never count as a report
// about a retry; `usage` is what the adapter maps usage_update to.
const SESSION_STATE = new Set(['available_commands_update', 'current_mode_update', 'config_option_update', 'usage_update']);
const SESSION_STATE_EVENT = new Set(['usage']);
const SAMPLE_CHARS = 600;

const tally = (records) => {
  const kinds = {};
  const metaKeys = new Set();
  for (const { msg } of records) {
    const update = msg.params?.update || {};
    const kind = update.sessionUpdate || 'unknown';
    kinds[kind] = (kinds[kind] || 0) + 1;
    for (const name of Object.keys(update._meta || {})) metaKeys.add(name);
  }
  return { kinds, metaKeys: [...metaKeys].sort() };
};

/**
 * What a recorded ACP turn shows about retries: how often the provider was
 * asked, what the agent streamed while it was still retrying, and what of
 * that reached the trace. Reads only the tap, so it holds for any ACP agent.
 *
 * "While retrying" is placed by the harness stamp (provider requests made so
 * far), not inferred from a kind name: an update counts when the agent had
 * already asked the provider twice and asked again afterwards. The first
 * request is the turn starting, and start-of-turn bookkeeping lands beside
 * it; what an agent sends once it has given up (its error text) lands after
 * the last. Both are reported, as "outside the retries", never as progress.
 */
export const readRetryProbe = (turn, { key = '' } = {}) => {
  const wire = Array.isArray(turn?.wire) ? turn.wire : [];
  const prompt = wire.find((w) => w.dir === 'out' && w.msg?.method === 'session/prompt');
  const at = prompt ? wire.indexOf(prompt) : -1;
  const after = at === -1 ? [] : wire.slice(at + 1);
  const total = (turn?.requests || []).length;
  const inWindow = (record) => Number.isFinite(record.requests) && record.requests >= 2 && record.requests < total;
  const all = after.filter((w) => w.dir === 'in' && w.msg?.method === 'session/update');
  const during = all.filter((w) => inWindow(w) && !SESSION_STATE.has(w.msg.params?.update?.sessionUpdate));
  const answer = prompt ? after.find((w) => w.dir === 'in' && w.msg?.id === prompt.msg.id && !w.msg.method) : null;
  const { kinds, metaKeys } = tally(during);
  const rest = tally(all.filter((w) => !during.includes(w)));
  const promptEvent = (turn?.events || []).findIndex((e) => e.type === 'turn.prompt_sent');
  const surfaced = promptEvent === -1 ? []
    : turn.events.slice(promptEvent + 1).filter((e) => !LIFECYCLE_EVENT.test(e.type) && !SESSION_STATE_EVENT.has(e.type) && inWindow(e));
  const scrub = (text) => (key ? text.split(key).join('<key>') : text);
  return {
    tapped: !!turn?.tapped,
    promptSent: !!prompt,
    failedRequests: (turn?.requests || []).filter((r) => r.directive === 'fail').length,
    updates: during.length,
    kinds,
    metaKeys,
    otherKinds: rest.kinds,
    sample: during[0] ? scrub(JSON.stringify(during[0].msg.params)).slice(0, SAMPLE_CHARS) : null,
    answerMetaKeys: Object.keys(answer?.msg?.result?._meta || answer?.msg?.error?.data?._meta || {}).sort(),
    surfaced: surfaced.map((e) => e.type),
  };
};

const listKinds = (kinds) => Object.entries(kinds).map(([kind, n]) => `${kind}×${n}`).join(', ');
const needsProbe = async (env, then) => needsBinary(env, async () => {
  const turn = await retryProbeTurn(env);
  if (!turn) return skip('the target declares no probeOptions, so the agent is only seen through its adapter');
  const probe = readRetryProbe(turn, { key: env.provider.apiKey });
  if (!probe.tapped) return skip('the adapter took no spawn hook, so the agent\'s own stream was not recorded');
  if (!probe.promptSent) return skip(`no session/prompt was sent (${turn.ok ? 'the turn succeeded' : describeError(turn.error)})`);
  return then(turn, probe);
});

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
    title: "a provider refusal surfaces as RunFailure kind 'refusal' (or 'refusal_retry_loop', stopped on the wire) and is not retried",
    run: (target, env) => needsBinary(env, async () => {
      const turn = await refusalTurn(env);
      // Real CLIs make more than one provider call per turn (opencode also
      // asks for a session title), so "retried" means more calls than an
      // ordinary turn makes, measured on this target's own fresh turn.
      const fresh = await freshTurn(env);
      const baseline = fresh.ok && fresh.requests.length ? fresh.requests.length : 1;
      const asked = turn.requests.filter((r) => r.directive === 'refuse').length;
      if (turn.ok) return fail(`a refused turn reported success: ${quote(turn.result.text)}`);
      if (!isNamedFailure(turn.error) || !REFUSAL_KINDS.has(turn.error.kind)) return fail(`expected RunFailure refusal or refusal_retry_loop, got ${describeError(turn.error)}`);
      if (asked === 0) return fail('reported refusal without asking the provider');
      if (asked > baseline) return fail(`the provider was asked ${asked} times against ${baseline} on an ordinary turn; a refusal must not be retried`);
      return pass(`${turn.error.kind} named after ${asked} provider request(s), as on an ordinary turn`);
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
    id: 'retry-status',
    title: 'while it retries a provider 5xx, the agent reports progress on its own stream',
    timeoutMs: (env) => env.timeouts.retryWindowMs + env.timeouts.graceMs * 3,
    run: (target, env) => needsProbe(env, async (turn, probe) => {
      const window = `${turn.ms}ms`;
      if (probe.failedRequests <= 1) return pass(`no retry: ${probe.failedRequests} provider request(s) in ${window}`);
      const meta = probe.metaKeys.length ? `; _meta keys ${probe.metaKeys.join(', ')}` : '';
      const answered = probe.answerMetaKeys.length ? `; the prompt answer carries _meta ${probe.answerMetaKeys.join(', ')}` : '';
      const outside = Object.keys(probe.otherKinds).length ? `; outside the retries: ${listKinds(probe.otherKinds)}` : '';
      if (!probe.updates) {
        return fail(`${probe.failedRequests} provider requests in ${window} and no session/update between the first and the last${outside}${answered}`);
      }
      return pass(`${probe.updates} session/update(s) between the first and the last of ${probe.failedRequests} provider requests in ${window}: ${listKinds(probe.kinds)}${meta}${outside}${answered}; first ${probe.sample}`);
    }),
  },
  {
    id: 'retry-status-surfaced',
    title: "the adapter's trace carries the agent's retry reports",
    timeoutMs: (env) => env.timeouts.retryWindowMs + env.timeouts.graceMs * 3,
    run: (target, env) => needsProbe(env, async (turn, probe) => {
      if (!probe.updates) return skip('the agent sent no update during its retries, so there is nothing to surface');
      const meta = probe.metaKeys.length ? ` (_meta keys ${probe.metaKeys.join(', ')})` : '';
      if (probe.surfaced.length < probe.updates) {
        return fail(`the agent sent ${listKinds(probe.kinds)}${meta}; the trace carries ${probe.surfaced.length ? probe.surfaced.join(', ') : 'no event'} from them`);
      }
      return pass(`${probe.updates} update(s) reached the trace as ${probe.surfaced.join(', ')}`);
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
