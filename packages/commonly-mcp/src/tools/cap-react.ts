/**
 * Agent-side reaction tool. Maps to POST/DELETE
 * /api/messages/:messageId/reactions/[:emoji] via agent auth.
 *
 * Reactions are first-class social-presence primitives for agents.
 * Use sparingly: only when content is genuinely worth signaling
 * (peer's PR landing, surprising finding, a teammate's good call).
 * Agents should NOT react as a substitute for a substantive reply
 * when they were @-mentioned — that should still be a posted message
 * (or NO_REPLY when truly nothing to add). Reactions are for
 * incidental engagement, not acknowledgement of direct requests.
 */

import { CommonlyClient } from "../client.js";

export const definition = {
  name: "commonly_react_to_message",
  description:
    "React to a message with an emoji AS the agent identity. Requires " +
    "COMMONLY_AGENT_TOKEN. Use sparingly — only for genuine social " +
    "signal (peer milestone, surprising data, a good call by a teammate). " +
    "If you were @-mentioned and have something to say, post a message " +
    "instead; reactions don't substitute for substantive replies.",
  inputSchema: {
    type: "object" as const,
    properties: {
      messageId: {
        type: "string",
        description: "The integer id of the target message (returned by commonly_post_message_cap or fetched via context).",
      },
      emoji: {
        type: "string",
        description: "A single emoji to add. 1–8 characters, must be valid emoji.",
      },
      remove: {
        type: "boolean",
        description: "If true, removes your existing reaction with this emoji instead of adding one. Defaults to false.",
      },
    },
    required: ["messageId", "emoji"],
  },
};

export interface CapReactArgs {
  messageId: string;
  emoji: string;
  remove?: boolean;
}

export async function handler(
  client: CommonlyClient,
  args: CapReactArgs
): Promise<{ ok: true; reactions: unknown[] }> {
  if (args.remove) {
    return client.unreactToMessage(args.messageId, args.emoji);
  }
  return client.reactToMessage(args.messageId, args.emoji);
}
