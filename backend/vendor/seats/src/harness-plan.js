/**
 * Which harness a seat runs a turn on, and what it does when that harness
 * cannot serve.
 *
 * A seat declares a run config: a primary entry {harness, model, effort?} and
 * an ordered fallback list of the same shape. `runTurnWithFallback` tries the
 * active entry. When the attempt fails with one of FALLBACK_KINDS (the harness
 * cannot serve anyone right now: not signed in, out of quota, the provider
 * does not take this model), it moves to the next entry in the same turn, so
 * the turn is still served. Every other failure is thrown unchanged and no
 * switch happens. A content refusal in particular never switches: re-sending
 * refused content through another provider is refusal-shopping.
 *
 * While a fallback is active, the next turn after the failed entry's cooldown
 * starts from the primary again. That turn is the probe: if the primary
 * answers, the seat is back on it. If it fails with a fallback kind or a
 * retryable liveness kind (PROBE_CARRY_KINDS), the same turn carries on down
 * the list. Any other failure, an unnamed one included, ends the turn there:
 * an adapter's upstream refusal reaches this module as an unnamed error, and
 * carrying it on would be the same refusal-shopping. Either way the cooldown
 * restarts, so the next turn stays on the seat's own entry.
 *
 * An entry the host's policy blocks is skipped and never attempted. An entry
 * the host cannot take right now (a per-model concurrency cap, a stop file;
 * the caller's `acquire`) is skipped for this turn only. If no entry served,
 * the turn fails visibly; nothing substitutes a harness the config does not
 * list.
 *
 * Pure: state goes in and comes out as plain data, persisted by the caller,
 * and time is passed in. Nothing here reads a file or the clock.
 */
import { RunFailure, failureKindOf } from './failures.js';

/** The failure kinds that move a turn to the next entry. Nothing else does. */
export const FALLBACK_KINDS = Object.freeze(['not_authenticated', 'quota', 'provider_unsupported']);

/**
 * The failure kinds on which a failed probe carries on to the seat's own
 * entry: the fallback kinds, and the retryable kinds that say the primary
 * never produced an answer. An allowlist, so a kind added later ends a probe
 * turn until someone decides otherwise.
 */
export const PROBE_CARRY_KINDS = Object.freeze([...FALLBACK_KINDS, 'stuck', 'timeout', 'exited']);

/** How long a failed entry rests before a turn probes it again, per kind. */
export const PROBE_COOLDOWN_MS = Object.freeze({
  quota: 15 * 60 * 1000,
  not_authenticated: 30 * 60 * 1000,
  provider_unsupported: 60 * 60 * 1000,
});

/**
 * Why a seat's active entry changed, as `harness.switched` records it:
 * a fallback kind, `blocked` (the active entry is blocked by policy), `probe`
 * (a probe moved back up the list) and `operator` (`commonly agent use`).
 */
export const SWITCH_REASONS = Object.freeze([...FALLBACK_KINDS, 'blocked', 'probe', 'operator']);

/** Fallback entries a config may list after its primary. */
export const MAX_FALLBACK = 5;
/** Switches kept in state.history, newest last. */
export const HISTORY_LIMIT = 20;

