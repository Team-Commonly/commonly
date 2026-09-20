/**
 * Withhold the grant broker from a seat this daemon cannot confine (TASK-063).
 *
 * The grant arrives as an injected MCP server, and confinement is declared in a
 * different field — `sandbox` — so the two can disagree: a seat can be handed a
 * granter's authority and no confinement. wren's ruling (69799) is REFUSE, not
 * derive, and it is ENTRY-level (69829): the broker entry is withheld and the
 * seat runs, because the seat was never promised confinement — a seat-level
 * refusal is #1727's case only (a declared sandbox the host cannot enforce).
 *
 * This is the daemon half of one refusal with TWO emitters. The server refuses
 * at the projection (`backend/services/grantBrokerConfinement.ts`) for rows it
 * can judge host-independently; the daemon decides the rest, because it is the
 * layer that knows this host, that resolved the adapter locally, and that holds
 * the record the seat actually runs from — including records the projection
 * never reaches (a row naming no adapter, a backend older than the refusal, a
 * hand-written token file). Both halves emit the same `code`.
 *
 * THE ADAPTER IS THE HOST-INDEPENDENT FACT, so the set of adapters this daemon
 * can confine is the set that derives an enforced sandbox — `claude` and
 * `codex` (`ADAPTERS_WITH_DEFAULT_SANDBOX`, imported rather than retyped).
 * Anything else, `pi` included, confines on no host: `pi` refuses a declared
 * sandbox rather than honouring it, so an undeclared one is never derived.
 *
 * ONE REASON THE SERVER DOES NOT HAVE: `sandbox_absent`. The server must ALLOW
 * an absent block (a daemon-provisioned seat's baseline is derived here and is
 * not visible from the installation row — `quill` carries no sandbox key), so
 * absence is this layer's to judge. Reaching it here means the baseline did not
 * supply one, which happens for a local record with no environment of its own
 * (`sandbox: !existing.environment` at the derive sites): nobody authored a
 * sandbox and nothing derived one, so the seat would run unconfined.
 *
 * THE URL IS THE FACT, AND THE URL THIS LAYER HOLDS USUALLY CANNOT BE PARSED.
 * Measured on the live fleet: the broker url in a token record is the
 * UNRESOLVED placeholder `"${COMMONLY_API_URL}/api/mcp/grants/<id>"` (c4-smoke,
 * the only record declaring one). `new URL()` throws on that string, so
 * `isGrantBrokerUrl` — which the pi adapter calls AFTER substituting — returns
 * false here. A daemon-side predicate that reused it unchanged would match
 * nothing and refuse nothing while reading as if it enforced something. So the
 * known placeholders are resolved to this instance first, and an entry counts
 * only when it is OUR broker: our origin, or a relative/placeholder-prefixed
 * path. A foreign server that happens to live under `/api/mcp/grants/` is not
 * our grant and is left alone.
 *
 * AND A MISS HERE IS FAIL-OPEN, so the path is NORMALIZED before it is judged.
 * Measured (vera, 70369): a bound instance spelled `https://api.commonly.me/`
 * turns `"${COMMONLY_API_URL}/api/mcp/grants/g1"` into
 * `https://api.commonly.me//api/mcp/grants/g1`, whose pathname starts `//api/`
 * and matches nothing — the entry goes unrecognised and the broker RIDES into a
 * seat this daemon just decided it cannot confine. Reachable: `agent.js` takes
 * `instanceUrl` from `COMMONLY_API_URL` with a bare `.trim()`, while `config.js`
 * is what strips the slash.
 *
 * The enforcement is ONE mechanism: duplicate slashes are collapsed before the
 * path predicate sees them. It covers the doubled slash whichever side produced
 * it — the join, a hand-written record, and a protocol-relative spelling OF THE
 * PATH (`//api/mcp/grants/g1`, which collapses to the broker's path) — where
 * stripping the instance's trailing slash covers only the join, and a mutation
 * showed the two were redundant here (removing the strip reddened nothing).
 *
 * A URL WITH NO SCHEME HAS TWO READINGS, and both are taken (vera, 70372, who
 * corrected a first draft of this paragraph for claiming the second was
 * covered). Collapsing alone reads `//api.commonly.me/api/mcp/grants/g1` as the
 * PATH `/api.commonly.me/api/...`, which is not the broker's path and measures
 * false — a fail-open, because URL semantics say that string names THIS
 * instance. So a schemeless value is also resolved against the bound instance,
 * and counts when that reading lands on our origin and the broker's path. A
 * foreign host is left alone under either reading; the path reading is what the
 * shipped declarations use, and a record is free to hold the other.
 *
 * Collapsing can only turn a miss into a match, and a match here means WITHHOLD,
 * so it moves in the safe direction; origin equality is still required first, so
 * a foreign server cannot be drawn in by its spelling.
 */
