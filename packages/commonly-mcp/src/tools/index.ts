/**
 * MCP Tools for Commonly Context Hub
 *
 * These tools expose Commonly's context capabilities to AI agents.
 * Each tool follows the MCP tool specification.
 */

import { CommonlyClient } from "../client.js";
import { Config } from "../index.js";

export interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

/**
 * Tool definitions
 */
export const tools: Tool[] = [
  {
    name: "commonly_pods",
    description:
      "List all pods (team contexts) you have access to. Use this to discover available knowledge bases before searching or reading context.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "commonly_search",
    description:
      "Search a pod's memory using hybrid vector + keyword search. Returns relevant assets, summaries, and skills based on semantic similarity and keyword matching. Use this to find specific information in team knowledge.",
    inputSchema: {
      type: "object",
      properties: {
        podId: {
          type: "string",
          description: "The pod ID to search in",
        },
        query: {
          type: "string",
          description: "Natural language search query",
        },
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
        types: {
          type: "array",
          items: { type: "string" },
          description:
            "Filter by asset types: summary, skill, message, file, doc, link",
        },
        since: {
          type: "string",
          description: "Only include results after this ISO date",
        },
      },
      required: ["podId", "query"],
    },
  },
  {
    name: "commonly_context",
    description:
      "Get structured context for a pod, optionally filtered by a task description. Returns assembled context including memory, skills, relevant assets, and recent summaries. Use this when you need comprehensive team knowledge for a task.",
    inputSchema: {
      type: "object",
      properties: {
        podId: {
          type: "string",
          description: "The pod ID to get context from",
        },
        task: {
          type: "string",
          description:
            "Optional task description to filter relevant context",
        },
        includeSkills: {
          type: "boolean",
          description: "Include pod-derived skills (default: true)",
        },
        includeMemory: {
          type: "boolean",
          description: "Include curated MEMORY.md content (default: true)",
        },
        maxTokens: {
          type: "number",
          description: "Maximum token budget for context (default: 8000)",
        },
      },
      required: ["podId"],
    },
  },
  {
    name: "commonly_read",
    description:
      "Read a specific asset or memory file from a pod. Use this to get full content of a search result or to read daily logs and curated memory.",
    inputSchema: {
      type: "object",
      properties: {
        podId: {
          type: "string",
          description: "The pod ID",
        },
        assetId: {
          type: "string",
          description: "Specific asset ID to read",
        },
        path: {
          type: "string",
          description:
            'Virtual path like "MEMORY.md", "SKILLS.md", or "memory/2026-01-28.md"',
        },
      },
      required: ["podId"],
    },
  },
  {
    name: "commonly_write",
    description:
      "Write to pod memory. Can append to daily log, update curated memory, or create a skill. Use this to persist important information, decisions, or learnings back to the team.",
    inputSchema: {
      type: "object",
      properties: {
        podId: {
          type: "string",
          description: "The pod ID to write to",
        },
        target: {
          type: "string",
          enum: ["daily", "memory", "skill"],
          description:
            "Where to write: daily (daily log), memory (MEMORY.md), skill (create skill)",
        },
        content: {
          type: "string",
          description: "The content to write",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Optional tags for categorization",
        },
      },
      required: ["podId", "target", "content"],
    },
  },
  {
    name: "commonly_post_message",
    description:
      "Post a chat message into a pod. Use this when the agent needs to reply or share an update directly in the pod conversation.",
    inputSchema: {
      type: "object",
      properties: {
        podId: {
          type: "string",
          description: "The pod ID to post the message to",
        },
        content: {
          type: "string",
          description: "The message content to post",
        },
        messageType: {
          type: "string",
          description: "Optional message type (default: text)",
        },
        attachments: {
          type: "array",
          items: {},
          description: "Optional attachments payload (future use)",
        },
      },
      required: ["podId", "content"],
    },
  },
  {
    name: "commonly_skills",
    description:
      "Get skills derived from a pod's activity. Skills are reusable knowledge units like checklists, procedures, and patterns extracted from team discussions.",
    inputSchema: {
      type: "object",
      properties: {
        podId: {
          type: "string",
          description: "The pod ID",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Filter skills by tags",
        },
        limit: {
          type: "number",
          description: "Maximum number of skills to return",
        },
      },
      required: ["podId"],
    },
  },
];

/**
 * Handle a tool call
 */
export async function handleToolCall(
  client: CommonlyClient,
  name: string,
  args: Record<string, unknown>,
  config: Config
): Promise<unknown> {
  // Resolve podId from args or default
  const resolvePodId = (args: Record<string, unknown>): string => {
    const podId = args.podId as string | undefined;
    if (podId) return podId;
    if (config.defaultPodId) return config.defaultPodId;
    throw new Error(
      "podId is required. Either provide it in the arguments or set a defaultPodId in config."
    );
  };

  switch (name) {
    case "commonly_pods": {
      const pods = await client.listPods();
      return {
        pods: pods.map((pod) => ({
          id: pod.id,
          name: pod.name,
          description: pod.description,
          type: pod.type,
          role: pod.role,
        })),
        hint: "Use a pod's id with other tools to access its context.",
      };
    }

    case "commonly_search": {
      const podId = resolvePodId(args);
      const query = args.query as string;
      const limit = args.limit as number | undefined;
      const types = args.types as string[] | undefined;
      const since = args.since as string | undefined;

      const response = await client.search(podId, query, { limit, types, since });
      return {
        results: response.results,
        meta: response.meta,
        hint:
          response.results.length > 0
            ? "Use commonly_read with assetId to get full content of a result."
            : "No results found. Try a different query or check commonly_pods for available pods.",
      };
    }

    case "commonly_context": {
      const podId = resolvePodId(args);
      const task = args.task as string | undefined;
      const includeSkills = args.includeSkills as boolean | undefined;
      const includeMemory = args.includeMemory as boolean | undefined;
      const maxTokens = args.maxTokens as number | undefined;

      const context = await client.getContext(podId, {
        task,
        includeSkills,
        includeMemory,
        maxTokens,
      });
      return context;
    }

    case "commonly_read": {
      const podId = resolvePodId(args);
      const assetId = args.assetId as string | undefined;
      const path = args.path as string | undefined;

      if (assetId) {
        const asset = await client.readAsset(podId, assetId);
        return {
          title: asset.title,
          type: asset.type,
          content: asset.content,
          tags: asset.tags,
          source: asset.source,
        };
      } else if (path) {
        const content = await client.readMemoryFile(podId, path);
        return {
          path,
          content,
        };
      } else {
        throw new Error("Either assetId or path is required");
      }
    }

    case "commonly_write": {
      const podId = resolvePodId(args);
      const target = args.target as "daily" | "memory" | "skill";
      const content = args.content as string;
      const tags = args.tags as string[] | undefined;

      const response = await client.write(podId, {
        target,
        content,
        tags,
        source: {
          agent: "mcp-client",
        },
      });
      return response;
    }

    case "commonly_post_message": {
      const podId = resolvePodId(args);
      const content = args.content as string;
      const messageType = args.messageType as string | undefined;
      const attachments = args.attachments as unknown[] | undefined;

      const response = await client.postMessage(podId, {
        content,
        messageType,
        attachments,
      });
      return response;
    }

    case "commonly_skills": {
      const podId = resolvePodId(args);
      const tags = args.tags as string[] | undefined;
      const limit = args.limit as number | undefined;

      const skills = await client.getSkills(podId, { tags, limit });
      return {
        skills: skills.map((skill) => ({
          id: skill.id,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          tags: skill.tags,
        })),
        hint: "Skills are derived from team activity. Use instructions as guidance for tasks.",
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
