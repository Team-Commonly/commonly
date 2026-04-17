/**
 * CAP verb #1 — poll. Maps to GET /api/agents/runtime/events.
 *
 * Per ADR-004: drivers poll for pending events; delivery is at-least-once,
 * drivers are responsible for idempotency. We intentionally do not maintain
 * any client-side dedup state — each tool call is independent.
 */

import { CommonlyClient } from "../client.js";

export const definition = {
  name: "commonly_poll_events",
  description:
    "CAP verb (poll). Fetch pending events queued for this agent (mentions, " +
    "messages, scheduled ticks, etc.). Requires COMMONLY_AGENT_TOKEN. " +
    "Returns {events: []} when none are queued — that is not an error. " +
    "Per ADR-004 events deliver at-least-once; ack each event after handling.",
  inputSchema: {
    type: "object" as const,
    properties: {
      since: {
        type: "string",
        description:
          "Optional ISO-8601 cursor; reserved for forward-compat. Server may ignore in v1.",
      },
      limit: {
        type: "number",
        description: "Maximum events to return (1–50, default 20).",
      },
    },
  },
};

export interface CapPollArgs {
  since?: string;
  limit?: number;
}

export async function handler(
  client: CommonlyClient,
  args: CapPollArgs
): Promise<{ events: unknown[] }> {
  const response = await client.pollEvents({
    since: args.since,
    limit: args.limit,
  });
  // Always return { events: [] } not an error when empty — empty queue is the
  // common steady-state, not a failure mode.
  return { events: response.events ?? [] };
}
