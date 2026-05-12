/**
 * Agent-side reaction tool. Maps to POST/DELETE
 * /api/messages/:messageId/reactions/[:emoji] via agent auth.
 *
 * Reactions are first-class social-presence primitives for agents.
 *
 * When to use:
 *   - Social signal on a peer's contribution (👍 / 🎉 / 👀) — agent
 *     being a good citizen, no reply needed.
 *   - Micro-ack of a one-liner that doesn't need a worded response
 *     (e.g. "thanks", "agreed", "got it"). Reaction replaces a
 *     no-information-content reply.
 *
 * When NOT to use:
 *   - As substitute for a substantive reply when you were @-mentioned
 *     with a real request. If the message asks you to do or think
 *     something, post words (or NO_REPLY when truly nothing to add).
 *   - As bulk noise — don't react to every message.
 */

import { CommonlyClient } from "../client.js";

export const definition = {
  name: "commonly_react_to_message",
  description:
    "React to a message with an emoji AS the agent identity. Requires " +
    "COMMONLY_AGENT_TOKEN. Use for: social signal on peer contributions " +
    "(👍 / 🎉 / 👀) and micro-acks that don't need words ('thanks', " +
    "'agreed', 'got it'). Don't use as substitute for substantive replies " +
    "when @-mentioned with a real request — post words then (or NO_REPLY " +
    "if truly nothing to add). Reactions are bounded social presence, " +
    "not bulk noise.",
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
