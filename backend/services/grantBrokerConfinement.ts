/**
 * Can the environment a seat DECLARES confine a grant broker? (TASK-063)
 *
 * A room grant reaches a seat as an injected MCP server
 * (`grantServersForIdentities`, which writes the `commonly-grant-broker` entry
 * into the projected environment). External reach and confinement are decided
 * by two different fields, and they can disagree: the grant arrives in `mcp[]`
 * while confinement lives in `sandbox`. The adapters are the enforcing layers
 * (`cli/src/lib/adapters/claude.js` — Seatbelt/`--setting-sources`/the deny
 * list only inside its confined branch — `codex.js`, and `opencode.js` with
 * Seatbelt on macOS or bwrap on Linux), and for
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
 * The server also refuses a named adapter absent from CONFINING_ADAPTERS,
 * even when the adapter has a local sandbox. OpenCode was admitted in F175a,
 * once its public seat was shown to keep the per-spawn credential out of its
 * own tools' reach (cli adapters/opencode.js). pi was admitted in F175c, and
 * Qwen Code and Goose in F175d, on a narrower rule
 * (PUBLIC_ONLY_GRANT_ADAPTERS below).
 *
 * Two further cases ARE host-independent, so they are decided here as well
 * (Vera 69810):
 *
 *  - An adapter that confines only a public seat. `pi` is the one that exists:
 *    it confines a public turn in macOS Seatbelt (`assertSandboxSupported`,
 *    `cli/src/lib/adapters/pi.js`) and is never handed a default sandbox, so a
 *    pi seat that declares nothing, or declares a non-public trust, spawns
 *    unconfined and nothing ever derives one. For pi an absent block is
 *    therefore a refusal, not a daemon-decided case, and every pi refusal is
 *    `adapter_confines_public_only`, which naming (F94) does not lift. The
 *    name is normalised the way the daemon normalises it before spawning
 *    (`trim().toLowerCase()`, see `normalizeAdapter`), because `'PI'` reaches
 *    the pi adapter too. Qwen and Goose read the same, with Seatbelt or
 *    bubblewrap: neither jails a private seat. One difference: the daemon
 *    derives Qwen's sandbox, so an absent block on a Qwen seat stays its to
 *    judge (DAEMON_SANDBOXED_PUBLIC_ONLY_ADAPTERS).
 *  - A declared public mode that no adapter implements. The write-time schema
 *    (`cli/src/lib/environment.js` `ALLOWED_SANDBOX_MODES`) accepts more modes
 *    than any adapter enforces: `firejail`, `container` and `managed` appear
 *    nowhere else in `cli/src`, so a seat declaring one fails every host the
 *    same way. Claude, Codex and OpenCode implement {workspace, read-only};
 *    Claude and OpenCode add `bwrap` for Linux. A mode that is not a string belongs
 *    here too: every adapter compares it with `===` against a string, so
 *    `['bwrap']` confines nothing even though it stringifies to a mode that
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
  // F175a: Seatbelt workspace/read-only on macOS, bwrap on Linux; a public
  // OpenCode seat on any other mode refuses to spawn (adapters/opencode.js).
  ['opencode', new Set(['workspace', 'read-only', 'bwrap'])],
  // F175c: Seatbelt workspace/read-only on macOS only, and only on a public
  // seat (PUBLIC_ONLY_GRANT_ADAPTERS). A public pi turn has no built-in tool,
  // so the model cannot open the per-spawn credential file, and the file is
  // deleted once pi has loaded its extensions (adapters/pi.js).
  ['pi', new Set(['workspace', 'read-only'])],
  // F175d: Seatbelt on macOS, bwrap on Linux, and only on a public seat. A
  // public turn on either offers no file or shell tool, and the broker runs
  // behind the stdio bridge, so the token stays in the per-spawn credential file
  // (adapters/qwen.js, adapters/goose.js).
  ['qwen', new Set(['workspace', 'read-only', 'bwrap'])],
  ['goose', new Set(['workspace', 'read-only', 'bwrap'])],
]);

/**
 * F175c, F175d: confining adapters that hold a grant ONLY on a declared public
 * seat. Mirrors the cli's `ADAPTERS_WITH_PUBLIC_ONLY_GRANT`
 * (`cli/src/lib/default-environment.js`); the reason string is the cli guard's
 * own, so one refusal reads the same from either emitter.
 */