import { isGrantBrokerUrl } from './adapters/pi-mcp-client.mjs';
import { ADAPTERS_WITH_DEFAULT_SANDBOX } from './default-environment.js';
import { LEGACY_SANDBOX_TRUST } from './environment.js';
import { PUBLIC_SANDBOX_MODES, resolvePublicSandboxMode } from './sandbox/mode.js';

/** One typed code, two emitters (`decidedBy` says which one spoke). */
export const GRANT_BROKER_REFUSAL_CODE = 'grant_broker_unconfined';

/**
 * Every mode an adapter enforces for a public seat: the cli's own public set
 * ({workspace, read-only}) plus `bwrap`, which `resolvePublicSandboxMode`
 * resolves to on Linux and claude implements there. Derived from the cli's
 * constants rather than restated, so a mode added to one is not silently
 * missing from the other.
 */
export const ENFORCING_MODES = new Set([...PUBLIC_SANDBOX_MODES, 'bwrap']);

const URL_PLACEHOLDERS = ['${COMMONLY_API_URL}', '${COMMONLY_INSTANCE_URL}'];
const PARSE_ANCHOR = 'https://grant-declaration.invalid';

/** `internal` → `public`; anything else (including absent) is itself. */
const effectiveTrust = (trust) => (
  typeof trust === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_SANDBOX_TRUST, trust)
    ? LEGACY_SANDBOX_TRUST[trust]
    : trust
);

/**
 * A bound instance is only trimmed here (`agent.js` does the same). Any
 * trailing slash it carries is deliberately left alone: the doubled slash it
 * would manufacture is answered by `collapseSlashes` below, one mechanism for
 * every spelling rather than two that a mutation cannot tell apart.
 */
const resolveInstance = (instanceUrl) => (
  typeof instanceUrl === 'string' ? instanceUrl.trim() : ''
);

/**
 * `//api/mcp/grants/g1` and `/api/mcp/grants/g1` are the same path written two
 * ways, and only one of them is ours to withhold — the absolute branch needs it
 * for a doubled slash after the origin, the relative branch for a
 * protocol-relative spelling of the path, i.e. one that names no host (a
 * protocol-relative URL naming a HOST is a different string and is not ours).
 * Collapsing is one-directional (a miss becomes a match) and never widens the
 * ORIGIN check above it.
 */
const collapseSlashes = (path) => path.replace(/\/{2,}/g, '/');

const parseUrl = (value, baseUrl) => {
  try {
    return baseUrl ? new URL(value, baseUrl) : new URL(value);
  } catch {
    return null;
  }
};

/**
 * Does this one declaration name the grant broker WE inject?
 *
 * Resolves the declaration's own placeholders against the instance this daemon
 * is bound to, then asks the same path predicate the adapters use — so the
 * expanded spelling and the placeholder spelling agree, and an entry on another
 * origin does not match just because its path resembles ours.
 */
export const isOurGrantBroker = (server, { instanceUrl } = {}) => {
  const url = server?.url;
  if (typeof url !== 'string' || url === '') return false;

  const base = resolveInstance(instanceUrl);
  let resolvedUrl = url;
  for (const placeholder of URL_PLACEHOLDERS) {
    if (!resolvedUrl.includes(placeholder)) continue;
    // A placeholder we cannot resolve is not ours to judge; an entry that is
    // only a placeholder has no origin to compare and no path to match.
    if (base === '') return false;
    resolvedUrl = resolvedUrl.split(placeholder).join(base);
  }

  const parsed = parseUrl(resolvedUrl);
  const ours = base === '' ? null : parseUrl(base);
  const onOurOrigin = (url) => url.origin + collapseSlashes(url.pathname) + url.search;

  // Every candidate below is first proven to be on OUR origin, so an entry that
  // merely resembles the broker is left alone; a match means WITHHOLD.
  const candidates = [];
  if (parsed) {
    // An absolute url: our origin, or it is not our grant however its path reads.
    if (ours && parsed.origin === ours.origin) candidates.push(onOurOrigin(parsed));
  } else if (resolvedUrl.startsWith('/')) {
    // A schemeless url, read BOTH ways — as a path (anchored so its path can be
    // judged), and as a protocol-relative reference to the bound instance.
    candidates.push(PARSE_ANCHOR + collapseSlashes(resolvedUrl));
    const against = ours ? parseUrl(resolvedUrl, base) : null;
    if (against && against.origin === ours.origin) candidates.push(onOurOrigin(against));
  }
  // An unparseable value that is neither — an unknown `${...}` expansion, a
  // malformed string — is not an entry this daemon can identify as the broker
  // it injects, and the injected spelling is one of the two handled above.
  return candidates.some((candidate) => isGrantBrokerUrl(candidate));
};

