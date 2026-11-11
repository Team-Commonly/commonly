/**
 * A confined seat that an outsider-writable grant reaches runs with only the
 * shipped MCP servers (docs/plans/hosted-mcp-connection-scope.md §12 C).
 *
 * While a grant whose source outsiders can write reaches one of a seat's pods,
 * the server narrows what the seat's token can do (§12 A). It cannot see the
 * MCP servers the seat loads on this machine, though. The daemon admits a
 * declared stdio entry that equals one in the local token record
 * (`auditDeclaredMcp`), so a server its owner installed locally can sit beside
 * the grant's results, and content an outsider wrote can steer it. So before
 * each turn, a confined seat that may be narrowed is refused while its MCP set
 * holds anything but the shipped Commonly server or a shipped grant broker.
 *
 * The effective set is the declared one. A confined seat's adapter excludes
 * user- and project-scope MCP config (claude `--strict-mcp-config`, codex
 * `--ignore-user-config`, isolated homes for the others), and
 * `outsider-grant-mcp.test.mjs` pins those flags, so a scope added to an
 * adapter fails that test before it widens this set.
 *
 * Only confined seats (`sandbox.trust` public or workspace) are checked. An
 * unconfined seat named on a grant runs on its owner's machine with a shell,
 * under the owner's consent that what it reads can leave, so a local MCP
 * server adds nothing it lacks (§12, the F94 amendment).
 */
import { isShippedCommonlyMcpEntry, isShippedGrantBrokerEntry } from './declared-mcp-guard.js';

export const OUTSIDER_GRANT_MCP_UNCONFINED = 'outsider_grant_mcp_unconfined';

const CONFINED_TRUSTS = new Set(['public', 'workspace']);

export const seatIsConfined = (environment) => CONFINED_TRUSTS.has(environment?.sandbox?.trust);

// The server flags a broker on a grant that names this seat (`byoNamed`). It is
// a marker for the guard, not something the client reads, so it is set aside
// before the whole-entry match, and only as exactly `true`.
const withoutByoNamedFlag = (server) => {
  if (!server || typeof server !== 'object' || server.byoNamed !== true) return server;
  const { byoNamed: _byoNamed, ...rest } = server;
  return rest;
};

/** The entries of a turn's MCP set that are neither shipped server. */
export const unshippedMcpEntries = (environment, instanceUrl) => {
  const servers = Array.isArray(environment?.mcp) ? environment.mcp : [];
  return servers.filter((server) => !isShippedCommonlyMcpEntry(server)
    && !isShippedGrantBrokerEntry(withoutByoNamedFlag(server), instanceUrl));
};

/**
 * Whether the server's answer leaves the seat possibly narrowed. Only an
 * explicit `outsiderGrantNarrowed: false` clears it. A server from before the
 * field, or an answer that lacks it, counts as narrowed, because the CLI
 * publishes before the server change is deployed.
 */
export const mayBeNarrowed = (identity) => identity?.outsiderGrantNarrowed !== false;

/**
 * @returns {null | { code: string, names: string[], message: string }}
 */
export const outsiderGrantMcpRefusal = ({ environment, identity, instanceUrl }) => {
  if (!seatIsConfined(environment)) return null;
  const extra = unshippedMcpEntries(environment, instanceUrl);
  if (!extra.length || !mayBeNarrowed(identity)) return null;
  const names = extra.map((server) => String(server?.name || '(unnamed)'));
  const why = identity && 'outsiderGrantNarrowed' in identity
    ? 'a connector grant whose source outsiders can write reaches one of its pods'
    : 'the server did not say whether a connector grant reaches its pods, so it is treated as if one does';
  return {
    code: OUTSIDER_GRANT_MCP_UNCONFINED,
    names,
    message: `${OUTSIDER_GRANT_MCP_UNCONFINED}: this seat loads MCP servers beyond the shipped Commonly server `
      + `and grant broker (${names.join(', ')}), and ${why}. Remove them from the seat's environment, `
      + 'or use a separate agent for the connector pod.',
  };
};
