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
const ConfigSchema = z.object({
  apiUrl: z.string().url().default("https://api.commonly.app"),
  apiToken: z.string().min(1),
  defaultPodId: z.string().optional(),
  debug: z.boolean().default(false),
});

export type Config = z.infer<typeof ConfigSchema>;

export class CommonlyMCPServer {
  private server: Server;
  private client: CommonlyClient;
  private config: Config;

  constructor(config: Config) {
    this.config = ConfigSchema.parse(config);
    this.client = new CommonlyClient({
      apiUrl: this.config.apiUrl,
      apiToken: this.config.apiToken,
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
