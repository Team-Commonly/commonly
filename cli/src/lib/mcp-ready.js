/**
 * Ready files for a public seat's MCP servers (F421, F460).
 *
 * The Commonly MCP server reads the seat credential once, at start, and
 * creates the file named in COMMONLY_MCP_READY_FILE on its host's first
 * `tools/list` (commonly-mcp/src/ready-file.js); the grant-broker bridge does
 * the same (codex-broker-bridge.mjs). So once every ready file a spawn named
 * exists, nothing in that spawn still needs the credential file, and
 * `armCredentialRelease` (credential-file.js) deletes it.
 *
 * A seat names files only when the spawn has a ready folder, which the adapter
 * creates for a public seat alone. A public seat whose Commonly server can't
 * be shown to write one is refused: a warm build from before ready files, or
 * our package run from a path outside the host-prepared MCP home (a checkout).
 * Without the file its credential would stay readable to the deadline on every
 * turn, or, named by nothing, be gone before that server read it.
 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { CREDENTIAL_FILE_VAR } from './credential-file.js';
import { isShippedCommonlyMcpCommand } from './declared-mcp-guard.js';
import { selectedMcpWritesReadyFile } from './mcp-home.js';
import { describeMcpCommand } from './mcp-server-version.js';

export const MCP_READY_FILE_ENV = 'COMMONLY_MCP_READY_FILE';

const nameReadyFile = (name, ctx) => {
  const path = join(ctx.readyFileDir, randomUUID());
  ctx.readyFiles.push({ name, path });
  return path;
};

export const publicMcpOutdatedError = (name) => new Error(
  `public seats need a Commonly MCP server that reports when it has started, and the one this seat runs for `
  + `${name} does not (a build from before that, or one run from outside the host-prepared MCP home); `
  + 'update @commonlyai/mcp',
);

export const publicMcpUnreportedReaderError = (name) => new Error(
  `public seats hand the runtime credential only to the Commonly MCP server, which reports when it has read it; `
  + `${name} is another server declaring ${CREDENTIAL_FILE_VAR}, so it would lose the credential before reading it. `
  + 'Remove that declaration, or run this server on a private seat',
);

/**
 * The ready file for `server` (as declared), run as `spawnCommand` (the warm
 * build it resolved to), or null when this spawn names none for it.
 */
export const commonlyMcpReadyFile = (server, spawnCommand, ctx, {
  writesReadyFile = selectedMcpWritesReadyFile,
  describe = describeMcpCommand,
  env = null,
} = {}) => {
  if (!ctx?.readyFileDir) return null;
  const ours = isShippedCommonlyMcpCommand(server?.command) || Boolean(describe(spawnCommand)?.isCommonly);
  if (!ours) {
    // `env` is the entry's environment after credential delivery: a server that
    // is not ours but was handed the credential path names no ready file, so
    // the release would not wait for it.
    if (env && String(env[CREDENTIAL_FILE_VAR] ?? '').trim()) throw publicMcpUnreportedReaderError(server?.name);
    return null;
  }
  if (!writesReadyFile(spawnCommand)) throw publicMcpOutdatedError(server.name);
  return nameReadyFile(server.name, ctx);
};

/** The broker bridge ships with this CLI, so it always writes one. */
export const bridgeReadyFile = (server, ctx) => (ctx?.readyFileDir ? nameReadyFile(server.name, ctx) : null);
