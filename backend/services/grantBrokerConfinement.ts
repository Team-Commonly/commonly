/**
 * Can the environment a seat DECLARES confine a grant broker? (TASK-063)
 *
 * A room grant reaches a seat as an injected MCP server
 * (`grantServersForIdentities`, which writes the `commonly-grant-broker` entry
 * into the projected environment). External reach and confinement are decided
 * by two different fields, and they can disagree: the grant arrives in `mcp[]`
 * while confinement lives in `sandbox`. The adapters are the enforcing layers
 * (`cli/src/lib/adapters/claude.js` — Seatbelt/`--setting-sources`/the deny
 * list only inside its confined branch — and `codex.js`), and for
 * daemon-provisioned seats the baseline #1754 derives at the daemon.
 *
 * This predicate mirrors the part of their rule that is HOST-INDEPENDENT,
 * which is all a server can know: a declaration NO host would confine. It
 * deliberately does not resolve a mode the way the cli does — `mode` is
 * host-resolved by design (#1754's `resolvePublicSandboxMode`: darwin →
 * `workspace`, otherwise → `bwrap`), so a public trust with no declared mode is
 * left to the daemon, which is the layer that knows the host and the layer that
 * actually spawns the seat. The daemon emits the same code.
 *
 * An ABSENT sandbox block is likewise left to the daemon: it is the normal
 * state of a daemon-provisioned seat, whose baseline is derived at the daemon
 * and is not visible from an AgentInstallation row. Refusing it here would
 * refuse the working path.
 *
 * Two further cases ARE host-independent, so they are decided here as well
 * (Vera 69810):
 *
 *  - An adapter that confines on NO host. `pi` is the one that exists — its
 *    `assertNoSandboxDeclared` (`cli/src/lib/adapters/pi.js`) throws only when
 *    a sandbox is DECLARED, so a pi seat that declares nothing spawns
 *    unconfined and nothing ever derives one. The adapter is then the deciding
 *    fact, not the declaration. The name is normalised the way the daemon
 *    normalises it before spawning (`trim().toLowerCase()`, see
 *    `normalizeAdapter`), because `'PI'` reaches the pi adapter too.
 *  - A declared public mode that no adapter implements. The write-time schema
 *    (`cli/src/lib/environment.js` `ALLOWED_SANDBOX_MODES`) accepts more modes
 *    than any adapter enforces: `firejail`, `container` and `managed` appear
 *    nowhere else in `cli/src`, so a seat declaring one fails every host the
 *    same way. Both adapters implement {workspace, read-only}, and claude adds
 *    `bwrap` for Linux — a wider set, not a narrower one, so the server cannot
 *    refuse anything a host would have confined. A mode that is not a string
 *    belongs here too: every adapter compares it with `===` against a string,
 *    so `['bwrap']` confines nothing even though it stringifies to a mode that
 *    does.
 */

/**
 * The cli's legacy trust table, mirrored. The backend cannot import cli code,
 * so `cli/src/lib/environment.js` `LEGACY_SANDBOX_TRUST` is the source of
 * truth and this pair table is asserted by test on both sides — a stored
 * `internal` reads as `public` (never toward a bare spawn), which is #1754's
 * fix for the trust value that no layer used to read.
 */
export const LEGACY_SANDBOX_TRUST: Readonly<Record<string, string>> = Object.freeze({
  internal: 'public',
});

/**
 * Adapters that cannot confine a seat on any host — the adapter, not the
 * declaration, is the host-independent fact. Exact match mirrors how the cli
 * keys its adapter registry; an unrecognised adapter name is not pi, and a
 * record carrying one cannot spawn a pi seat either.
 */
/**
 * Adapters known to confine a public seat, and the modes each one enforces.
 * This is an ALLOWLIST, inverted from a denylist on 2026-10-09: the denylist
 * (`{'pi'}`) refused only adapters someone had already shown to be unconfined,
 * so every adapter added after it passed this server-side check by default,
 * before anyone had shown it confines (Vera, pre-gating the OpenCode adapter).
 * An adapter joins this map by proving enforcement, in the adapter and in its
 * tests, not by being new. Modes are keyed per adapter because the union was
 * admitting `bwrap` on an adapter that only implements the Seatbelt pair.
 */
export const CONFINING_ADAPTERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['claude', new Set(['workspace', 'read-only', 'bwrap'])],
  ['codex', new Set(['workspace', 'read-only'])],
]);

export const KNOWN_CONFINING_ADAPTERS = [...CONFINING_ADAPTERS.keys()].join(', ');

/**
 * The daemon normalises a declared adapter before it spawns a seat —
 * `cli/src/lib/daemon-supervisor.js` (`ensureToken`, and the spawn path) does
 * `adapter.trim().toLowerCase()` on the way through — so `'PI'` and `' pi '`
 * reach the pi adapter as well. Comparing the raw value here would let both
 * past the refusal while the seat still spawns pi, which is exactly the case
 * this predicate exists to catch. Mirroring the daemon's normalisation is the
 * stricter direction for a refusal: a name neither layer recognises is not one
 * the daemon can spawn either.
 */
export const normalizeAdapter = (adapter: unknown): string | null => (
  typeof adapter === 'string' && adapter.trim() ? adapter.trim().toLowerCase() : null
);

