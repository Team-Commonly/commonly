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
 */
export const grantBrokerRefusal = (environment: unknown): GrantBrokerRefusal | null => {
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
