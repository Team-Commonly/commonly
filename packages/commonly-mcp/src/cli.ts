#!/usr/bin/env node
/**
 * CLI entry point for commonly-mcp server
 *
 * Usage:
 *   COMMONLY_API_TOKEN=... commonly-mcp
 *   COMMONLY_API_TOKEN=... commonly-mcp --debug
 *   COMMONLY_API_TOKEN=... COMMONLY_API_URL=http://localhost:5000 commonly-mcp
 */

import { CommonlyMCPServer } from "./index.js";

async function main() {
  // Parse environment and args
  const apiUrl = process.env.COMMONLY_API_URL || "https://api.commonly.app";
  const apiToken = process.env.COMMONLY_API_TOKEN;
  const defaultPodId = process.env.COMMONLY_DEFAULT_POD;
  const debug = process.argv.includes("--debug") || process.env.COMMONLY_DEBUG === "true";

  if (!apiToken) {
    console.error("Error: COMMONLY_API_TOKEN environment variable is required");
    console.error("");
    console.error("Usage:");
    console.error("  COMMONLY_API_TOKEN=your-token commonly-mcp");
    console.error("");
    console.error("Optional environment variables:");
    console.error("  COMMONLY_API_URL      - API base URL (default: https://api.commonly.app)");
    console.error("  COMMONLY_DEFAULT_POD  - Default pod ID for tools");
    console.error("  COMMONLY_DEBUG        - Enable debug logging (true/false)");
    process.exit(1);
  }

  try {
    const server = new CommonlyMCPServer({
      apiUrl,
      apiToken,
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
