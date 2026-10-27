import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FAILURE_KINDS, RunFailure } from '../src/failures.js';
import {
  FALLBACK_KINDS, HISTORY_LIMIT, MAX_FALLBACK, PROBE_CARRY_KINDS, PROBE_COOLDOWN_MS, SWITCH_REASONS,
  entryLabel, initialState, parseEntry, runTurnWithFallback, turnOrder, validatePolicy, validateRunConfig,
} from '../src/harness-plan.js';
import { appendEntry, KINDS } from '../src/record/format.js';
import { EVENT_TYPES } from '../src/trace/events.js';
import { adapterFailure } from '../src/upstream-refusal.js';

const NOW = Date.UTC(2026, 9, 26, 4, 0, 0);
const MIN = 60 * 1000;
const iso = (ms) => new Date(ms).toISOString();

// claude/Sonnet → claude/Haiku → opencode/DeepSeek. No codex/GPT entry: the
// fleet has no GPT access (D111), so no example chain falls back to one.
const CONFIG = {
  harness: 'claude',
  model: 'claude-sonnet-5-5',
  effort: 'high',
  fallback: ['claude/claude-haiku-5-5', 'opencode/litellm/deepseek-flash-1017'],
};
const plan = validateRunConfig(CONFIG);
const [SONNET, HAIKU, DEEPSEEK] = plan.chain.map(entryLabel);

/**
 * An attempt function scripted per entry label: a value resolves, a kind
 * throws a RunFailure of that kind, an Error throws as is. Records each call.
 */
const scripted = (script) => {
  const calls = [];
  const attempt = async (entry, info) => {
    const label = entryLabel(entry);
    calls.push({ label, ...info, switch: info.switch && { from: entryLabel(info.switch.from), to: entryLabel(info.switch.to), reason: info.switch.reason } });
    const step = script[label];
    if (step === undefined) throw new Error(`unscripted attempt on ${label}`);
    if (step instanceof Error) throw step;
    if (typeof step === 'string' && FAILURE_KINDS[step]) throw new RunFailure(step, `${label} said ${step}`);
    return { text: `${label} answered` };
  };
  return { attempt, calls };
};

const run = (script, extra = {}) => {
  const { attempt, calls } = scripted(script);
  return runTurnWithFallback({ plan, now: NOW, attempt, ...extra })
    .then((out) => ({ ...out, calls }), (error) => ({ error, calls }));
};

test('entries: object or short form, the harness before the first slash, the effort after the last @', () => {
  assert.deepEqual(parseEntry('codex/gpt-6-luna@xhigh'), { harness: 'codex', model: 'gpt-6-luna', effort: 'xhigh' });
  assert.deepEqual(parseEntry('opencode/litellm/deepseek-flash-1017'), { harness: 'opencode', model: 'litellm/deepseek-flash-1017' });
  assert.deepEqual(parseEntry({ harness: 'claude', model: 'claude-haiku-5-5' }), { harness: 'claude', model: 'claude-haiku-5-5' });
  assert.equal(entryLabel(parseEntry('codex/gpt-6-luna@xhigh')), 'codex/gpt-6-luna@xhigh');
  for (const bad of ['codex', '/gpt', 'Codex/gpt', 'codex/gpt luna', 'codex/gpt@X-HIGH', 'codex/gpt@', { harness: 'codex', model: 'm', extra: 1 }, 7]) {
    assert.throws(() => parseEntry(bad), /harness plan:/, JSON.stringify(bad));
  }
});

test('a run config refuses unknown fields, a long fallback and a repeated entry', () => {
  assert.equal(plan.key, `${SONNET} > ${HAIKU} > ${DEEPSEEK}`);
  assert.throws(() => validateRunConfig({ ...CONFIG, retries: 2 }), /unknown field config.retries/);
  assert.throws(() => validateRunConfig({ ...CONFIG, fallback: Array.from({ length: MAX_FALLBACK + 1 }, (_, i) => `claude/m-${i}`) }), /at most 5/);
  assert.throws(() => validateRunConfig({ ...CONFIG, fallback: ['claude/claude-sonnet-5-5@high'] }), /lists claude\/claude-sonnet-5-5@high twice/);
  assert.throws(() => validateRunConfig({ harness: 'codex' }), /config.model/);
  assert.deepEqual(validateRunConfig({ harness: 'claude', model: 'claude-haiku-5-5' }).fallback, []);
});

