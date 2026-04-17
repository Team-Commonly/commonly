/**
 * CAP verb #4 — memory sync. Maps to POST /api/agents/runtime/memory/sync.
 *
 * Per ADR-003 Phase 2: drivers promote local memory state into the kernel
 * envelope. Server is idempotent within a UTC-day bucket on
 * (sourceRuntime, canonical-stringify(sections+mode)) — repeated identical
 * payloads return { deduped: true } without writing. We pass that flag
 * through unchanged so the calling agent can tell "already synced today" from
 * "newly written."
 *
 * Mode semantics (from the server):
 *   - "full":  replaces sections wholesale. Anything not in payload is cleared.
 *   - "patch": merges. Object sections $set per-key, array sections merge by
 *              `date` / `otherInstanceId`.
 */

import { CommonlyClient } from "../client.js";

export const definition = {
  name: "commonly_memory_sync",
  description:
    "CAP verb (memory). Promote sections of agent memory into the kernel " +
    "envelope (ADR-003). Requires COMMONLY_AGENT_TOKEN. Use mode='full' for " +
    "a complete snapshot, mode='patch' for incremental updates. Server " +
    "deduplicates identical payloads within a UTC day; check `deduped` in the " +
    "response to distinguish a no-op from a write.",
  inputSchema: {
    type: "object" as const,
    properties: {
      sections: {
        type: "object",
        description:
          "Memory sections envelope (soul, long_term, daily, relationships, dedup_state, shared, runtime_meta).",
      },
      mode: {
        type: "string",
        enum: ["full", "patch"],
        description: "'full' replaces all sections; 'patch' merges with existing.",
      },
      sourceRuntime: {
        type: "string",
        description:
          "Optional driver self-id (e.g. 'mcp-client', 'claude-desktop'). Opaque tag.",
      },
    },
    required: ["sections", "mode"],
  },
};

export interface CapMemorySyncArgs {
  sections: Record<string, unknown>;
  mode: "full" | "patch";
  sourceRuntime?: string;
}

export interface CapMemorySyncResult {
  updated: boolean;
  byteSize?: number;
  deduped?: boolean;
  schemaVersion?: number;
}

export async function handler(
  client: CommonlyClient,
  args: CapMemorySyncArgs
): Promise<CapMemorySyncResult> {
  if (args.mode !== "full" && args.mode !== "patch") {
    throw new Error("commonly_memory_sync: mode must be 'full' or 'patch'");
  }
  if (!args.sections || typeof args.sections !== "object") {
    throw new Error("commonly_memory_sync: sections must be an object");
  }
  const response = await client.syncMemory({
    sections: args.sections,
    mode: args.mode,
    sourceRuntime: args.sourceRuntime,
  });
  // `updated` reflects whether a write actually happened. Deduped requests
  // are a no-op on the server; surface that explicitly so callers don't
  // rely on side effects that didn't occur.
  return {
    updated: !response.deduped,
    deduped: response.deduped === true ? true : undefined,
    byteSize: typeof response.byteSize === "number" ? response.byteSize : undefined,
    schemaVersion:
      typeof response.schemaVersion === "number" ? response.schemaVersion : undefined,
  };
}
