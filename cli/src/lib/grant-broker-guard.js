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
 * THE ADAPTER IS THE HOST-INDEPENDENT FACT, but sandbox support and broker
 * admission are separate: only ADAPTERS_WITH_GRANT_BROKER may receive the grant
 * broker (claude, codex, OpenCode since F175a, pi since F175c). pi is admitted
 * on a narrower rule (ADAPTERS_WITH_PUBLIC_ONLY_GRANT): a public seat in macOS
 * Seatbelt only, and every other pi declaration is `adapter_confines_public_only`,
 * which a named grant (F94) does not lift.
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
import { ADAPTERS_WITH_GRANT_BROKER, ADAPTERS_WITH_PUBLIC_ONLY_GRANT } from './default-environment.js';
import { effectiveSandboxTrust } from './environment.js';
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
 * F175c: the one reason naming (F94) does not lift for an adapter on the grant
 * list. pi holds a grant only on a public seat confined by macOS Seatbelt, so
 * every pi declaration short of that is this reason, not a sandbox reason a
 * consent could waive. Same literal as the server's.
 */
export const PUBLIC_ONLY_REASON = 'adapter_confines_public_only';

const publicOnlyReason = (environment, rule, platform) => {
  const sandbox = environment?.sandbox;
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) return PUBLIC_ONLY_REASON;
  if (sandbox.mode === 'none' || effectiveSandboxTrust(sandbox.trust) !== 'public') return PUBLIC_ONLY_REASON;
  // D245: a public declaration on native Windows reads the same for every adapter.
  if (platform === 'win32') return 'sandbox_mode_unenforceable';
  if (!rule.platforms.has(platform)) return PUBLIC_ONLY_REASON;
  const mode = resolvePublicSandboxMode(sandbox, platform);
  return typeof mode === 'string' && rule.modes.has(mode) ? null : PUBLIC_ONLY_REASON;
};

/**
 * Why this daemon cannot confine a seat running `adapter` with this
 * environment — or `null` when confinement is enforced and the broker may ride.
 * The reason vocabulary mirrors the server's, plus `sandbox_absent`.
 */
export const confinementReason = (environment, adapter, platform = process.platform) => {
  if (!ADAPTERS_WITH_GRANT_BROKER.has(adapter)) return 'adapter_cannot_confine';
  const publicOnly = ADAPTERS_WITH_PUBLIC_ONLY_GRANT.get(adapter);
  if (publicOnly) return publicOnlyReason(environment, publicOnly, platform);

  const sandbox = environment?.sandbox;
  if (sandbox === null || typeof sandbox !== 'object' || Array.isArray(sandbox)) return 'sandbox_absent';
  const declared = sandbox;
  if (declared.mode === 'none') return 'sandbox_mode_none';
  if (effectiveSandboxTrust(declared.trust) !== 'public') return 'sandbox_trust_not_public';
  // D245: native Windows has no OS jail for any adapter. Claude there runs
  // only by the user's --unsandboxed (policy without a jail), and Codex runs on
  // its own profiles with no Commonly sandbox, so neither carries a grant.
  if (platform === 'win32') return 'sandbox_mode_unenforceable';
  const mode = resolvePublicSandboxMode(declared, platform);
  if (typeof mode !== 'string' || !ENFORCING_MODES.has(mode)) return 'sandbox_mode_unenforceable';
  return null;
};

/** "claude, codex or opencode": the broker set, as a remedy names it. */
const brokerAdapterList = () => {
  const names = [...ADAPTERS_WITH_GRANT_BROKER];
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names.join('');
};

const detailFor = (reason, adapter, environment, platform = process.platform) => {
  const drop = 'or drop the grant broker from this seat';
  if (reason === 'sandbox_mode_unenforceable' && platform === 'win32') {
    return 'native Windows has no sandbox Commonly can enforce, so no agent on this computer gets connector grants;'
      + ` run the agent on macOS or Linux to use grants, ${drop}`;
  }
  if (reason === PUBLIC_ONLY_REASON) {
    return `the seat runs the '${adapter}' adapter, which carries a grant only on a public seat confined by the`
      + " macOS sandbox; declare sandbox.trust 'public' and run it on a Mac, or move it to an adapter that confines"
      + ` this host, ${drop} (naming the agent on the grant does not lift this)`;
  }
  if (reason === 'adapter_cannot_confine') {
    return `the seat runs the '${adapter || 'unresolved'}' adapter, which is not approved to receive the grant broker;`
      + ` move this seat to the ${brokerAdapterList()} adapter, ${drop}`;
  }
  if (reason === 'sandbox_absent') {
    return 'this seat declares no sandbox block and none was derived for it,'
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
  return `the declared sandbox.trust is ${shown}${shown === 'absent' ? '' : ` (effective '${String(effectiveSandboxTrust(trust))}')`},`
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

  // F94: the server flags a broker whose grant names this seat (the granter's
  // own agent, with consent) so it rides a seat no sandbox confines. Delivery
  // only; the broker checks the naming on every call. Never on native Windows,
  // and never for an adapter not approved for the broker.
  const rides = (server) => server?.byoNamed === true
    && reason !== 'adapter_cannot_confine' && reason !== PUBLIC_ONLY_REASON && platform !== 'win32';
  const isWithheld = (server) => isOurGrantBroker(server, { instanceUrl }) && !rides(server);
  if (!environment.mcp.some(isWithheld)) return environment;

  const kept = environment.mcp.filter((server) => !isWithheld(server));
  const withheld = environment.mcp
    .filter(isWithheld)
    .map((server) => (typeof server?.name === 'string' && server.name ? server.name : '(unnamed)'));
  if (typeof onRefuse === 'function') {
    onRefuse({
      code: GRANT_BROKER_REFUSAL_CODE,
      decidedBy: 'daemon',
      reason,
      detail: detailFor(reason, adapter, environment, platform),
    }, withheld);
  }
  return { ...environment, mcp: kept };
};

/**
 * Merge the server's grant-broker entries into a seat environment, the way the
 * daemon's work list does it (`GET /api/agent-binding/assigned` in
 * `backend/routes/agentBinding.ts`): an existing entry with a broker's name is
 * replaced, the brokers are appended, and a seat with no environment gets one
 * holding only them. Used by `agent run` without a daemon (F150), whose
 * `GET /api/agents/runtime/grant-brokers` returns the same per-seat projection.
 *
 * Merge only. The caller runs `withholdGrantBroker` on the result, so the
 * client-side refusal still applies to whatever the server sent.
 * Identity is preserved when there is nothing to merge.
 */
export const mergeGrantBrokers = (environment, servers) => {
  const brokers = Array.isArray(servers)
    ? servers.filter((server) => server && typeof server === 'object' && !Array.isArray(server))
    : [];
  if (!brokers.length) return environment;
  if (!environment) return { mcp: brokers };
  const existing = Array.isArray(environment.mcp) ? environment.mcp : [];
  return {
    ...environment,
    mcp: [
      ...existing.filter((server) => !brokers.some((broker) => broker.name === server?.name)),
      ...brokers,
    ],
  };
};

export default {
  GRANT_BROKER_REFUSAL_CODE,
  PUBLIC_ONLY_REASON,
  ENFORCING_MODES,
  isOurGrantBroker,
  declaresGrantBroker,
  confinementReason,
  withholdGrantBroker,
  mergeGrantBrokers,
};