test('the primary answers: no switch, no fresh session, state unchanged', async () => {
  const out = await run({ [SONNET]: 'ok' });
  assert.equal(out.index, 0);
  assert.deepEqual(out.calls.map((c) => [c.label, c.fresh, c.switch]), [[SONNET, false, null]]);
  assert.deepEqual(out.state, initialState(plan));
});

for (const kind of FALLBACK_KINDS) {
  test(`${kind} on the primary moves the same turn to the next entry, in a fresh session, and records why`, async () => {
    const out = await run({ [SONNET]: kind, [HAIKU]: 'ok' });
    assert.equal(out.result.text, `${HAIKU} answered`);
    assert.deepEqual(out.calls.map((c) => [c.label, c.fresh]), [[SONNET, false], [HAIKU, true]]);
    assert.deepEqual(out.calls[1].switch, { from: SONNET, to: HAIKU, reason: kind });
    assert.equal(out.state.active, 1);
    assert.equal(out.state.reason, kind);
    assert.equal(out.state.since, iso(NOW));
    assert.equal(out.state.nextProbeAt, NOW + PROBE_COOLDOWN_MS[kind]);
    assert.deepEqual(out.state.history, [{ at: iso(NOW), from: SONNET, to: HAIKU, reason: kind }]);
  });
}

test('every other failure kind is thrown unchanged, with no switch, and the seat stays put', async () => {
  for (const kind of Object.keys(FAILURE_KINDS).filter((k) => !FALLBACK_KINDS.includes(k))) {
    const out = await run({ [SONNET]: kind, [HAIKU]: 'ok' });
    assert.equal(out.error?.kind, kind, kind);
    assert.deepEqual(out.calls.map((c) => c.label), [SONNET], `${kind} must not reach the next entry`);
    assert.deepEqual(out.error.harnessState, initialState(plan), kind);
  }
  const plain = await run({ [SONNET]: new Error('claude exited with code 1: something else'), [HAIKU]: 'ok' });
  assert.match(plain.error.message, /something else/);
  assert.deepEqual(plain.calls.map((c) => c.label), [SONNET]);
});

test('a refusal never switches harness: the refused content is not sent to another provider', async () => {
  const out = await run({ [SONNET]: 'refusal', [HAIKU]: 'ok', [DEEPSEEK]: 'ok' });
  assert.equal(out.error.kind, 'refusal');
  assert.deepEqual(out.calls.map((c) => c.label), [SONNET]);
});

test('down the whole chain: each fallback kind steps once, and the last entry serves', async () => {
  const out = await run({ [SONNET]: 'quota', [HAIKU]: 'not_authenticated', [DEEPSEEK]: 'ok' });
  assert.equal(out.index, 2);
  assert.deepEqual(out.calls.map((c) => c.switch), [null, { from: SONNET, to: HAIKU, reason: 'quota' }, { from: SONNET, to: DEEPSEEK, reason: 'not_authenticated' }]);
  assert.deepEqual(out.attempts, [
    { entry: SONNET, outcome: 'failed', kind: 'quota' },
    { entry: HAIKU, outcome: 'failed', kind: 'not_authenticated' },
    { entry: DEEPSEEK, outcome: 'ok' },
  ]);
});

test('a policy-blocked entry is skipped and never attempted, and the skip is reported', async () => {
  // DeepSeek is blocked until TASK-401 is lifted.
  const policy = validatePolicy({ blocked: [{ model: 'litellm/deepseek-flash-1017', reason: 'TASK-401' }] });
  const skips = [];
  const out = await run({ [SONNET]: 'quota', [HAIKU]: 'quota', [DEEPSEEK]: 'ok' }, { policy, onSkip: (s) => skips.push([entryLabel(s.entry), s.reason, s.blocked]) });
  assert.deepEqual(out.calls.map((c) => c.label), [SONNET, HAIKU]);
  assert.equal(out.error.kind, 'quota');
  assert.deepEqual(skips, [[DEEPSEEK, 'TASK-401', true]]);
  assert.deepEqual(out.error.harnessAttempts.at(-1), { entry: DEEPSEEK, outcome: 'blocked', reason: 'TASK-401' });
});