export const PUBLIC_ONLY_GRANT_ADAPTERS: ReadonlySet<string> = new Set(['pi', 'qwen', 'goose']);
export const PUBLIC_ONLY_REASON = 'adapter_confines_public_only';

/**
 * Of those, the ones the daemon hands the default public sandbox (the cli's
 * `ADAPTERS_WITH_DEFAULT_SANDBOX`). On the daemon path an absent block on one
 * of these is the normal state of a working seat, not a refusal.
 */
const DAEMON_SANDBOXED_PUBLIC_ONLY_ADAPTERS: ReadonlySet<string> = new Set(['qwen']);

export const KNOWN_CONFINING_ADAPTERS = [...CONFINING_ADAPTERS.keys()].join(', ');

/**
 * Runtime KINDS a row may carry in `runtime.runtimeType` that name no adapter:
 * the daemon resolves those (claude or codex, never pi), which the header above
 * makes load-bearing. A Connect-page env-token seat still projects as the known
 * `webhook` runtime kind, so the server cannot infer a local adapter from this
 * field; `agent run` requires a server-declared binding for every non-broker
 * adapter (except the test stub) before spawning. The set mirrors `CLOUD_RUNTIME_TYPES`
 * (moltbot, internal,
 * native, managed-agents) plus the pure-BYO kinds `isCloudRuntime` names
 * (webhook, claude-code) and the values the install paths write (hosted,
 * local-cli, wrapper); the predicate module stays a leaf, so the mirror is
 * asserted in its suite rather than imported. Anything ELSE in that field is
 * adapter-shaped and is judged, so a hand-attached seat whose attach wrote
 * `runtimeType: <adapter name>` with no `adapter` key fails closed when that
 * adapter is unproven. The first cut listed adapter NAMES here instead, which
 * was the denylist shape one layer down: a new adapter nobody had listed
 * passed as daemon-decided (Vera, connector pod 76719).
 */
export const RUNTIME_KINDS: ReadonlySet<string> = new Set([
  'wrapper', 'webhook', 'hosted', 'claude-code', 'local-cli',
  'moltbot', 'internal', 'native', 'managed-agents',
]);

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
 * Resolve only an adapter binding from a projected runtime. Runtime kinds such
 * as `webhook` are daemon-decided and do not identify the local CLI adapter;
 * adapter-shaped runtimeType values are the legacy binding for attached seats.
 * Keep this resolution shared with the grant-broker predicate and the runtime
 * installations projection so the CLI sees the same adapter the server judges.
 */
export const adapterForRuntimeBinding = (runtime: unknown): string | null => {
  const row = runtime as { adapter?: unknown; runtimeType?: unknown } | null | undefined;
  const explicit = normalizeAdapter(row?.adapter);
  if (explicit) return explicit;
  const viaType = normalizeAdapter(row?.runtimeType);
  return viaType && !RUNTIME_KINDS.has(viaType) ? viaType : null;
};

/**
 * Every mode ANY of the enforcing adapters implements for a public seat:
 * {workspace, read-only} in claude, codex and opencode, plus `bwrap` (the
 * Linux path of claude and opencode). A declared mode outside this set confines nowhere, so the
 * server can refuse it without resolving the host.
 */
export const PUBLIC_HOST_MODES: ReadonlySet<string> = new Set(['workspace', 'read-only', 'bwrap']);
// A literal on purpose, not derived from CONFINING_ADAPTERS: the undeclared
// path is daemon-decided (claude or codex), and deriving the union would let a
// future adapter's novel mode silently widen it. The sibling suite pins it.

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

