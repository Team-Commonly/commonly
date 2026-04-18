/**
 * @commonly/mcp-server
 *
 * MCP (Model Context Protocol) server that exposes Commonly as a context hub
 * for AI agents like moltbot, Claude Code, and custom agents.
 *
 * This is the "system call" interface between agents and the Commonly platform.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CommonlyClient } from "./client.js";
import { tools, handleToolCall } from "./tools/index.js";
import { getResources, readResource } from "./resources/index.js";

// Configuration schema
//
// At least one of `userToken` or `agentToken` must be supplied. `apiToken` is
// kept as a deprecated alias for `userToken` so existing callers don't break.
// Validation that "at least one" is present is done after parse — Zod's
// `.refine` would work too but a post-check gives a clearer error message
// for the CLI path.
const ConfigSchema = z
  .object({
    apiUrl: z.string().url().default("https://api.commonly.app"),
    /** User token (cm_*) — required for `/api/v1/*` tools (the original 7). */
    userToken: z.string().min(1).optional(),
    /** Agent runtime token (cm_agent_*) — required for CAP verbs (ADR-004). */
    agentToken: z.string().min(1).optional(),
    /** Deprecated alias for `userToken`. */
    apiToken: z.string().min(1).optional(),
    defaultPodId: z.string().optional(),
    debug: z.boolean().default(false),
  })
  .refine(
    (cfg) => Boolean(cfg.userToken || cfg.agentToken || cfg.apiToken),
    {
      message:
        "Config requires at least one of `userToken`, `agentToken`, or `apiToken`",
    }
  );

export type Config = z.infer<typeof ConfigSchema>;

export class CommonlyMCPServer {
  private server: Server;
  private client: CommonlyClient;
  private config: Config;

  constructor(config: Config) {
    this.config = ConfigSchema.parse(config);
    this.client = new CommonlyClient({
      apiUrl: this.config.apiUrl,
      userToken: this.config.userToken || this.config.apiToken,
      agentToken: this.config.agentToken,
    });

    this.server = new Server(
      {
        name: "commonly-context",
        version: "0.1.0",
      },
      {
        capabilities: {
          tools: {},
          resources: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;

      if (this.config.debug) {
        console.error(`[commonly-mcp] Tool call: ${name}`, args);
      }

      try {
        const result = await handleToolCall(
          this.client,
          name,
          args as Record<string, unknown>,
          this.config
        );
        return {
          content: [
            {
              type: "text" as const,
              text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text" as const,
              text: `Error: ${message}`,
            },
          ],
          isError: true,
        };
      }
    });

    // List available resources (pod memory files)
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => {
      const resources = await getResources(this.client);
      return { resources };
    });

    // Read a specific resource
    this.server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
      const { uri } = request.params;
      // Resources (MEMORY.md, daily logs, etc.) all live on the user-auth
      // surface. In agent-only mode we have nothing to serve — return the
      // same shape the tool-call catch uses (isError: true + text message)
      // rather than letting requireUserHttp() bubble an MCPClientError.
      if (!this.client.hasUserAuth()) {
        return {
          contents: [
            {
              uri,
              mimeType: "text/plain",
              text:
                "Error: resource reads require a user token (set COMMONLY_USER_TOKEN). " +
                "This MCP server is running in agent-only mode.",
            },
          ],
          isError: true,
        };
      }
      const content = await readResource(this.client, uri);
      return {
        contents: [
          {
            uri,
            mimeType: "text/markdown",
            text: content,
          },
        ],
      };
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    if (this.config.debug) {
      console.error("[commonly-mcp] Server started");
    }
  }
}

// Export for programmatic use
export { CommonlyClient } from "./client.js";
export { tools } from "./tools/index.js";
