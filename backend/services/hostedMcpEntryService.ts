/**
 * The server-owned half of a hosted-MCP tool (TASK-172,
 * `docs/plans/hosted-mcp-connection-scope.md` §3).
 *
 * A catalogue entry is the only source for everything an agent sees and
 * everything a grant is checked against. The vendor's `tools/list` may take a
 * tool away or change what it accepts; it may not add, rename or reword one,
 * and it may not supply the text a seat reads. Entries live in this repo and
 * change only by PR.
 *
 * What this module owns, and what it deliberately does not:
 * - It projects an entry's pins into the entry-owned half of a
 *   `ToolDefinition` — name, description, write mode, `irreversible`, the
 *   pinned `inputSchema`. It does NOT attach `call`: forwarding to the
 *   vendor's `tools/call` needs the row's decrypted credential, which is §4's
 *   intake (build order step 3). `ToolConnection` is still GitHub-shaped, so
 *   attaching `call` here would mean casting a connection type that does not
 *   exist yet.
 * - It assesses each pinned tool against one upstream list. The list is taken
 *   with the row's own credential, because the spec says the list "MAY vary by
 *   the authorization presented on the request" — a list taken with any other
 *   credential proves nothing about this row.
 * - It caches that comparison per row behind a TTL, so the vendor is polled on
 *   a schedule rather than on every `tools/list` or `tools/call`.
 *
 * Drift is a named refusal, never a silent change: a pinned tool that is gone
 * upstream is `tool_unavailable`, and one whose schema or annotations moved is
 * `tool_drift` until a PR re-pins it.
 */
import type { HostedToolDefinition } from './toolBrokerService';
import type { RoomGrantWriteMode } from '../models/RoomGrant';

/** Read reaches the vendor's APIs; write is offered only where §5's four conditions hold. */
export type HostedMcpToolClass = 'read' | 'write';

/**
 * The vendor's annotations as seen when the tool was pinned. The MCP spec says
 * clients MUST treat annotations as untrusted unless they come from a trusted
 * server, and a vendor's server is not one we run, so these grant nothing: they
 * exist only to detect a vendor moving toward write since the pin.
 */
export interface HostedMcpAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

export interface HostedMcpPinnedTool {
  /** The name an agent sees, before the entry namespaces it. */
  name: string;
  /** The name the vendor's server knows. */
  upstreamName: string;
  /** The description an agent reads — ours, never the vendor's. */
  description: string;
  class: HostedMcpToolClass;
  /** Parks a call even on a `write` grant, by the same rule GitHub's tools use. */
  irreversible?: boolean;
  /** The schema the owner approves args under, pinned. */
  inputSchema: Record<string, unknown>;
  annotations?: HostedMcpAnnotations;
}

export interface HostedMcpEntry {
  /** Namespaces every tool name (`<id>.<tool>`) and names the row's app. */
  id: string;
  title: string;
  /** The MCP server URL, which is also the RFC 8707 `resource`. */
  resource: string;
  /** The authorization server the protected-resource metadata names. */
  issuer: string;
  client: 'pre-registered' | 'cimd' | 'dcr';
  scopes: string[];
  revoke: string;
  tools: HostedMcpPinnedTool[];
}

/** One tool as the vendor's `tools/list` reports it. */
export interface HostedMcpUpstreamTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: HostedMcpAnnotations;
}

/**
 * The entry-owned half of a `ToolDefinition`. `call` is absent by construction:
 * it belongs to the intake slice, which is the first slice that has a row whose
 * credential it can decrypt.
 */
export type HostedMcpToolProjection = Omit<HostedToolDefinition, 'call'>;

export type HostedMcpToolVerdict = 'ok' | 'tool_unavailable' | 'tool_drift';

export interface HostedMcpToolAssessment {
  /** The entry-local name, so a refusal can be read against the pin. */
  name: string;
  /** The name an agent would see, so a trail row names the tool it refused. */
  namespacedName: string;
  verdict: HostedMcpToolVerdict;
  /** Present on a refusal: which comparison failed, and how. */
  detail?: string;
}

/** Namespace an entry's tool so two entries, or an entry and GitHub, cannot collide. */
export const hostedMcpToolName = (entry: HostedMcpEntry, tool: HostedMcpPinnedTool): string =>
  `${entry.id}.${tool.name}`;

/**
 * A write parks unless the grant says `write` — and a hosted-mcp Connection
 * cannot hold a `write` grant, because the mint refuses one (§5). So the class
 * maps to `write-with-confirm` and the park is the same single function every
 * other tool's park is (`toolBrokerService.callTool`).
 */
const writeModeFor = (tool: HostedMcpPinnedTool): RoomGrantWriteMode =>
  (tool.class === 'write' ? 'write-with-confirm' : 'read');

/**
 * Key order is not schema, and a vendor is free to reorder its JSON, so the
 * comparison is over a canonical spelling rather than over `JSON.stringify` of
 * whatever order arrived. Array order IS schema and is preserved.
 */
export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const body = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
};

/**
 * Did the vendor's annotations move toward write since the pin? Only the two
 * directions §3 names count. The reverse — a tool gaining `readOnlyHint` or
 * losing `destructiveHint` — tightens the vendor's own claim and is not drift.
 */
const movedTowardWrite = (
  pinned: HostedMcpAnnotations,
  live: HostedMcpAnnotations | undefined,
): string | null => {
  if (pinned.readOnlyHint === true && live?.readOnlyHint !== true) return 'readOnlyHint withdrawn upstream';
  if (pinned.destructiveHint !== true && live?.destructiveHint === true) return 'destructiveHint set upstream';
  return null;
};