test('a blocked primary: the turn starts on the next entry, and says the entries above were skipped', async () => {
  const policy = validatePolicy({ blocked: [{ model: 'claude-sonnet-5-5', reason: 'TASK-390' }] });
  const out = await run({ [HAIKU]: 'ok' }, { policy });
  assert.deepEqual(out.calls.map((c) => [c.label, c.switch?.reason ?? null]), [[HAIKU, 'blocked']]);
  assert.equal(out.state.active, 1);
});

test('every entry blocked or down: the turn fails visibly, and nothing outside the config is tried', async () => {
  const allBlocked = validatePolicy({ blocked: [{ model: 'claude-sonnet-5-5', reason: 'TASK-390' }, { harness: 'claude', reason: 'TASK-391' }, { harness: 'opencode', reason: 'TASK-401' }] });
  const blocked = await run({}, { policy: allBlocked });
  assert.equal(blocked.error.kind, 'unsupported');
  assert.equal(blocked.error.retryable, false);
  assert.match(blocked.error.message, /no entry in the run config could run: claude\/claude-sonnet-5-5@high blocked \(TASK-390\)/);
  assert.deepEqual(blocked.calls, []);

  const down = await run({ [SONNET]: 'quota', [HAIKU]: 'quota', [DEEPSEEK]: 'provider_unsupported' });
  assert.equal(down.error.kind, 'provider_unsupported');
  assert.deepEqual(down.calls.map((c) => c.label), [SONNET, HAIKU, DEEPSEEK]);
  // Nothing served: the seat stays on the entry it was on.
  assert.deepEqual(down.error.harnessState, initialState(plan));
});

test('an entry at its host cap is skipped for this turn only; a slot taken is released', async () => {
  const policy = validatePolicy({ limits: [{ model: 'claude-haiku-5-5', maxConcurrent: 2 }] });
  const asked = [];
  let released = 0;
  const acquire = async (entry, { limit }) => {
    asked.push([entryLabel(entry), limit?.maxConcurrent ?? null]);
    if (entry.model === 'claude-haiku-5-5') return { unavailable: 'claude-haiku-5-5 at its cap (2)' };
    return { release: () => { released += 1; } };
  };
  const out = await run({ [SONNET]: 'quota', [DEEPSEEK]: 'ok' }, { policy, acquire });
  assert.deepEqual(asked, [[SONNET, null], [HAIKU, 2], [DEEPSEEK, null]]);
  assert.deepEqual(out.calls.map((c) => c.label), [SONNET, DEEPSEEK]);
  assert.equal(released, 2);
  assert.deepEqual(out.attempts[1], { entry: HAIKU, outcome: 'unavailable', reason: 'claude-haiku-5-5 at its cap (2)' });

  // Nothing could run, only for want of a slot: retryable, not unsupported.
  const full = await run({}, { acquire: async () => ({ unavailable: 'host stop file' }) });
  assert.equal(full.error.kind, 'capacity');
  assert.equal(full.error.retryable, true);
});

test('policy refuses malformed rules and limits', () => {
  assert.throws(() => validatePolicy({ blocked: [{ reason: 'TASK-401' }] }), /names a harness, a model or both/);
  assert.throws(() => validatePolicy({ blocked: [{ model: 'm', reason: '' }] }), /reason must match/);
  assert.throws(() => validatePolicy({ limits: [{ model: 'claude-opus-5-5', maxConcurrent: 0 }] }), /maxConcurrent/);
  assert.throws(() => validatePolicy({ limits: [{ model: 'm', maxConcurrent: 1 }, { model: 'm', maxConcurrent: 2 }] }), /lists m twice/);
  assert.throws(() => validatePolicy({ allow: [] }), /unknown field policy.allow/);
  assert.deepEqual(validatePolicy(undefined), { blocked: [], limits: [] });
});