/** True when the environment declares our grant broker at all. */
export const declaresGrantBroker = (environment, opts) => (
  Array.isArray(environment?.mcp) && environment.mcp.some((server) => isOurGrantBroker(server, opts))
);

/**
 * Why this daemon cannot confine a seat running `adapter` with this
 * environment — or `null` when confinement is enforced and the broker may ride.
 * The reason vocabulary mirrors the server's, plus `sandbox_absent`.
 */
export const confinementReason = (environment, adapter, platform = process.platform) => {
  if (!ADAPTERS_WITH_DEFAULT_SANDBOX.has(adapter)) return 'adapter_cannot_confine';

  const sandbox = environment?.sandbox;
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) return 'sandbox_absent';
  const declared = sandbox;
  if (declared.mode === 'none') return 'sandbox_mode_none';
  if (effectiveTrust(declared.trust) !== 'public') return 'sandbox_trust_not_public';
  const mode = resolvePublicSandboxMode(declared, platform);
  if (typeof mode !== 'string' || !ENFORCING_MODES.has(mode)) return 'sandbox_mode_unenforceable';
  return null;
};

const detailFor = (reason, adapter, environment) => {
  const drop = 'or drop the grant broker from this seat';
  if (reason === 'adapter_cannot_confine') {
    return `the seat runs the '${adapter || 'unresolved'}' adapter, which confines on no host — a declared sandbox is`
      + ' refused rather than enforced, and an absent one is never derived; move this seat to the claude or codex'
      + ` adapter, ${drop}`;
  }
  if (reason === 'sandbox_absent') {
    return 'this seat declares no sandbox block and this daemon derives one only for the claude and codex adapters,'
      + ` so it would run with a granter's authority and no confinement; declare sandbox.trust 'public' ${drop}`;
  }
  if (reason === 'sandbox_mode_none') {
    return "the declared sandbox.mode is 'none', which no host confines; declare a confining mode"
      + ` (e.g. 'workspace') ${drop}`;
  }
  if (reason === 'sandbox_mode_unenforceable') {
    const shown = typeof environment?.sandbox?.mode === 'string'
      ? `'${environment.sandbox.mode}'`
      : (JSON.stringify(environment?.sandbox?.mode) ?? String(environment?.sandbox?.mode));
    return `the declared sandbox.mode is ${shown}, which no adapter enforces on any host;`
      + " declare one of 'workspace' / 'read-only' (or 'bwrap' on Linux)" + ` ${drop}`;
  }
  const trust = environment?.sandbox?.trust;
  const shown = trust === undefined ? 'absent' : `'${String(trust)}'`;
  return `the declared sandbox.trust is ${shown}${shown === 'absent' ? '' : ` (effective '${String(effectiveTrust(trust))}')`},`
    + " and no host confines a seat whose trust is not 'public'; declare sandbox.trust 'public'" + ` ${drop}`;
};

/**
 * The env a seat may actually run with: the same environment when it declares
 * no broker WE injected, or when this daemon can confine it; otherwise the same
 * environment minus the broker, with the refusal handed to `onRefuse`.
 *
 * Identity is preserved when nothing is withheld — the derive sites use
 * `isDeepStrictEqual` against the stored record as their dirty check, so
 * returning a fresh object every tick would rewrite the record and restart the
 * seat forever.
 */
export const withholdGrantBroker = (environment, adapter, {
  instanceUrl,
  onRefuse,
  platform = process.platform,
} = {}) => {
  if (!declaresGrantBroker(environment, { instanceUrl })) return environment;
  const reason = confinementReason(environment, adapter, platform);
  if (!reason) return environment;

  const kept = environment.mcp.filter((server) => !isOurGrantBroker(server, { instanceUrl }));
  const withheld = environment.mcp
    .filter((server) => isOurGrantBroker(server, { instanceUrl }))
    .map((server) => (typeof server?.name === 'string' && server.name ? server.name : '(unnamed)'));
  if (typeof onRefuse === 'function') {
    onRefuse({
      code: GRANT_BROKER_REFUSAL_CODE,
      decidedBy: 'daemon',
      reason,
      detail: detailFor(reason, adapter, environment),
    }, withheld);
  }
  return { ...environment, mcp: kept };
};

export default {
  GRANT_BROKER_REFUSAL_CODE,
  ENFORCING_MODES,
  isOurGrantBroker,
  declaresGrantBroker,
  confinementReason,
  withholdGrantBroker,
};