export const entryToolProjections = (entry: HostedMcpEntry): HostedMcpToolProjection[] =>
  entry.tools.map((tool) => ({
    name: hostedMcpToolName(entry, tool),
    description: tool.description,
    requiredWriteMode: writeModeFor(tool),
    connectionType: 'hosted-mcp',
    entryId: entry.id,
    irreversible: tool.irreversible,
    inputSchema: tool.inputSchema,
  }));

/**
 * Assess every PINNED tool against one upstream list. Upstream tools that are
 * not in the entry are not assessed at all and are never offered: the offered
 * set is the entry's pins, so a vendor adding a tool cannot widen what a seat
 * sees. That is not an error, and this function has no output for it.
 *
 * A duplicate upstream name is resolved first-wins, deterministically. The
 * spec says names are unique within a server, so the shape is not modelled.
 */
export const assessEntryTools = (
  entry: HostedMcpEntry,
  upstream: HostedMcpUpstreamTool[],
): HostedMcpToolAssessment[] => {
  const byUpstreamName = new Map<string, HostedMcpUpstreamTool>();
  for (const tool of upstream) {
    const name = String(tool.name);
    if (!byUpstreamName.has(name)) byUpstreamName.set(name, tool);
  }

  return entry.tools.map((tool) => {
    const namespacedName = hostedMcpToolName(entry, tool);
    const live = byUpstreamName.get(tool.upstreamName);
    if (!live) {
      return {
        name: tool.name,
        namespacedName,
        verdict: 'tool_unavailable' as const,
        detail: `upstream no longer lists ${tool.upstreamName}`,
      };
    }
    if (canonicalJson(live.inputSchema ?? null) !== canonicalJson(tool.inputSchema)) {
      return {
        name: tool.name,
        namespacedName,
        verdict: 'tool_drift' as const,
        detail: `upstream inputSchema for ${tool.upstreamName} differs from the pin`,
      };
    }
    const moved = movedTowardWrite(tool.annotations ?? {}, live.annotations);
    if (moved) {
      return {
        name: tool.name,
        namespacedName,
        verdict: 'tool_drift' as const,
        detail: moved,
      };
    }
    return { name: tool.name, namespacedName, verdict: 'ok' as const };
  });
};

/**
 * Five minutes: long enough that a seat listing tools does not poll the vendor
 * per request, short enough that a vendor's withdrawal is honoured in the same
 * working session. Injectable, because the intake slice measures the real
 * value against the vendor rather than inheriting this default.
 */
export const HOSTED_MCP_DRIFT_TTL_MS = 5 * 60 * 1000;

export interface HostedMcpDriftRow {
  /**
   * The Integration row's `_id`; on a hosted grant this is also installationId.
   * It is the whole key: a row belongs to exactly one entry (the partial unique
   * index holds that), so two entries cannot present the same credential.
   */
  connectionId: string;
}

export type HostedMcpDriftOutcome =
  | { state: 'assessed'; entryId: string; at: number; cached: boolean; tools: HostedMcpToolAssessment[] }
  | { state: 'provider_unavailable'; entryId: string; detail: string };

export interface HostedMcpDriftCacheOptions {
  /**
   * Takes the list with THIS row's credential. Throwing means the vendor could
   * not be reached; the caller must not read that as a clean comparison.
   */
  listUpstreamTools: (row: HostedMcpDriftRow) => Promise<HostedMcpUpstreamTool[]>;
  ttlMs?: number;
  now?: () => number;
}

export interface HostedMcpDriftCache {
  assess: (row: HostedMcpDriftRow, entry: HostedMcpEntry) => Promise<HostedMcpDriftOutcome>;
  /** Exposed so a removal path can drop one row's entry rather than the whole cache. */
  forget: (row: HostedMcpDriftRow) => void;
}

/**
 * A per-row cache of the drift comparison. The key carries the row, not just
 * the entry: two members of one workspace present different credentials, so a
 * list fetched for one proves nothing about the other.
 *
 * A vendor outage is NOT cached. §9 maps it to `provider_unavailable` and
 * leaves the row alone, so a failed fetch must stay a failed fetch rather than
 * becoming a five-minute window in which every tool reads as unchanged.
 */
export const createHostedMcpDriftCache = (options: HostedMcpDriftCacheOptions): HostedMcpDriftCache => {
  const ttlMs = options.ttlMs === undefined ? HOSTED_MCP_DRIFT_TTL_MS : options.ttlMs;
  const now = options.now || Date.now;
  const entries = new Map<string, { at: number; tools: HostedMcpToolAssessment[] }>();

  const keyFor = (row: HostedMcpDriftRow) => row.connectionId;

  return {
    forget: (row) => {
      entries.delete(keyFor(row));
    },
    assess: async (row, entry) => {
      const key = keyFor(row);
      const cached = entries.get(key);
      const at = now();
      if (cached && at - cached.at < ttlMs) {
        return { state: 'assessed', entryId: entry.id, at: cached.at, cached: true, tools: cached.tools };
      }
      let upstream: HostedMcpUpstreamTool[];
      try {
        upstream = await options.listUpstreamTools(row);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return { state: 'provider_unavailable', entryId: entry.id, detail };
      }
      const tools = assessEntryTools(entry, upstream);
      entries.set(key, { at, tools });
      return { state: 'assessed', entryId: entry.id, at, cached: false, tools };
    },
  };
};
