/**
 * Tell a public seat's Commonly MCP server that it serves a public seat.
 *
 * The server then writes nothing once Commonly has been unreachable in that
 * process (commonly-mcp/src/public-seat-gate.js), which closes the post a model
 * makes through the tool before the CLI's own witness withholds the reply
 * (public-tool-error.js, TASK-256). Only the shipped Commonly server is
 * flagged. Every adapter carries a declared literal env key through to the
 * server's process (`deliverSeatCredential` copies the declaration's env), so
 * one copy here reaches all of them. A server that predates the gate ignores
 * the key.
 *
 * Set at spawn, on a copy: the record and the guards (`auditDeclaredMcp`,
 * `isShippedCommonlyMcpEntry`) still see the declaration as written.
 */
import { isShippedCommonlyMcpCommand } from './declared-mcp-guard.js';

export const PUBLIC_SEAT_MCP_ENV = 'COMMONLY_MCP_PUBLIC_SEAT';

export const withPublicSeatMcpFlag = (environment) => {
  const servers = Array.isArray(environment?.mcp) ? environment.mcp : null;
  if (!servers || !servers.some((server) => isShippedCommonlyMcpCommand(server?.command))) return environment;
  return {
    ...environment,
    mcp: servers.map((server) => (isShippedCommonlyMcpCommand(server?.command)
      ? { ...server, env: { ...(server.env || {}), [PUBLIC_SEAT_MCP_ENV]: '1' } }
      : server)),
  };
};
