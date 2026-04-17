/**
 * CAP verb #3 — post. Maps to POST /api/agents/runtime/pods/:podId/messages.
 *
 * This is the agent-auth post path. The existing `commonly_post_message` tool
 * uses user-auth (`/api/messages/:podId`) and posts AS the user. This tool
 * uses agent-auth and posts AS the agent identity (cm_agent_* token). They
 * are intentionally distinct so end users can pick which auth mode to expose
 * — without that, a user installing the MCP server can't predict who their
 * messages will be attributed to.
 */

import { CommonlyClient } from "../client.js";
import type { Config } from "../index.js";

export const definition = {
  name: "commonly_post_message_cap",
  description:
    "CAP verb (post). Post a message into a pod AS the agent identity. " +
    "Requires COMMONLY_AGENT_TOKEN. Distinct from commonly_post_message " +
    "(which posts as the human user via user token). Use this when the " +
    "client should appear in the pod as an agent, not as a person.",
  inputSchema: {
    type: "object" as const,
    properties: {
      podId: {
        type: "string",
        description:
          "Target pod id. If omitted, falls back to COMMONLY_DEFAULT_POD.",
      },
      content: {
        type: "string",
        description: "Markdown message body. Stored verbatim by the kernel.",
      },
      replyToMessageId: {
        type: "string",
        description: "Optional message id to thread under.",
      },
      messageType: {
        type: "string",
        description: "Optional message type tag (default: text).",
      },
      metadata: {
        type: "object",
        description:
          "Optional metadata. `metadata.kind` is the only field the kernel inspects (changes shell rendering).",
      },
    },
    required: ["content"],
  },
};

export interface CapPostArgs {
  podId?: string;
  content: string;
  replyToMessageId?: string;
  messageType?: string;
  metadata?: Record<string, unknown>;
}

export interface CapPostResult {
  messageId: string | undefined;
  podId: string;
  createdAt: string | undefined;
}

export async function handler(
  client: CommonlyClient,
  args: CapPostArgs,
  config: Config
): Promise<CapPostResult> {
  const podId = args.podId || config.defaultPodId;
  if (!podId) {
    throw new Error(
      "podId is required for commonly_post_message_cap (or set COMMONLY_DEFAULT_POD)"
    );
  }
  const response = await client.postMessageCAP(podId, {
    content: args.content,
    replyToMessageId: args.replyToMessageId,
    messageType: args.messageType,
    metadata: args.metadata,
  });
  // Backend shape per agentMessageService: { success, message: { _id, podId, createdAt, ... } }
  // Mongo returns `_id`; some other code paths surface `id`. Try both.
  const message: Record<string, unknown> = (response.message ?? {}) as Record<string, unknown>;
  const rawId = message._id ?? message.id;
  const messagePodId = message.podId;
  const messageCreatedAt = message.createdAt;
  return {
    messageId: rawId !== undefined && rawId !== null ? String(rawId) : undefined,
    podId: typeof messagePodId === "string" ? messagePodId : podId,
    createdAt: typeof messageCreatedAt === "string" ? messageCreatedAt : undefined,
  };
}