test('on a fallback, the next turn stays put until the cooldown, then probes the primary and returns to it', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const before = await runTurnWithFallback({
    plan, state: first.state, now: NOW + PROBE_COOLDOWN_MS.quota - 1, attempt: scripted({ [HAIKU]: 'ok' }).attempt,
  });
  assert.equal(before.index, 1);
  assert.equal(before.state.nextProbeAt, first.state.nextProbeAt, 'a turn that stays put keeps its probe time');

  assert.deepEqual(turnOrder(plan, first.state, NOW + PROBE_COOLDOWN_MS.quota), { probing: true, order: [0, 1, 2] });
  const probe = scripted({ [SONNET]: 'ok' });
  const back = await runTurnWithFallback({ plan, state: before.state, now: NOW + PROBE_COOLDOWN_MS.quota, attempt: probe.attempt });
  assert.equal(back.index, 0);
  assert.deepEqual(probe.calls[0].switch, { from: HAIKU, to: SONNET, reason: 'probe' });
  assert.equal(back.state.nextProbeAt, null);
  assert.deepEqual(back.state.history.at(-1), { at: iso(NOW + PROBE_COOLDOWN_MS.quota), from: HAIKU, to: SONNET, reason: 'recovered' });
});

test('a probe that fails for want of an answer carries on to the seat\'s entry, and the cooldown restarts', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const at = NOW + PROBE_COOLDOWN_MS.quota;
  // The probe's own failure sets the next cooldown. A liveness kind (stuck,
  // timeout, exited) names no fallback kind and rests the shortest, quota's.
  for (const [failure, cooldown] of [
    ['quota', PROBE_COOLDOWN_MS.quota],
    ['provider_unsupported', PROBE_COOLDOWN_MS.provider_unsupported],
    ['stuck', PROBE_COOLDOWN_MS.quota],
    ['timeout', PROBE_COOLDOWN_MS.quota],
    ['exited', PROBE_COOLDOWN_MS.quota],
  ]) {
    const turn = scripted({ [SONNET]: failure, [HAIKU]: 'ok' });
    const out = await runTurnWithFallback({ plan, state: first.state, now: at, attempt: turn.attempt });
    assert.equal(out.index, 1, String(failure));
    // Back on its own entry: same session, no switch.
    assert.deepEqual(turn.calls.map((c) => [c.label, c.fresh]), [[SONNET, true], [HAIKU, false]]);
    assert.equal(out.state.nextProbeAt, at + cooldown, String(failure));
  }
  assert.deepEqual(PROBE_CARRY_KINDS, [...FALLBACK_KINDS, 'stuck', 'timeout', 'exited']);
});

test('any other probe failure ends the turn on the primary, and the primary rests again', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const at = NOW + PROBE_COOLDOWN_MS.quota;
  // The adapter's own shape for an upstream refusal: a plain Error with no
  // kind, exactly as adapters raise it. It must never reach HAIKU.
  const upstream = adapterFailure('claude', 'This content was flagged for possible cybersecurity risk.', { exitCode: 1 });
  for (const failure of [upstream, new Error('claude exited with code 1: unnamed'), 'refusal', 'cancelled', 'credential_denied', 'max_tokens', 'max_turn_requests', 'protocol']) {
    const turn = scripted({ [SONNET]: failure, [HAIKU]: 'ok' });
    const out = await runTurnWithFallback({ plan, state: first.state, now: at, attempt: turn.attempt }).catch((e) => e);
    assert.ok(out instanceof Error, String(failure));
    assert.deepEqual(turn.calls.map((c) => c.label), [SONNET], String(failure));
    // The seat stays on its entry, and the next turn does not probe again at once.
    assert.equal(out.harnessState.active, 1, String(failure));
    assert.equal(out.harnessState.nextProbeAt, at + PROBE_COOLDOWN_MS.quota, String(failure));
    assert.equal(turnOrder(plan, out.harnessState, at + 1).probing, false, String(failure));
  }
});

