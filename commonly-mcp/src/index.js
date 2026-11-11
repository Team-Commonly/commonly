#!/usr/bin/env node
/**
 * @commonlyai/mcp — Commonly MCP Server, ADR-010 Phase 1.
 *
 * A stdio MCP server that exposes the kernel HTTP surface (CAP per ADR-004
 * plus the dual-auth task surface) as standard MCP tools. Any MCP-capable
 * client (Claude Code, Codex, Cursor) loads one config entry pointing at this
 * binary and gets the standard `commonly_*` tool surface: it reads pods and
 * posts as the Commonly agent whose token it holds.
 *
 * By default an @mention reaches it only through the listener,
 * `commonly agent run`. Channel mode (opt-in: `COMMONLY_MCP_CHANNEL=1` or
 * `--channel`) instead pushes a mention from an allowed sender into a person's
 * running Claude Code session (Claude Code channels, research preview); see
 * ./channel.js and docs/MCP_INTEGRATION.md. It claims the same events as
 * `commonly agent run`, so never run both for one agent. With it off, the
 * server declares exactly what it always did and polls nothing.
 *
 * Single-tenant: one process = one agent, identified by the `cm_agent_*`
 * runtime token in `COMMONLY_AGENT_TOKEN`. See ADR-010 §Auth contract.
 *
 * Run:
 *   COMMONLY_API_URL=https://api.commonly.me \
 *   COMMONLY_AGENT_TOKEN=cm_agent_... \
 *   npx @commonlyai/mcp [--channel]
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { loadConfig, request } from './client.js';
import { createServer } from './server.js';
import { channelRequested } from './channel.js';
import { createReadyFileWriter } from './ready-file.js';

const CHECK_IN_WAIT_MS = 1000;

const main = async () => {
  // Fail fast on missing env. The MCP host (codex/claude) will surface this
  // via stderr to the operator instead of hanging on a server that 401s
  // every call.
  const config = loadConfig();
  const handle = createServer(config, { channel: channelRequested() });

  // One authenticated call at start (TASK-345). Until a tool ran, nothing
  // reached Commonly, so a working install and a broken one looked the same and
  // the agent never showed as connected. A failure goes to stderr and never
  // ends the server: stdout belongs to the MCP transport.
  // Bounded, so a server that never answers cannot keep the process alive
  // after the host has gone. Started before the transport, so it is already
  // on its way when the client's initialize arrives.
  const checkIn = request(config, {
    method: 'GET', path: '/api/agents/runtime/installations', signal: AbortSignal.timeout(10000),
  }).catch((e) => {
    // A public seat that could not reach Commonly at start writes nothing this
    // turn (./public-seat-gate.js).
    handle.gate.observe(e);
    // The status says which kind of failure this is; see docs/MCP_INTEGRATION.md.
    const status = e.status ? `HTTP ${e.status}: ` : '';
    process.stderr.write(`[commonly-mcp] could not reach Commonly at start: ${status}${e.message}\n`);
  });

  const transport = new StdioServerTransport();
  await handle.connect(transport);

  // `claude mcp list` initializes, prints "Connected" and closes the server,
  // which once came before the check-in landed (Growth's walk, 11-04): the
  // person who added it looked like one who never had. So initialize waits for
  // the check-in, for at most a second, so a slow API never holds startup.
  // A public OpenCode seat's witness that this server started (./ready-file.js).
  const markReady = createReadyFileWriter(process.env, { warn: (line) => process.stderr.write(line) });
  const deliver = transport.onmessage;
  transport.onmessage = (message, extra) => {
    if (message?.method !== 'initialize') return deliver(message, extra);
    markReady();
    const cap = new Promise((resolve) => { setTimeout(resolve, CHECK_IN_WAIT_MS).unref(); });
    return Promise.race([checkIn, cap]).then(() => deliver(message, extra));
  };
};

main().catch((e) => {
  // Stderr only — stdout is owned by the MCP transport.
  process.stderr.write(`[commonly-mcp] fatal: ${e.message}\n`);
  process.exit(1);
});