const publicOnlyRefusalFor = (adapter: string, modes: ReadonlySet<string>): GrantBrokerRefusal => refusalFor(
  PUBLIC_ONLY_REASON,
  modes.has('bwrap')
    ? `the seat runs the '${adapter}' adapter, which holds a grant only on a public seat in its sandbox;`
      + " declare sandbox.trust 'public', or drop the grant broker from this seat."
      + ' Naming the agent on the grant does not lift this'
    : `the seat runs the '${adapter}' adapter, which holds a grant only on a public seat confined by the macOS sandbox;`
      + " declare sandbox.trust 'public' and run it on a Mac, or drop the grant broker from this seat."
      + ' Naming the agent on the grant does not lift this',
);

/**
 * A public-only adapter is confined by exactly one declaration: a public trust,
 * no `none` mode, and a mode it enforces or none at all (the host resolves it;
 * on a host with no jail for it the daemon refuses). Anything short of that runs
 * unconfined on every host. So does an absent block, unless the daemon derives
 * a baseline for this adapter (Qwen), which leaves that case to the daemon.
 */
const publicOnlyRefusal = (
  adapter: string,
  environment: unknown,
  modes: ReadonlySet<string>,
): GrantBrokerRefusal | null => {
  const sandbox = (environment as { sandbox?: unknown } | null | undefined)?.sandbox;
  if ((sandbox === undefined || sandbox === null) && DAEMON_SANDBOXED_PUBLIC_ONLY_ADAPTERS.has(adapter)) return null;
  const declared = sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox)
    ? sandbox as { mode?: unknown; trust?: unknown }
    : null;
  const mode = declared?.mode;
  const confined = Boolean(declared)
    && effectiveSandboxTrust(declared?.trust) === 'public'
    && (mode === undefined || mode === null || (typeof mode === 'string' && modes.has(mode)));
  return confined ? null : publicOnlyRefusalFor(adapter, modes);
};

/**
 * The adapter is `runtime.adapter`, or `runtime.runtimeType` when no adapter is
 * declared. A declared adapter wins, as it does in the daemon
 * (`cli/src/commands/daemon.js:142`). This is load-bearing, not tidiness: a
 * hand-attached pi seat carries `runtimeType: 'pi'` with NO `adapter` key —
 * `cli/src/commands/agent.js:664` falls back to the adapter's name for the tag
 * and `:688` writes `config.runtime` as `{runtimeType, host: 'byo'}` — so a
 * predicate reading `adapter` alone admitted exactly the seat it exists to
 * refuse (Wren, TASK-175 12:17Z). A row naming NEITHER field stays
 * daemon-decided for the daemon: it resolves claude or codex, never pi, so
 * refusing that server-side case would refuse working claude seats. A local
 * env-token seat on a known `webhook` runtime is not distinguishable here; its
 * `agent run` path requires the server-declared adapter before it can spawn pi.
 *
 * `null` means "not refused here" — either the declaration is confinable, or it
 * declares no sandbox block at all and the daemon decides.
 *
 * `runtime` is the seat's projected runtime (`config.runtime`), which is where
 * the adapter is known when the row carries an adapter-shaped runtime type or
 * an explicit adapter declaration.
 */
