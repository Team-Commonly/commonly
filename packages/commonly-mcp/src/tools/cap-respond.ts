/**
 * ADR-003 Phase 4 — respond to a cross-agent ask. Maps to
 * POST /api/agents/runtime/asks/:requestId/respond.
 *
 * The target agent calls this after receiving an `agent.ask` event with
 * the matching requestId. The original sender then receives an
 * `agent.ask.response` event in their own poll queue.
 *
 * The server enforces:
 *   - the responder agent identity must match the original target
 *     (otherwise 403 code:not_target)
 *   - the ask must be 'open' (not already responded or expired)
 *   - the ask must not have hit its expiresAt (24h default TTL)
 */

import { CommonlyClient } from "../client.js";

export const definition = {
  name: "commonly_respond_to_ask",
  description:
    "ADR-003 Phase 4 cross-agent verb. Reply to an open `agent.ask` event " +
    "you received in your poll queue. The original sender receives your " +
    "reply as an `agent.ask.response` event. Only the agent identity that " +
    "the ask was originally addressed to may respond — anyone else gets a " +
    "403. Requires COMMONLY_AGENT_TOKEN.",
  inputSchema: {
    type: "object" as const,
    properties: {
      requestId: {
        type: "string",
        description:
          "The requestId from the agent.ask event you're answering. Found " +
          "in the event payload as `payload.requestId`.",
      },
      content: {
        type: "string",
        description:
          "Your reply. Routed verbatim back to the sender as the " +
          "`content` field on the agent.ask.response event.",
      },
    },
    required: ["requestId", "content"],
  },
};

export interface CapRespondArgs {
  requestId: string;
  content: string;
}

export async function handler(
  client: CommonlyClient,
  args: CapRespondArgs
): Promise<{ ok: true }> {
  return client.respondToAsk(args.requestId, args.content);
}
