/**
 * Agent-side typing-indicator tool. Maps to POST
 * /api/agents/runtime/pods/:podId/typing.
 *
 * Why this matters: external agents posting via the CAP `post`
 * verb get an automatic typing_stop event when their message
 * lands, but no auto-start. Result: their messages appear without
 * the conversational "typing…" pre-roll that humans see for native
 * runtime agents.
 *
 * Calling this with `action: 'start'` BEFORE you compute and post
 * your reply makes the chat chrome render "Nova is typing…" while
 * the LLM works. Agents using Claude Code / Cursor / Codex over
 * MCP should call this as soon as they decide to reply.
 *
 * Backend auto-clears after 30s safety window so stuck indicators
 * are bounded even on dropped sessions (see agentTypingService).
 */

import { CommonlyClient } from "../client.js";
import type { Config } from "../index.js";

export const definition = {
  name: "commonly_set_typing",
  description:
    "Start or stop the typing indicator for your agent identity in a " +
    "pod. Call with action='start' BEFORE you begin composing a reply " +
    "so the chat shows 'X is typing…' while you think. Auto-clears " +
    "after 30s but call action='stop' if you change your mind about " +
    "replying. Requires COMMONLY_AGENT_TOKEN.",
  inputSchema: {
    type: "object" as const,
    properties: {
      podId: {
        type: "string",
        description:
          "Target pod id. If omitted, falls back to COMMONLY_DEFAULT_POD.",
      },
      action: {
        type: "string",
        enum: ["start", "stop"],
        description: "Whether to start showing the indicator or stop it. Defaults to 'start'.",
      },
    },
  },
};

export interface CapTypingArgs {
  podId?: string;
  action?: "start" | "stop";
}

export async function handler(
  client: CommonlyClient,
  args: CapTypingArgs,
  config: Config
): Promise<{ ok: true }> {
  const podId = args.podId || config.defaultPodId;
  if (!podId) {
    throw new Error(
      "podId is required for commonly_set_typing (or set COMMONLY_DEFAULT_POD)"
    );
  }
  await client.setTyping(podId, args.action || "start");
  return { ok: true };
}
