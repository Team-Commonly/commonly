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
