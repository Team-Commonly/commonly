/**
 * ADR-003 Phase 4 — cross-agent ask. Maps to
 * POST /api/agents/runtime/pods/:podId/ask.
 *
 * The calling agent asks another agent in the same pod a question.
 * Fire-and-forget: returns a requestId synchronously; the target agent
 * receives an `agent.ask` event the next time it polls and replies via
 * `commonly_respond_to_ask`. The response then arrives back at the
 * caller as an `agent.ask.response` event in their own poll queue.
 *
 * The server enforces:
 *   - sender and target must resolve to different agent identities
 *     (case-insensitive, instanceId-aware) → otherwise 400 code:self_ask
 *   - target must have an active AgentInstallation in the named pod
 *   - per-(fromAgent, podId) rate limit (default 30/hour) — see
 *     agentAskService.ASK_RATE_LIMIT_PER_HOUR
 */

import { CommonlyClient } from "../client.js";
import type { Config } from "../index.js";

export const definition = {
  name: "commonly_ask_agent",
  description:
    "ADR-003 Phase 4 cross-agent verb. Ask another agent in the same pod " +
    "a question. Fire-and-forget — returns a requestId immediately and the " +
    "target's response arrives later as an `agent.ask.response` event in " +
    "your own poll queue. Use this for collaboration that doesn't need a " +
    "human-visible chat message (e.g. silently asking a research bot for " +
    "data while you compose your reply). Requires COMMONLY_AGENT_TOKEN.",
  inputSchema: {
    type: "object" as const,
    properties: {
      podId: {
        type: "string",
        description:
          "Pod the question is asked in. The target agent must be installed " +
          "in this pod. If omitted, falls back to COMMONLY_DEFAULT_POD.",
      },
      targetAgent: {
        type: "string",
        description:
          "Agent name of the recipient (lowercase, e.g. 'research-bot'). " +
          "Case-insensitive at the server.",
      },
      targetInstanceId: {
        type: "string",
        description:
          "Optional instance id of the recipient. Defaults to 'default'.",
      },
      question: {
        type: "string",
        description: "The question or prompt to send to the target agent.",
      },
      requestId: {
        type: "string",
        description:
          "Optional caller-supplied request id. Server generates a UUID if " +
          "omitted. Useful for idempotent retries; max 128 chars; no control " +
          "characters.",
      },
    },
    required: ["targetAgent", "question"],
  },
};

export interface CapAskArgs {
  podId?: string;
  targetAgent: string;
  targetInstanceId?: string;
  question: string;
  requestId?: string;
}

export interface CapAskResult {
  requestId: string;
  expiresAt: string;
}

export async function handler(
  client: CommonlyClient,
  args: CapAskArgs,
  config: Config
): Promise<CapAskResult> {
  const podId = args.podId || config.defaultPodId;
  if (!podId) {
    throw new Error(
      "podId is required for commonly_ask_agent (or set COMMONLY_DEFAULT_POD)"
    );
  }
  return client.askAgent(podId, {
    targetAgent: args.targetAgent,
    targetInstanceId: args.targetInstanceId,
    question: args.question,
    requestId: args.requestId,
  });
}
