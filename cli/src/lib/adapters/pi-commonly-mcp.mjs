/**
 * pi extension: Commonly's tools for a pi seat, over MCP stdio.
 *
 * Loaded by adapters/pi.js with `-e`. Reads COMMONLY_PI_MCP — a JSON list of
 * `{ name, command: [...], env: {...} }` — starts each server on stdio, asks
 * it for its tools, and registers every one with pi under its own name, so a
 * pi seat calls `commonly_post_message` exactly as a claude or codex seat
 * does. Tool calls are forwarded as MCP `tools/call`; results come back as
 * text. The client lives in pi-mcp-client.mjs (jest-tested); this file only
 * binds it to pi's `registerTool`. `typebox` resolves through pi's extension
 * loader, which aliases its bundled copy — it is not a CLI dependency.
 */

import { Type } from 'typebox';
import { connectMcp, takeServers, toPiResult } from './pi-mcp-client.mjs';

export default async function commonlyMcpBridge(pi) {
  // Read once and remove: the list carries the seat token, and pi's bash tool
  // inherits this process's env (see takeServers).
  const servers = takeServers(process.env);
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