export const grantBrokerRefusal = (environment: unknown, runtime?: unknown): GrantBrokerRefusal | null => {
  // Explicit adapters always win; adapter-shaped runtimeType values are the
  // fallback binding. Known runtime kinds remain daemon-decided.
  const adapter = adapterForRuntimeBinding(runtime);
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
  if (adapter && PUBLIC_ONLY_GRANT_ADAPTERS.has(adapter)) {
    return publicOnlyRefusal(adapter, environment, enforceableModes);
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

/**
 * F150 (security review, HIGH): an ABSENT sandbox block is left to the daemon
 * above because the daemon derives a confining baseline before it spawns the
 * seat. A seat with no daemon — `commonly agent run` with no machine binding,
 * or a token pasted into a client from the Connect page — has nothing that
 * derives one, so the same absence confines nothing there. The reason string is
 * the cli guard's own (`cli/src/lib/grant-broker-guard.js`, `sandbox_absent`),
 * so one refusal reads the same from either emitter. It is a sandbox refusal,
 * so a grant that names the seat (F94, `namingLiftsRefusal`) lifts it.
 */
export const SANDBOX_ABSENT_REASON = 'sandbox_absent';

export const absentSandboxRefusal = (environment: unknown): GrantBrokerRefusal | null => {
  const sandbox = (environment as { sandbox?: unknown } | null | undefined)?.sandbox;
  if (sandbox && typeof sandbox === 'object' && !Array.isArray(sandbox)) return null;
  return refusalFor(
    SANDBOX_ABSENT_REASON,
    'this seat runs with no daemon to derive a sandbox, and its saved settings declare no sandbox block,'
      + " so nothing confines it; declare sandbox.trust 'public', name this agent on the grant,"
      + ' or drop the grant broker from this seat',
  );
};

/**
 * Runtimes Commonly itself runs: `CLOUD_RUNTIME_TYPES` (agentIdentityService)
 * plus `KERNEL_RUN_RUNTIME_TYPES` (configWriteGuard, which adds `hosted`).
 * Mirrored, not imported, so this module stays a leaf; the suite asserts the
 * mirror. A seat on one of these is not a BYO seat, so "no daemon derives its
 * sandbox" is not a fact about it, and `sandbox_absent` never applies.
 */
export const COMMONLY_RUN_RUNTIME_TYPES: ReadonlySet<string> = new Set([
  'moltbot', 'internal', 'native', 'managed-agents', 'hosted',
]);

/**
 * Does Commonly run this seat? The order of `isCloudRuntime`, made stricter
 * for codex: a type above wins whatever `host` says; otherwise `host: 'byo'` is
 * the person's own compute.
 *
 * A codex row is Commonly's only with `host: 'cloud'`, or with neither `host`
 * nor `adapter`. The second shape is the stored data, not a guess: cloud-codex
 * (ADR-014) seeds its token file in the pod and is installed through the
 * registry as `{ runtimeType: 'codex' }` with no host (the inspector reads it as
 * cloud by default, `normalizeRuntimeIdentity`), so keying on `host === 'cloud'`
 * alone would refuse every existing cloud codex seat. Every BYO codex row names
 * an adapter: `commonly agent attach` writes `{ runtimeType, adapter, host:
 * 'byo' }`, and the Settings harness switch writes `adapter`. A Settings switch
 * used to drop `host` (`runtimeKeepingType`, #3458 re-review), leaving
 * `{ runtimeType: 'codex', adapter: 'claude' }`, which the old bare-codex rule
 * read as Commonly's. Everything else (webhook, claude-code, adapter-shaped,
 * nothing at all) runs on someone's own machine.
 */
export const runsOnCommonly = (runtime: unknown): boolean => {
  const row = runtime as { runtimeType?: unknown; host?: unknown; adapter?: unknown } | null | undefined;
  const runtimeType = normalizeAdapter(row?.runtimeType);
  if (runtimeType && COMMONLY_RUN_RUNTIME_TYPES.has(runtimeType)) return true;
  const host = normalizeAdapter(row?.host);
  if (host === 'byo' || runtimeType !== 'codex') return false;
  if (host === 'cloud') return true;
  return !host && !normalizeAdapter(row?.adapter);
};

/**
 * `grantBrokerRefusal` for a seat no daemon spawns: an absent block refuses
 * too, but only for a seat that runs on someone's own machine. `runtime` is the
 * seat's ROW runtime; a runtime Commonly runs keeps the daemon-path reading.
 */
export const grantBrokerRefusalWithoutDaemon = (environment: unknown, runtime?: unknown): GrantBrokerRefusal | null => {
  const refusal = grantBrokerRefusal(environment, runtime);
  if (refusal || runsOnCommonly(runtime)) return refusal;
  const absent = absentSandboxRefusal(environment);
  // F175d: with no daemon nothing derives Qwen's sandbox, so its absent block
  // refuses here, as the reason naming doesn't lift: `sandbox_absent` would let
  // a grant naming the seat through the broker's per-call check.
  const adapter = adapterForRuntimeBinding(runtime);
  return absent && adapter && PUBLIC_ONLY_GRANT_ADAPTERS.has(adapter)
    ? publicOnlyRefusalFor(adapter, CONFINING_ADAPTERS.get(adapter) as ReadonlySet<string>)
    : absent;
};
