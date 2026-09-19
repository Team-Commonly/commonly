/**
 * The commonly MCP server every wrapper seat gets by default (ADR-008 `mcp[]`).
 *
 * One declaration, three consumers: `agent attach`, the COMMONLY_AGENT_TOKEN
 * bootstrap in `agent run`, and the daemon's per-seat token provisioning. The
 * third consumer was missing until 2026-09-18 — a seat installed server-side
 * (nobody ever ran `agent attach` on that host) got a token record carrying
 * runtime model/effort and no `mcp[]` at all, so the CLI it spawned had no
 * `commonly_*` tools and could not post; the operator hand-added the entry to
 * get the seat working (C4 run, TASK-048).
 *
 * Only adapters with a real `mcp[]` consumption path get a default:
 *   claude — `--mcp-config` (adapters/claude.js)
 *   codex  — `-c mcp_servers.*` overrides (adapters/codex.js; added after the
 *            2026-07-22 as-operator attribution incident, where an MCP-less
 *            codex agent posted through the operator's own CLI profile because
 *            it had no commonly_* tool of its own)
 *   pi     — stdio servers from the environment spec (adapters/pi.js)
 * `stub` has no consumption path and must keep being handed `environment: null`.
 *
 * The placeholders are substituted at spawn time by the adapter, so the
 * declaration itself carries no secret and is safe to persist to a token file.
 */

export const ADAPTERS_WITH_DEFAULT_MCP = new Set(['claude', 'codex', 'pi']);

/**
 * The adapters that can ENFORCE the default sandbox — a strict subset of the
 * ones that consume `mcp[]`.
 *
 * `pi` is absent deliberately. It has no sandbox path until #1740's transport
 * work gives it one, and since #1727 it REFUSES TO START on a spec that
 * declares one: `assertNoSandboxDeclared` in adapters/pi.js throws on
 * `trust: 'public'` and on any `mode` other than 'none'. So handing pi this
 * block is not a harmless no-op — it is an unspawnable seat. A pi seat gets the
 * `mcp[]` half only, and the residual is that such a seat runs unconfined: that
 * belongs to the row that owns pi confinement, not to a declaration written
 * here and hoped for. A derived pi seat used to be exactly this shape and would
 * have failed every spawn with `public-trust seats are not supported`.
 */
export const ADAPTERS_WITH_DEFAULT_SANDBOX = new Set(['claude', 'codex']);

/**
 * The sandbox an unconfigured seat gets.
 *
 * `sandbox.mode` defaults to `'none'` in the adapters, so an ABSENT sandbox
 * block means NO sandbox — the seat runs unconfined on the operator's machine
 * while taking instructions from whoever is in the room. That is what a
 * self-serve install shipped (C4-6 / TASK-052): the install declares no
 * environment, the daemon projected nothing, and the socket was born with no
 * confinement and no way to notice.
 *
 * `trust: 'public'` is the conservative declaration — "this seat takes
 * instructions from people I do not control" — and it is the one that engages
 * the real sandbox in the adapters.
 *
 * NO MODE is stored, deliberately. The record is platform-independent and the
 * host is not: the adapters read a public trust with no mode as Seatbelt
 * workspace on macOS and bwrap elsewhere. `mode: 'workspace'` in the row is
 * refused on Linux, and `mode: 'bwrap'` is meaningless on macOS, so either one
 * moves a host fact into the database and breaks the day the seat is re-homed.
 * An explicit mode in a record still wins over the derived one.
 *
 * Confinement holds for claude and codex, and only they are ever handed this
 * block (ADAPTERS_WITH_DEFAULT_SANDBOX). A pi seat must never be: it fails
 * closed on a declared sandbox rather than run under a spec it cannot honour.
 */
export const COMMONLY_DEFAULT_SANDBOX = Object.freeze({ trust: 'public' });

export const defaultSeatSandbox = () => ({ ...COMMONLY_DEFAULT_SANDBOX });

