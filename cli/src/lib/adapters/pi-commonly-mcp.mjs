/**
 * pi extension: Commonly's tools for a pi seat, over MCP.
 *
 * Loaded by adapters/pi.js with `-e`. Reads fd 3 — a pipe the adapter writes the
 * JSON into and ends at spawn, never the environment (see takeServers) — a JSON
 * list of `{ name, command: [...], env: {...} }` for stdio servers and
 * `{ name, url, headers: {...} }` for Streamable HTTP ones — connects to each,
 * asks it for its tools, and registers every one with pi under its own name, so
 * a pi seat calls `commonly_post_message` exactly as a claude or codex seat
 * does. Tool calls are forwarded as MCP `tools/call`; results come back as
 * text. The client lives in pi-mcp-client.mjs (jest-tested); this file only
 * binds it to pi's `registerTool`. `typebox` resolves through pi's extension
 * loader, which aliases its bundled copy — it is not a CLI dependency.
 *
 * pi ships no MCP support of its own (its README: "No MCP. … build an
 * extension that adds MCP support"), so this file is the whole transport story
 * for a pi seat: a server that is not reachable from here is not reachable.
 */

import { Type } from 'typebox';
import { connectMcp, takeServers, toPiResult } from './pi-mcp-client.mjs';

export default async function commonlyMcpBridge(pi) {
  // Read once and consume: the read drains the pipe, so the list (which carries
  // the seat token) does not survive anywhere in this process that a child could
  // reach — not the environment, which is why it does not arrive that way.
  const servers = takeServers();
  // The adapter loads this extension only when it has a list to hand over, so an
  // empty read means the channel itself failed. Say so: the symptom otherwise is
  // a seat that silently has no commonly_* tools at all.
  if (!servers.length) {
    process.stderr.write('[commonly-pi-bridge] no server list on fd 3 — this seat has no commonly_* tools\n');
  }
  const clients = [];
  for (const server of servers) {
    const client = connectMcp(server);
    clients.push(client);
    try {
      await client.initialize();
      const tools = await client.listTools();
      for (const tool of tools) {
        pi.registerTool({
          name: tool.name,
          label: tool.name,
          description: tool.description || tool.name,
          // The server's JSON schema, passed through: pi validates against it as-is.
          parameters: Type.Unsafe(tool.inputSchema || { type: 'object', properties: {} }),
          async execute(_toolCallId, params) {
            return toPiResult(await client.callTool(tool.name, params));
          },
        });
      }
    } catch (error) {
      process.stderr.write(`[commonly-pi-bridge] ${server.name}: ${error.message}\n`);
    }
  }
  const shutdown = () => { for (const client of clients) client.close(); };
  process.on('exit', shutdown);
  if (typeof pi.on === 'function') pi.on('session_shutdown', shutdown);
}