const HARNESS = /^[a-z][a-z0-9-]{0,31}$/;
// No '@' and no whitespace: '@' separates the effort in the short form.
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const EFFORT = /^[a-z]{1,16}$/;
const REASON = /^[A-Za-z0-9][A-Za-z0-9 ._:/#()-]{0,119}$/;

const fail = (message) => { throw new Error(`harness plan: ${message}`); };
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const refuseUnknownKeys = (value, allowed, where) => {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unknown field ${where}${key}`);
};

/**
 * One entry, as an object or the short form `harness/model[@effort]`
 * (`claude/claude-sonnet-5-5@high`). The harness is everything before the first '/',
 * so a model may itself contain '/' (`opencode/litellm/deepseek-flash-1017`).
 */
export const parseEntry = (value, where = 'entry') => {
  let entry = value;
  if (typeof value === 'string') {
    const slash = value.indexOf('/');
    if (slash < 1) fail(`${where} must read harness/model[@effort], got ${JSON.stringify(value)}`);
    const rest = value.slice(slash + 1);
    const at = rest.lastIndexOf('@');
    entry = at === -1
      ? { harness: value.slice(0, slash), model: rest }
      : { harness: value.slice(0, slash), model: rest.slice(0, at), effort: rest.slice(at + 1) };
  }
  if (!isPlainObject(entry)) fail(`${where} must be an object or harness/model[@effort]`);
  refuseUnknownKeys(entry, ['harness', 'model', 'effort'], `${where}.`);
  if (typeof entry.harness !== 'string' || !HARNESS.test(entry.harness)) fail(`${where}.harness must match ${HARNESS}`);
  if (typeof entry.model !== 'string' || !MODEL.test(entry.model)) fail(`${where}.model must match ${MODEL}`);
  if (entry.effort !== undefined && (typeof entry.effort !== 'string' || !EFFORT.test(entry.effort))) {
    fail(`${where}.effort must match ${EFFORT}, or be absent`);
  }
  return Object.freeze({ harness: entry.harness, model: entry.model, ...(entry.effort ? { effort: entry.effort } : {}) });
};

export const entryLabel = (entry) => `${entry.harness}/${entry.model}${entry.effort ? `@${entry.effort}` : ''}`;

/**
 * `{harness, model, effort?, fallback?: [entry, …]}` → `{primary, fallback, chain, key}`.
 * Refuses unknown fields, a fallback longer than MAX_FALLBACK and a repeated
 * entry (an entry listed twice would be retried under another position).
 */
export const validateRunConfig = (config) => {
  if (!isPlainObject(config)) fail('run config must be an object');
  refuseUnknownKeys(config, ['harness', 'model', 'effort', 'fallback'], 'config.');
  const primary = parseEntry({
    harness: config.harness, model: config.model, ...(config.effort !== undefined ? { effort: config.effort } : {}),
  }, 'config');
  const list = config.fallback ?? [];
  if (!Array.isArray(list)) fail('config.fallback must be an array');
  if (list.length > MAX_FALLBACK) fail(`config.fallback lists at most ${MAX_FALLBACK} entries`);
  const fallback = list.map((item, index) => parseEntry(item, `config.fallback[${index}]`));
  const chain = [primary, ...fallback];
  const labels = chain.map(entryLabel);
  const repeated = labels.find((label, index) => labels.indexOf(label) !== index);
  if (repeated) fail(`config lists ${repeated} twice`);
  return Object.freeze({ primary, fallback: Object.freeze(fallback), chain: Object.freeze(chain), key: labels.join(' > ') });
};

/**
 * Host policy: `{blocked?: [{harness?, model?, reason}], limits?: [{model, maxConcurrent}]}`.
 * A blocked rule names a harness, a model or both, and matches an entry when
 * every field it names is equal. The reason is a short operator word (a task
 * id), recorded with each skip. A limit caps how many turns on this host run
 * one model at once; it is enforced by the caller's `acquire`, which this
 * module only consults. Absent or empty policy blocks and caps nothing.
 */
export const validatePolicy = (policy) => {
  if (policy === undefined || policy === null) return Object.freeze({ blocked: Object.freeze([]), limits: Object.freeze([]) });
  if (!isPlainObject(policy)) fail('policy must be an object');
  refuseUnknownKeys(policy, ['blocked', 'limits'], 'policy.');
  const list = policy.blocked ?? [];
  if (!Array.isArray(list)) fail('policy.blocked must be an array');
  const blocked = list.map((rule, index) => {
    const where = `policy.blocked[${index}]`;
    if (!isPlainObject(rule)) fail(`${where} must be an object`);
    refuseUnknownKeys(rule, ['harness', 'model', 'reason'], `${where}.`);
    if (rule.harness === undefined && rule.model === undefined) fail(`${where} names a harness, a model or both`);
    if (rule.harness !== undefined && (typeof rule.harness !== 'string' || !HARNESS.test(rule.harness))) fail(`${where}.harness must match ${HARNESS}`);
    if (rule.model !== undefined && (typeof rule.model !== 'string' || !MODEL.test(rule.model))) fail(`${where}.model must match ${MODEL}`);
    if (typeof rule.reason !== 'string' || !REASON.test(rule.reason)) fail(`${where}.reason must match ${REASON}`);
    return Object.freeze({ ...rule });
  });
  const capList = policy.limits ?? [];
  if (!Array.isArray(capList)) fail('policy.limits must be an array');
  const limits = capList.map((limit, index) => {
    const where = `policy.limits[${index}]`;
    if (!isPlainObject(limit)) fail(`${where} must be an object`);
    refuseUnknownKeys(limit, ['model', 'maxConcurrent'], `${where}.`);
    if (typeof limit.model !== 'string' || !MODEL.test(limit.model)) fail(`${where}.model must match ${MODEL}`);
    if (!Number.isInteger(limit.maxConcurrent) || limit.maxConcurrent < 1) fail(`${where}.maxConcurrent must be an integer >= 1`);
    return Object.freeze({ model: limit.model, maxConcurrent: limit.maxConcurrent });
  });
  const models = limits.map((limit) => limit.model);
  const twice = models.find((model, index) => models.indexOf(model) !== index);
  if (twice) fail(`policy.limits lists ${twice} twice`);
  return Object.freeze({ blocked: Object.freeze(blocked), limits: Object.freeze(limits) });
};

/** The concurrency cap for this entry's model, or null. */
export const limitFor = (entry, policy) => (policy?.limits || []).find((limit) => limit.model === entry.model) || null;

/** The rule that blocks this entry, or null. */
export const blockedBy = (entry, policy) => (policy?.blocked || []).find((rule) => (
  (rule.harness === undefined || rule.harness === entry.harness)
  && (rule.model === undefined || rule.model === entry.model)
)) || null;

/** State for a config that has never run: on the primary, nothing to probe. */
export const initialState = (plan) => ({
  v: 1, configKey: plan.key, active: 0, since: null, reason: null, nextProbeAt: null, history: [],
});

// A persisted probe time as ms. An ISO string (a hand-edited or foreign
// state file) is read as its time; anything unreadable means the probe is due.
const probeTimeOf = (value) => {
  if (Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
};

// State written by another version starts over. State for another config
// (the operator switched the seat) starts over on the new primary and keeps
// its history; the operator command records its own switch.
const stateFor = (plan, state) => {
  if (!isPlainObject(state) || state.v !== 1) return initialState(plan);
  if (state.configKey !== plan.key) {
    return { ...initialState(plan), history: Array.isArray(state.history) ? state.history.slice(-HISTORY_LIMIT) : [] };
  }
  const active = Number.isInteger(state.active) && state.active >= 0 && state.active < plan.chain.length ? state.active : 0;
  return {
    ...initialState(plan), ...state, active, nextProbeAt: probeTimeOf(state.nextProbeAt),
    history: Array.isArray(state.history) ? state.history : [],
  };
};

/**
 * The entry indices this turn tries, in order. From the active entry down;
 * from the primary when a fallback is active and its probe is due.
 */
export const turnOrder = (plan, state, now) => {
  const current = stateFor(plan, state);
  const probing = current.active > 0 && (current.nextProbeAt === null || now >= current.nextProbeAt);
  const start = probing ? 0 : current.active;
  return { probing, order: plan.chain.map((_, index) => index).slice(start) };
};

const iso = (ms) => new Date(ms).toISOString();

/**
 * Run one turn on the plan.
 *
 * @param {object} args
 * @param {ReturnType<typeof validateRunConfig>} args.plan
 * @param {ReturnType<typeof validatePolicy>} [args.policy]
 * @param {object} [args.state]     what the last turn returned; absent for a first run
 * @param {number} args.now         ms since the epoch
 * @param {(entry, info: {index, fresh, probing, switch}) => Promise<any>} args.attempt
 *   runs the turn on one entry. `fresh` is true when the entry is not the one
 *   the seat was on, so the caller starts a new session for it. `switch` is
 *   then `{from, to, reason}` (reason in SWITCH_REASONS) for the caller to
 *   write into that attempt's trace as `harness.switched`; null otherwise.
 * @param {(entry, {limit}) => Promise<{release?: Function}|{unavailable: string}>} [args.acquire]
 *   asked before each attempt; `{unavailable}` skips the entry for this turn
 *   (its cap is full, the host holds it). `release` runs when the attempt
 *   settles. Default: every entry is available.
 * @param {(error) => string|null} [args.classify]  the failure kind; default failureKindOf
 * @param {(skip: {entry, reason, blocked}) => void} [args.onSkip]  per skipped entry
 * @returns {Promise<{result, entry, index, state, attempts}>}
 *   On failure it rejects with the failure that ended the turn, carrying
 *   `harnessState` (persist it as on success) and `harnessAttempts`.
 */
export const runTurnWithFallback = async ({
  plan, policy, state, now, attempt, acquire = async () => ({}), classify = failureKindOf, onSkip = () => {},
}) => {
  if (!plan?.chain?.length) fail('runTurnWithFallback needs a validated plan');
  if (!Number.isFinite(now)) fail('runTurnWithFallback needs now');
  const current = stateFor(plan, state);
  const { probing, order } = turnOrder(plan, current, now);
  const was = plan.chain[current.active];
  const attempts = [];
  let lastKind = null;
  let probeKind = null;
  let lastError = null;
  const skip = (entry, reason, blocked) => {
    attempts.push({ entry: entryLabel(entry), outcome: blocked ? 'blocked' : 'unavailable', reason });
    try { onSkip({ entry, reason, blocked }); } catch { /* a listener never fails a turn */ }
  };

  const cooldownOf = (kind) => PROBE_COOLDOWN_MS[kind] ?? PROBE_COOLDOWN_MS.quota;
  const failWith = (error, next) => {
    error.harnessState = next;
    error.harnessAttempts = attempts;
    return error;
  };

  for (const index of order) {
    const entry = plan.chain[index];
    const rule = blockedBy(entry, policy);
    if (rule) { skip(entry, rule.reason, true); continue; }
    // eslint-disable-next-line no-await-in-loop
    const slot = await acquire(entry, { limit: limitFor(entry, policy) });
    if (typeof slot?.unavailable === 'string') { skip(entry, slot.unavailable, false); continue; }
    const fresh = index !== current.active;
    // Why this attempt is not on the seat's entry: what failed above it, a
    // probe moving up, or the entries above it skipped.
    let reason = null;
    if (fresh) reason = index < current.active ? 'probe' : (lastKind || 'blocked');
    try {
      // eslint-disable-next-line no-await-in-loop
      const result = await attempt(entry, {
        index, fresh, probing, switch: fresh ? { from: was, to: entry, reason } : null,
      });
      attempts.push({ entry: entryLabel(entry), outcome: 'ok' });
      const next = { ...current, active: index };
      if (fresh) {
        const why = index < current.active ? 'recovered' : reason;
        next.since = iso(now);
        next.reason = why;
        next.history = [...current.history, { at: iso(now), from: entryLabel(was), to: entryLabel(entry), reason: why }]
          .slice(-HISTORY_LIMIT);
      }
      // Back on the primary there is nothing to probe. On a fallback, the
      // next probe waits out the cooldown of what failed above it this turn;
      // a turn that simply stayed put keeps the probe time it had.
      if (index === 0) next.nextProbeAt = null;
      else if (probeKind || fresh) next.nextProbeAt = now + cooldownOf(probeKind || lastKind);
      return { result, entry, index, attempts, state: next };
    } catch (error) {
      const kind = classify(error);
      attempts.push({ entry: entryLabel(entry), outcome: 'failed', kind: kind || null });
      const probeFailed = probing && index < current.active;
      if (probeFailed && probeKind === null) probeKind = kind || 'unnamed';
      // Not a reason to change harness: the turn fails as it would have with
      // no fallback configured, and the seat stays where it was. A probe that
      // failed only for want of an answer (PROBE_CARRY_KINDS) carries on to
      // the seat's own entry; any other probe failure ends the turn too.
      const carries = probeFailed ? PROBE_CARRY_KINDS.includes(kind) : FALLBACK_KINDS.includes(kind);
      if (!carries) {
        // A probe failed this turn, so the primary rests again whatever ended
        // the turn; otherwise the next turn would probe it straight away.
        const next = probeKind ? { ...current, nextProbeAt: now + cooldownOf(probeKind) } : current;
        throw failWith(error, next);
      }
      // Only a failure at or below the seat's entry is a reason to move down
      // from it; a probe's failures above it are the probe's own (probeKind).
      if (FALLBACK_KINDS.includes(kind) && index >= current.active) lastKind = kind;
      lastError = error;
    } finally {
      try { slot?.release?.(); } catch { /* releasing never fails a turn */ }
    }
  }
  // Nothing served. Stay on the entry the seat was on and push the probe out,
  // so the next turn does not go straight back to an entry that just failed.
  const next = { ...current };
  if (current.active > 0 && (lastKind || probeKind)) next.nextProbeAt = now + cooldownOf(probeKind || lastKind);
  const summary = attempts.map((a) => (a.outcome === 'failed' ? `${a.entry} ${a.kind || 'failed'}` : `${a.entry} ${a.outcome} (${a.reason})`)).join(', ');
  if (lastError) throw failWith(lastError, next);
  // Every entry was skipped: by policy alone it cannot run at all; with any
  // entry merely unavailable it may run once a slot frees, and is retryable.
  const onlyBlocked = attempts.every((a) => a.outcome === 'blocked');
  throw failWith(new RunFailure(onlyBlocked ? 'unsupported' : 'capacity', `no entry in the run config could run: ${summary}`), next);
};