export const COMMONLY_MCP_SERVER_NAME = 'commonly';

export const commonlyMcpServer = () => ({
  name: COMMONLY_MCP_SERVER_NAME,
  transport: 'stdio',
  command: ['npx', '-y', '@commonlyai/mcp@latest'],
  env: {
    COMMONLY_API_URL: '${COMMONLY_API_URL}',
    COMMONLY_AGENT_TOKEN: '${COMMONLY_AGENT_TOKEN}',
  },
});

/** The default `mcp[]` for an adapter, or [] when it has no consumption path. */
export const defaultMcpServers = (adapterName) => (
  ADAPTERS_WITH_DEFAULT_MCP.has(adapterName) ? [commonlyMcpServer()] : []
);

/**
 * Ensure `environment` declares the commonly MCP server, touching nothing that
 * is already declared.
 *
 * The predicate is "is there an mcp entry named commonly?", not "is mcp[]
 * absent?" — the daemon projects live room grants into this same array, so a
 * seat can arrive with `mcp: [<grant broker>]` and no kernel server, and it is
 * exactly as tool-less as one with no `mcp` key at all.
 *
 * Returns the SAME reference when nothing needs adding, so callers can use the
 * identity as a dirty check. A declared commonly entry is never replaced or
 * duplicated — an operator's hand-set command (a pinned version, a staging
 * checkout) wins over the shipped default — and a non-consuming adapter is
 * returned untouched. A malformed (non-object) spec is not ours to repair.
 */
export const withDefaultMcpServer = (environment, adapterName) => {
  if (!ADAPTERS_WITH_DEFAULT_MCP.has(adapterName)) return environment;
  if (environment !== null && environment !== undefined
    && (typeof environment !== 'object' || Array.isArray(environment))) {
    return environment;
  }
  const declared = Array.isArray(environment?.mcp) ? environment.mcp : null;
  if (declared && declared.some((server) => server?.name === COMMONLY_MCP_SERVER_NAME)) {
    return environment;
  }
  return { ...(environment || {}), mcp: [...(declared || []), commonlyMcpServer()] };
};

/**
 * Ensure the environment declares an ENFORCED sandbox, touching nothing that
 * is already enforced. Returns the SAME reference when nothing needs adding.
 *
 * Only for environments this daemon derived from the server's declaration or
 * from nothing at all — never for a local record the operator authored. A
 * declared `mode: 'none'` is replaced rather than honoured: absence and 'none'
 * are the same thing to the adapter, and this is the path that decides what an
 * undeclared sandbox means.
 */
export const withDefaultSandbox = (environment) => {
  if (environment !== null && environment !== undefined
    && (typeof environment !== 'object' || Array.isArray(environment))) {
    return environment;
  }
  const sandbox = environment?.sandbox;
  // An ENFORCED declaration is one the adapters act on: a public trust (whose
  // mode they resolve, and refuse to spawn without) or an explicit non-'none'
  // mode. `mode: 'none'`, an empty block and a missing one are all the same
  // thing to a spawn — no confinement — so all three are replaced here.
  const enforced = sandbox !== null && typeof sandbox === 'object'
    && sandbox.mode !== 'none'
    && (sandbox.trust === 'public' || typeof sandbox.mode === 'string');
  if (enforced) return environment;
  return { ...(environment || {}), sandbox: defaultSeatSandbox() };
};

/**
 * The full baseline a seat gets from the daemon: the kernel MCP server, plus an
 * enforced sandbox when the environment is one the daemon derived rather than
 * one the operator wrote (`sandbox: true` at the call sites).
 */
export const seatBaseline = (environment, adapterName, { sandbox = false } = {}) => {
  const withMcp = withDefaultMcpServer(environment, adapterName);
  if (!sandbox || !ADAPTERS_WITH_DEFAULT_SANDBOX.has(adapterName)) return withMcp;
  return withDefaultSandbox(withMcp);
};
