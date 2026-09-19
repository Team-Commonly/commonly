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
export const CONFINEMENTLESS_ADAPTERS: ReadonlySet<string> = new Set(['pi']);

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
 * Every mode ANY of the enforcing adapters implements for a public seat:
 * {workspace, read-only} in both claude and codex, plus `bwrap` (claude's
 * Linux path). A declared mode outside this set confines nowhere, so the
 * server can refuse it without resolving the host.
 */
export const PUBLIC_HOST_MODES: ReadonlySet<string> = new Set(['workspace', 'read-only', 'bwrap']);

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
 * `null` means "not refused here" — either the declaration is confinable, or it
 * declares no sandbox block at all and the daemon decides.
 *
 * `runtime` is the seat's projected runtime (`config.runtime`), which is where
 * the adapter is known. When the adapter is absent from the row the daemon
 * detects it locally, so the daemon-side refusal covers that case.
 */
export const grantBrokerRefusal = (environment: unknown, runtime?: unknown): GrantBrokerRefusal | null => {
  const adapter = normalizeAdapter((runtime as { adapter?: unknown } | null | undefined)?.adapter);
  if (adapter && CONFINEMENTLESS_ADAPTERS.has(adapter)) {
    return refusalFor(
      'adapter_cannot_confine',
      `the seat runs the '${adapter}' adapter, which confines on no host — a declared sandbox is refused`
        + ' rather than enforced, and an absent one is never derived; move this seat to the claude or codex'
        + ' adapter, or drop the grant broker from it',
    );
  }

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
  if (mode !== undefined && mode !== null && (typeof mode !== 'string' || !PUBLIC_HOST_MODES.has(mode))) {
    const shown = typeof mode === 'string' ? `'${mode}'` : (JSON.stringify(mode) ?? String(mode));
    return refusalFor(
      'sandbox_mode_unenforceable',
      `the declared sandbox.mode is ${shown}, which no adapter enforces on any host;`
        + " declare one of 'workspace' / 'read-only' (or 'bwrap' on Linux)"
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