/**
 * The adapter a seat declares, resolved the way the daemon resolves it: a
 * declared `adapter` wins, `runtimeType` is the fallback. `null` means the row
 * names neither, which is not a refusal (see `grantBrokerRefusal`).
 */
export const declaredAdapter = (runtime: unknown): string | null => {
  const row = runtime as { adapter?: unknown; runtimeType?: unknown } | null | undefined;
  return normalizeAdapter(row?.adapter) ?? normalizeAdapter(row?.runtimeType);
};

/**
 * Every mode ANY of the enforcing adapters implements for a public seat:
 * {workspace, read-only} in both claude and codex, plus `bwrap` (claude's
 * Linux path). A declared mode outside this set confines nowhere, so the
 * server can refuse it without resolving the host.
 */
export const PUBLIC_HOST_MODES: ReadonlySet<string> = new Set(
  [...CONFINING_ADAPTERS.values()].flatMap((modes) => [...modes]),
);

/** One typed code, two emitters (server projection + daemon derive). */
export const GRANT_BROKER_REFUSAL_CODE = 'grant_broker_unconfined';

export type GrantBrokerRefusal = {
  code: string;
  /** Which layer decided — the user's fix is identical either way. */
  decidedBy: string;
  reason: string;
  detail: string;
};

/** `internal` → `public`; anything else (including absent) is itself. */
export const effectiveSandboxTrust = (trust: unknown): unknown => (
  typeof trust === 'string' && Object.prototype.hasOwnProperty.call(LEGACY_SANDBOX_TRUST, trust)
    ? LEGACY_SANDBOX_TRUST[trust]
    : trust
);

const refusalFor = (reason: string, detail: string): GrantBrokerRefusal => ({
  code: GRANT_BROKER_REFUSAL_CODE,
  decidedBy: 'server',
  reason,
  detail,
});

/**
 * The adapter is `runtime.adapter`, or `runtime.runtimeType` when no adapter is
 * declared. A declared adapter wins, as it does in the daemon
 * (`cli/src/commands/daemon.js:142`). This is load-bearing, not tidiness: a
 * hand-attached pi seat carries `runtimeType: 'pi'` with NO `adapter` key —
 * `cli/src/commands/agent.js:664` falls back to the adapter's name for the tag
 * and `:688` writes `config.runtime` as `{runtimeType, host: 'byo'}` — so a
 * predicate reading `adapter` alone admitted exactly the seat it exists to
 * refuse (Wren, TASK-175 12:17Z). A row naming NEITHER field stays
 * daemon-decided: undeclared, the daemon resolves only claude or codex, never
 * pi, so refusing there would refuse working claude seats.
 *
 * `null` means "not refused here" — either the declaration is confinable, or it
 * declares no sandbox block at all and the daemon decides.
 *
 * `runtime` is the seat's projected runtime (`config.runtime`), which is where
 * the adapter is known.
 */
export const grantBrokerRefusal = (environment: unknown, runtime?: unknown): GrantBrokerRefusal | null => {
  const adapter = declaredAdapter(runtime);
  if (adapter && !CONFINING_ADAPTERS.has(adapter)) {
    return refusalFor(
      'adapter_cannot_confine',
      `the seat runs the '${adapter}' adapter, which is not known to confine on any host; the adapters`
        + ` known to confine are ${KNOWN_CONFINING_ADAPTERS}, and an adapter joins that set by proving`
        + ' enforcement, not by default. Move this seat to one of them, or drop the grant broker from it',
    );
  }
  // Modes are judged against the declared adapter's own set; a seat that names
  // no adapter is daemon-decided (claude or codex), so the union applies there.
  const enforceableModes = adapter ? CONFINING_ADAPTERS.get(adapter) as ReadonlySet<string> : PUBLIC_HOST_MODES;

  const source = environment as { sandbox?: unknown } | null | undefined;
  const sandbox = source?.sandbox;
  if (!sandbox || typeof sandbox !== 'object' || Array.isArray(sandbox)) return null;
  const declared = sandbox as { mode?: unknown; trust?: unknown };

  if (declared.mode === 'none') {
    return refusalFor(
      'sandbox_mode_none',
      "the declared sandbox.mode is 'none', which no host confines; declare a confining mode"
        + " (e.g. 'workspace') or drop the grant broker from this seat",
    );
  }
  const mode = declared.mode;
  if (mode !== undefined && mode !== null && (typeof mode !== 'string' || !enforceableModes.has(mode))) {
    const shown = typeof mode === 'string' ? `'${mode}'` : (JSON.stringify(mode) ?? String(mode));
    const which = adapter ? `the '${adapter}' adapter` : 'any adapter';
    return refusalFor(
      'sandbox_mode_unenforceable',
      `the declared sandbox.mode is ${shown}, which ${which} does not enforce on any host;`
        + ` declare one of ${[...enforceableModes].map((m) => `'${m}'`).join(' / ')}`
        + ' or drop the grant broker from this seat',
    );
  }
  const trust = effectiveSandboxTrust(declared.trust);
  if (trust !== 'public') {
    const shown = declared.trust === undefined ? 'absent' : `'${String(declared.trust)}'`;
    return refusalFor(
      'sandbox_trust_not_public',
      `the declared sandbox.trust is ${shown}${shown === 'absent' ? '' : ` (effective '${String(trust)}')`},`
        + " and no host confines a seat whose trust is not 'public'; declare sandbox.trust 'public'"
        + ' or drop the grant broker from this seat',
    );
  }
  return null;
};
