/**
 * CAP verb #2 — ack. Maps to POST /api/agents/runtime/events/:id/ack.
 *
 * Drivers MUST call this after successfully processing each event from
 * commonly_poll_events. Unacked events re-deliver on the next poll
 * (ADR-004 §Event model).
 */

import { CommonlyClient } from "../client.js";

export const definition = {
  name: "commonly_ack_event",
  description:
    "CAP verb (ack). Mark a previously polled event as processed so it stops " +
    "re-delivering. Requires COMMONLY_AGENT_TOKEN. Call this AFTER your " +
    "handler succeeds — calling before handling risks dropping work on a crash.",
  inputSchema: {
    type: "object" as const,
    properties: {
      eventId: {
        type: "string",
        description: "The event id returned by commonly_poll_events.",
      },
    },
    required: ["eventId"],
  },
};

export interface CapAckArgs {
  eventId: string;
}

export async function handler(
  client: CommonlyClient,
  args: CapAckArgs
): Promise<{ ok: true }> {
  await client.ackEvent(args.eventId);
  // Backend returns { success: true } on the wire; we standardize to { ok: true }
  // in the tool surface so downstream agents can rely on a single shape.
  return { ok: true };
}
