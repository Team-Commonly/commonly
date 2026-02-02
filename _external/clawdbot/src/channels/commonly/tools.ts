import { Type } from "@sinclair/typebox";

import type { AnyAgentTool } from "../../agents/tools/common.js";
import {
  jsonResult,
  readNumberParam,
  readStringArrayParam,
  readStringParam,
} from "../../agents/tools/common.js";
import { CommonlyClient } from "./client.js";

const MemoryTargetSchema = Type.Unsafe<"daily" | "memory" | "skill">({
  type: "string",
  enum: ["daily", "memory", "skill"],
});

export class CommonlyTools {
  private client: CommonlyClient;
  private tools: AnyAgentTool[];

  constructor(client: CommonlyClient) {
    this.client = client;
    this.tools = this.buildTools();
  }

  getToolDefinitions(): AnyAgentTool[] {
    return this.tools;
  }

  async execute(toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const tool = this.tools.find((entry) => entry.name === toolName);
    if (!tool) {
      throw new Error(`Unknown Commonly tool: ${toolName}`);
    }
    return tool.execute(toolName, args);
  }

  private buildTools(): AnyAgentTool[] {
    const client = this.client;

    return [
      {
        name: "commonly_post_message",
        label: "Commonly Post Message",
        description: "Post a message to a Commonly pod chat.",
        parameters: Type.Object({
          podId: Type.String(),
          content: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const result = await client.postMessage(podId, content);
          return jsonResult({ ok: true, message: result });
        },
      },
      {
        name: "commonly_post_thread_comment",
        label: "Commonly Post Thread Comment",
        description: "Reply to a Commonly thread (post comment).",
        parameters: Type.Object({
          threadId: Type.String(),
          content: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const threadId = readStringParam(params, "threadId", { required: true });
          const content = readStringParam(params, "content", { required: true });
          const result = await client.postThreadComment(threadId, content);
          return jsonResult({ ok: true, comment: result });
        },
      },
      {
        name: "commonly_search",
        label: "Commonly Search",
        description: "Search Commonly pod memory and assets.",
        parameters: Type.Object({
          podId: Type.String(),
          query: Type.String(),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const query = readStringParam(params, "query", { required: true });
          const results = await client.search(podId, query);
          return jsonResult({ ok: true, results });
        },
      },
      {
        name: "commonly_read_context",
        label: "Commonly Read Context",
        description: "Fetch assembled Commonly pod context (summaries + skills + assets).",
        parameters: Type.Object({
          podId: Type.String(),
          task: Type.Optional(Type.String()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const task = readStringParam(params, "task");
          const context = await client.getContext(podId, task || undefined);
          return jsonResult({ ok: true, context });
        },
      },
      {
        name: "commonly_write_memory",
        label: "Commonly Write Memory",
        description: "Write to Commonly pod memory (daily/memory/skill).",
        parameters: Type.Object({
          podId: Type.String(),
          target: MemoryTargetSchema,
          content: Type.String(),
          tags: Type.Optional(Type.Array(Type.String())),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const target = readStringParam(params, "target", { required: true }) as
            | "daily"
            | "memory"
            | "skill";
          const content = readStringParam(params, "content", { required: true });
          const tags = readStringArrayParam(params, "tags") ?? [];
          const result = await client.writeMemory(podId, target, content, { tags });
          return jsonResult({ ok: true, result });
        },
      },
      {
        name: "commonly_get_summaries",
        label: "Commonly Get Summaries",
        description: "Get recent Commonly pod summaries.",
        parameters: Type.Object({
          podId: Type.String(),
          hours: Type.Optional(Type.Number()),
        }),
        async execute(_id: string, params: Record<string, unknown>) {
          const podId = readStringParam(params, "podId", { required: true });
          const hours = readNumberParam(params, "hours") ?? 24;
          const summaries = await client.getSummaries(podId, hours);
          return jsonResult({ ok: true, summaries });
        },
      },
    ];
  }
}