test('a failed probe restarts the cooldown even when the seat\'s own entry then fails', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const at = NOW + PROBE_COOLDOWN_MS.quota;
  for (const own of ['stuck', 'refusal', new Error('claude exited with code 1: unnamed')]) {
    const turn = scripted({ [SONNET]: 'provider_unsupported', [HAIKU]: own });
    const out = await runTurnWithFallback({ plan, state: first.state, now: at, attempt: turn.attempt }).catch((e) => e);
    assert.deepEqual(turn.calls.map((c) => c.label), [SONNET, HAIKU], String(own));
    assert.equal(out.harnessState.active, 1, String(own));
    assert.equal(out.harnessState.nextProbeAt, at + PROBE_COOLDOWN_MS.provider_unsupported, String(own));
    assert.equal(turnOrder(plan, out.harnessState, at + 1).probing, false, String(own));
  }
});

test('a served turn after a failed probe rests the primary by the probe\'s failure, not the seat\'s', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const at = NOW + PROBE_COOLDOWN_MS.quota;
  const out = await runTurnWithFallback({
    plan, state: first.state, now: at,
    attempt: scripted({ [SONNET]: 'provider_unsupported', [HAIKU]: 'quota', [DEEPSEEK]: 'ok' }).attempt,
  });
  assert.equal(out.index, 2);
  assert.equal(out.state.nextProbeAt, at + PROBE_COOLDOWN_MS.provider_unsupported);
});

test('a persisted probe time that is not a number is read, not trusted as is', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const past = { ...first.state, nextProbeAt: iso(NOW - 60 * MIN) };
  assert.equal(turnOrder(plan, past, NOW).probing, true);
  const future = { ...first.state, nextProbeAt: iso(NOW + 60 * MIN) };
  assert.equal(turnOrder(plan, future, NOW).probing, false);
  assert.equal(turnOrder(plan, { ...first.state, nextProbeAt: 'soon' }, NOW).probing, true);
  // A served turn on the fallback writes it back as a number.
  const stayed = await runTurnWithFallback({ plan, state: future, now: NOW, attempt: scripted({ [HAIKU]: 'ok' }).attempt });
  assert.equal(stayed.state.nextProbeAt, NOW + 60 * MIN);
});

test('a failed probe sets the next probe by the primary\'s failure, not by an entry between', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'not_authenticated', [DEEPSEEK]: 'ok' });
  assert.equal(first.state.active, 2);
  const at = first.state.nextProbeAt;
  const out = await runTurnWithFallback({
    plan, state: first.state, now: at,
    attempt: scripted({ [SONNET]: 'quota', [HAIKU]: 'provider_unsupported', [DEEPSEEK]: 'ok' }).attempt,
  });
  assert.equal(out.index, 2);
  assert.equal(out.state.nextProbeAt, at + PROBE_COOLDOWN_MS.quota);
});

