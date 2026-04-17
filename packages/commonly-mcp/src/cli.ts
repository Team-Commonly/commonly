#!/usr/bin/env node
/**
 * CLI entry point for commonly-mcp server
 *
 * Two auth modes (either or both — at least one required):
 *
 *   COMMONLY_USER_TOKEN=cm_...        # /api/v1/* user-space tools
 *   COMMONLY_AGENT_TOKEN=cm_agent_... # /api/agents/runtime/* CAP verbs (ADR-004)
 *
 * Usage:
 *   COMMONLY_USER_TOKEN=...  commonly-mcp
 *   COMMONLY_AGENT_TOKEN=... commonly-mcp
 *   COMMONLY_USER_TOKEN=... COMMONLY_AGENT_TOKEN=... commonly-mcp --debug
 *   COMMONLY_USER_TOKEN=... COMMONLY_API_URL=http://localhost:5000 commonly-mcp
 */

import { CommonlyMCPServer } from "./index.js";

function printUsage(): void {
  console.error("");
  console.error("Usage:");
  console.error("  COMMONLY_USER_TOKEN=cm_... commonly-mcp           # user-space tools only");
  console.error("  COMMONLY_AGENT_TOKEN=cm_agent_... commonly-mcp    # CAP verbs only (agent mode)");
  console.error("  COMMONLY_USER_TOKEN=... COMMONLY_AGENT_TOKEN=... commonly-mcp  # both");
  console.error("");
  console.error("Auth modes (at least one required):");
  console.error("  COMMONLY_USER_TOKEN   - user token (cm_*)        — context, search, write, etc.");
  console.error("  COMMONLY_AGENT_TOKEN  - agent runtime token (cm_agent_*) — CAP verbs (poll/ack/post/memory)");
  console.error("");
  console.error("Optional environment variables:");
  console.error("  COMMONLY_API_URL      - API base URL (default: https://api.commonly.app)");
  console.error("  COMMONLY_DEFAULT_POD  - Default pod ID for tools");
  console.error("  COMMONLY_DEBUG        - Enable debug logging (true/false)");
  console.error("  OPENCLAW_USER_TOKEN   - Alias for COMMONLY_USER_TOKEN");
  console.error("  COMMONLY_API_TOKEN    - Legacy token name (deprecated)");
}

async function main() {
  // Parse environment and args
  const apiUrl = process.env.COMMONLY_API_URL || "https://api.commonly.app";
  const userToken =
    process.env.COMMONLY_USER_TOKEN ||
    process.env.OPENCLAW_USER_TOKEN ||
    process.env.COMMONLY_API_TOKEN;
  const agentToken = process.env.COMMONLY_AGENT_TOKEN;
  const defaultPodId = process.env.COMMONLY_DEFAULT_POD;
  const debug = process.argv.includes("--debug") || process.env.COMMONLY_DEBUG === "true";

  if (!userToken && !agentToken) {
    console.error(
      "Error: at least one of COMMONLY_USER_TOKEN or COMMONLY_AGENT_TOKEN must be set"
    );
    printUsage();
    process.exit(1);
  }

  // Surface which modes are active so misconfigured clients are obvious in
  // logs. stderr only — stdout is the MCP transport channel.
  console.error(
    `[commonly-mcp] auth modes — user-token: ${userToken ? "yes" : "no"}, agent-token: ${
      agentToken ? "yes" : "no"
    }`
  );

  try {
    const server = new CommonlyMCPServer({
      apiUrl,
      userToken,
      agentToken,
      defaultPodId,
      debug,
    });

    await server.run();
  } catch (error) {
    console.error("Fatal error:", error);
    process.exit(1);
  }
}

main();
