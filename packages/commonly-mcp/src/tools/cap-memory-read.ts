/**
 * CAP verb #4a — memory read. Maps to GET /api/agents/runtime/memory.
 *
 * The read complement to commonly_memory_sync. Returns this agent identity's
 * kernel memory envelope (sections + the v1 `content` mirror).
 *
 * Why this exists: the envelope is keyed by agent identity, so every tool
 * authenticated with the SAME COMMONLY_AGENT_TOKEN reads the SAME envelope.
 * That is how "one project memory shared by all your AI tools" works in
 * practice — point Claude Code, Cursor, and Codex at one identity, then
 * tool A writes via commonly_memory_sync and tool B recalls it here. Before
 * this tool the MCP surface could WRITE the envelope but had no way to READ
 * it back (commonly_read / commonly_context are pod-asset operations, not the
 * agent envelope), which silently broke read-after-write across tools.
 */

import { CommonlyClient, type CAPMemoryResponse } from "../client.js";

export const definition = {
  name: "commonly_memory_read",
  description:
    "CAP verb (memory). Read this agent's kernel memory envelope (ADR-003) — " +
    "the read complement to commonly_memory_sync. Requires COMMONLY_AGENT_TOKEN. " +
    "Returns all sections (soul, long_term, daily, relationships, dedup_state, " +
    "shared, runtime_meta) plus the v1 `content` field. Memory is keyed by agent " +
    "identity, so any tool using the same token reads the same envelope — use " +
    "this to recall what you (or another tool sharing this identity) saved. Pass " +
    "`section` to return just one section instead of the whole envelope.",
  inputSchema: {
    type: "object" as const,
    properties: {
      section: {
        type: "string",
        description:
          "Optional. Return only this section (e.g. 'long_term'). Omit to read the full envelope.",
      },
    },
  },
};

export interface CapMemoryReadArgs {
  section?: string;
}

export interface CapMemoryReadResult extends CAPMemoryResponse {
  // Populated only when a specific `section` was requested. `null` distinguishes
  // "you asked for a section that isn't set" from "you didn't ask for one".
  section?: unknown;
}

export async function handler(
  client: CommonlyClient,
  args: CapMemoryReadArgs = {}
): Promise<CapMemoryReadResult> {
  const env = await client.readMemory();
  const result: CapMemoryReadResult = {
    content: env.content,
    sections: env.sections,
    sourceRuntime: env.sourceRuntime,
    schemaVersion: env.schemaVersion,
  };
  if (args.section) {
    const key = String(args.section);
    const sections = (env.sections ?? {}) as Record<string, unknown>;
    result.section = key in sections ? sections[key] : null;
  }
  return result;
}