test('a switch names its own reason: a move up is a probe, a move down past a skip is blocked', async () => {
  // The seat is on DEEPSEEK; the primary fails its probe and HAIKU, above the
  // seat, answers. Nothing above DEEPSEEK failed from DEEPSEEK's point of view.
  const onThird = await run({ [SONNET]: 'quota', [HAIKU]: 'not_authenticated', [DEEPSEEK]: 'ok' });
  const up = scripted({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const moved = await runTurnWithFallback({ plan, state: onThird.state, now: onThird.state.nextProbeAt, attempt: up.attempt });
  assert.deepEqual(up.calls.map((c) => c.switch), [
    { from: DEEPSEEK, to: SONNET, reason: 'probe' }, { from: DEEPSEEK, to: HAIKU, reason: 'probe' },
  ]);
  assert.equal(moved.state.reason, 'recovered');
  // The seat is on HAIKU; the probe fails, HAIKU is at its cap, DEEPSEEK
  // serves. HAIKU did not fail with quota; it was skipped.
  const onSecond = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const down = scripted({ [SONNET]: 'quota', [DEEPSEEK]: 'ok' });
  const acquire = async (entry) => (entryLabel(entry) === HAIKU ? { unavailable: 'at its cap' } : {});
  const past = await runTurnWithFallback({ plan, state: onSecond.state, now: onSecond.state.nextProbeAt, attempt: down.attempt, acquire });
  assert.deepEqual(down.calls.map((c) => c.switch?.reason), ['probe', 'blocked']);
  assert.equal(past.state.reason, 'blocked');
});

test('a probe that fails with not_authenticated waits out that kind\'s cooldown, not the one it fell back for', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const at = NOW + PROBE_COOLDOWN_MS.quota;
  const out = await runTurnWithFallback({ plan, state: first.state, now: at, attempt: scripted({ [SONNET]: 'not_authenticated', [HAIKU]: 'ok' }).attempt });
  assert.equal(out.state.nextProbeAt, at + PROBE_COOLDOWN_MS.not_authenticated);
});

test('state for another config starts on its primary and keeps history; a newer version starts over', async () => {
  const first = await run({ [SONNET]: 'quota', [HAIKU]: 'ok' });
  const other = validateRunConfig({ harness: 'claude', model: 'claude-opus-5-5', fallback: ['claude/claude-haiku-5-5'] });
  const turn = scripted({ 'claude/claude-opus-5-5': 'ok' });
  const out = await runTurnWithFallback({ plan: other, state: first.state, now: NOW + 1, attempt: turn.attempt });
  assert.equal(out.index, 0);
  assert.equal(turn.calls[0].fresh, false);
  assert.equal(out.state.configKey, other.key);
  assert.deepEqual(out.state.history, first.state.history);
  const fromFuture = await runTurnWithFallback({ plan, state: { ...first.state, v: 2 }, now: NOW, attempt: scripted({ [SONNET]: 'ok' }).attempt });
  assert.deepEqual(fromFuture.state, initialState(plan));
});

test('history keeps the newest switches only', async () => {
  let state;
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    const now = NOW + i * 2 * 60 * MIN;
    // eslint-disable-next-line no-await-in-loop
    const out = await runTurnWithFallback({
      plan, state, now, attempt: scripted(i % 2 ? { [SONNET]: 'ok' } : { [SONNET]: 'quota', [HAIKU]: 'ok' }).attempt,
    });
    state = out.state;
  }
  assert.equal(state.history.length, HISTORY_LIMIT);
});

test('harness.switched is a trace event and a v1 record kind, validated', () => {
  assert.ok(EVENT_TYPES.includes('harness.switched'));
  assert.deepEqual(KINDS['harness.switched'], { group: 'attempt', actor: 'system' });
  assert.deepEqual(SWITCH_REASONS, ['not_authenticated', 'quota', 'provider_unsupported', 'blocked', 'probe', 'operator']);
  const at = (data) => JSON.parse(appendEntry(null, {
    runId: 'run-hp-1', ts: iso(NOW), kind: 'harness.switched', data,
  }, { runActor: { type: 'agent', id: 'u-1' } }));
  const line = at({ from: SONNET, to: HAIKU, reason: 'quota' });
  assert.deepEqual(line.data, { from: SONNET, to: HAIKU, reason: 'quota' });
  assert.deepEqual(line.actor, { type: 'system', id: 'seats' });
  for (const reason of SWITCH_REASONS) at({ from: SONNET, to: DEEPSEEK, reason });
  assert.throws(() => at({ from: SONNET, to: HAIKU, reason: 'refusal' }), /harness.switched.reason/);
  assert.throws(() => at({ from: SONNET, to: SONNET, reason: 'quota' }), /must differ/);
  assert.throws(() => at({ from: 'codex', to: HAIKU, reason: 'quota' }), /harness.switched.from/);
  assert.throws(() => at({ from: { harness: 'codex', model: 'm' }, to: HAIKU, reason: 'quota' }), /harness.switched.from/);
  assert.throws(() => at({ from: SONNET, to: HAIKU, reason: 'quota', detail: 'x' }), /unknown field harness.switched.detail/);
});
