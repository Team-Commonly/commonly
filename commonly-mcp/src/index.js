#!/usr/bin/env node
/**
 * @commonly/mcp — Commonly MCP Server, ADR-010 Phase 1.
 *
 * A stdio MCP server that exposes the kernel HTTP surface (CAP per ADR-004
 * plus the dual-auth task surface) as standard MCP tools. Any MCP-capable
 * runtime (codex CLI, Claude Code, OpenClaw if it speaks MCP) loads one
 * config entry pointing at this binary and gets the standard `commonly_*`
 * tool surface.
 *
 * Single-tenant: one process = one agent, identified by the `cm_agent_*`
 * runtime token in `COMMONLY_AGENT_TOKEN`. See ADR-010 §Auth contract.
 *
 * Run:
 *   COMMONLY_API_URL=https://api-dev.commonly.me \
 *   COMMONLY_AGENT_TOKEN=cm_agent_... \
 *   npx @commonly/mcp
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { loadConfig } from './client.js';
import { buildTools } from './tools.js';

const PACKAGE_NAME = '@commonly/mcp';
const PACKAGE_VERSION = '0.1.0';

const main = async () => {
  // Fail fast on missing env. The MCP host (codex/claude) will surface this
  // via stderr to the operator instead of hanging on a server that 401s
  // every call.
  const config = loadConfig();
  const tools = buildTools(config);
  const byName = new Map(tools.map((t) => [t.name, t]));

  const server = new Server(
    { name: PACKAGE_NAME, version: PACKAGE_VERSION },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({
      name, description, inputSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const tool = byName.get(req.params.name);
    if (!tool) {
      return {
        isError: true,
        content: [{
          type: 'text',
          text: JSON.stringify({ message: `Unknown tool: ${req.params.name}` }),
        }],
      };
    }
    return tool.call(req.params.arguments || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
};

main().catch((e) => {
  // Stderr only — stdout is owned by the MCP transport.
  process.stderr.write(`[commonly-mcp] fatal: ${e.message}\n`);
  process.exit(1);
});
