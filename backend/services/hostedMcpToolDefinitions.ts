/**
 * The `call` half of a hosted-MCP tool: §4's credential, then one JSON-RPC
 * request to the entry's resource.
 *
 * `entryToolProjections` (slice 2) produces everything a tool definition needs
 * EXCEPT the call itself, because the call is the first thing in the flow that
 * needs a decryptable credential. This module is where that gap closes, and it
 * is deliberately the only place a hosted tool's request is built: the
 * projection stays a pure description of the pin.
 *
 * Two shapes matter more than they look.
 *
 * The endpoint is the entry's `resource`. The OAuth audience may be a parent
 * resource identifier; catalogue validation requires that it covers this
 * endpoint's origin and path before we present a bearer token here.
 *
 * The broker's `resolveConnection` never carries a token. This module fetches
 * the row's credential for tools/list drift assessment and for tools/call, so
 * both requests are made under the same member's authority.
 */
import { randomUUID } from 'crypto';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../integrations/hostedMcp/entries';
import { RoomGrantError } from './roomGrantService';
import { hostedVendorFetch } from './hostedVendorFetch';
import {
  createHostedMcpDriftCache,
  entryToolProjections,
  hostedMcpToolName,
  type HostedMcpEntry,
  type HostedMcpDriftCache,
  type HostedMcpDriftOutcome,
  type HostedMcpPinnedTool,
  type HostedMcpUpstreamTool,
} from './hostedMcpEntryService';
import { HostedMcpCredentialError } from './hostedMcpCredentialError';
import type { HostedMcpRow } from './hostedMcpCredentialService';
import type { ToolConnection, ToolDefinition } from './toolBrokerService';

/**
 * A vendor that never answers must not hold a seat's turn open forever. The
 * call is bounded, and a timeout is reported as the vendor being unreachable
 * rather than as a refusal, so the trail does not read as the member's fault.
 */
export const HOSTED_MCP_CALL_TIMEOUT_MS = 30 * 1000;

export interface HostedMcpToolDeps {
  /** The row the connection id names. Absent means the grant outlived its row. */
  loadRow: (connectionId: string) => Promise<HostedMcpRow | null>;
  /** The live credential for a row: a stored token, or a refresh behind §10.3's fence. */
  credentialFor: (row: HostedMcpRow) => Promise<{ token: string }>;
  fetcher: typeof fetch;
  newCallId: () => string;
  driftCache: HostedMcpDriftCache;
}

const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const defaultDeps = (): HostedMcpToolDeps => ({
  // Through the outbound guard: public https only, no redirects (TASK-253).
  fetcher: hostedVendorFetch,
  newCallId: () => `hosted_call_${randomUUID()}`,
  loadRow: async (connectionId) => {
    // A grant's connection id is an ObjectId string by construction, but an
    // untrusted value must not reach a BSON `_id` selector as a CastError.
    if (!/^[a-f\d]{24}$/i.test(connectionId)) return null;
    // This module also provides the pure catalogue projection. Keep mongoose
    // (and the Integration model) out of import-time consumers such as the
    // frontend glyph-catalogue test; only an actual hosted tool call needs it.
    const { default: Integration } = await import('../models/Integration');
    const row = await Integration.findById(connectionId).lean();
    return (row as unknown as HostedMcpRow | null) || null;
  },
  credentialFor: async (row) => {
    // Loaded lazily, and this is the reason: the credential service pulls in the
    // intake flow's discovery and PKCE helpers, while `toolBrokerService` is
    // imported by `routes/grants.ts`, which has to stay loadable without them.
    // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
    const { credentialFor } = require('./hostedMcpCredentialService');
    return credentialFor(row);
  },
  driftCache: productionDriftCache,
});

/**
 * Streamable HTTP may answer a JSON-RPC request with either a JSON body or an
 * SSE stream. Both are accepted, and the reply is whichever frame carries a
 * `result` or an `error`: a frame that is neither is not the answer to this
 * call, so it is not mistaken for one.
 */
const jsonRpcReply = async (response: Response): Promise<Record<string, unknown>> => {
  const contentType = String(response.headers?.get?.('content-type') || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    let body: Record<string, unknown>;
    try {
      body = await response.json() as Record<string, unknown>;
    } catch {
      throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned invalid JSON', 502);
    }
    if (body && (body.result !== undefined || body.error !== undefined)) return body;
    throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned no JSON-RPC reply', 502);
  }
  const text = await response.text();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload) continue;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch {
      // A frame this parser cannot read is not the reply; keep looking.
    }
  }
  throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned no JSON-RPC reply', 502);
};

const listUpstreamTools = async (
  connectionId: string,
  deps: Pick<HostedMcpToolDeps, 'loadRow' | 'credentialFor' | 'fetcher' | 'newCallId'>,
  entries: HostedMcpEntry[],
): Promise<HostedMcpUpstreamTool[]> => {
  const row = await deps.loadRow(connectionId);
  if (!row) throw new RoomGrantError('connection_mismatch', 'hosted-MCP connection row no longer exists', 403);
  const entry = findHostedMcpEntry(entries, String(row.config?.entryId || ''));
  if (!entry) throw new RoomGrantError('connection_mismatch', 'hosted-MCP entry is unavailable', 403);
  const { token } = await deps.credentialFor(row);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOSTED_MCP_CALL_TIMEOUT_MS);
  try {
    const allTools: HostedMcpUpstreamTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      let response: Response;
      try {
        response = await deps.fetcher(entry.resource, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            Authorization: `Bearer ${token}`,
          },
          body: JSON.stringify({
            jsonrpc: '2.0', id: deps.newCallId(), method: 'tools/list', params: cursor ? { cursor } : {},
          }),
          signal: controller.signal,
        });
      } catch (error) {
        throw new RoomGrantError('provider_unreachable', `hosted-MCP vendor unreachable: ${messageOf(error)}`, 502);
      }
      if (response.status === 401 || response.status === 403) {
        throw new RoomGrantError('credential_rejected', 'the vendor rejected this connection’s credential', 403);
      }
      if (!response.ok) {
        throw new RoomGrantError('provider_error', `hosted-MCP vendor answered ${response.status}`, 502);
      }
      const reply = await jsonRpcReply(response);
      if (reply.error) throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned an error', 502);
      const result = reply.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!Array.isArray(result?.tools)) {
        throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned no tools array', 502);
      }
      if (!result.tools.every((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string')) {
        throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned malformed tools', 502);
      }
      allTools.push(...result.tools as HostedMcpUpstreamTool[]);
      if (result.nextCursor === undefined || result.nextCursor === null) return allTools;
      if (typeof result.nextCursor !== 'string' || !result.nextCursor || seenCursors.has(result.nextCursor)) {
        throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned an invalid cursor', 502);
      }
      cursor = result.nextCursor;
      seenCursors.add(cursor);
    }
    throw new RoomGrantError('provider_error', 'hosted-MCP tools/list exceeded the page limit', 502);
  } finally {
    clearTimeout(timer);
  }
};

// The cache survives definition reconstruction on each broker call. A failed
// list is never cached, so it cannot turn a vendor outage into a clean pin.
export const createHostedMcpRuntimeDriftCache = (
  deps: Pick<HostedMcpToolDeps, 'loadRow' | 'credentialFor' | 'fetcher' | 'newCallId'>,
  entries: HostedMcpEntry[] = HOSTED_MCP_ENTRIES,
): HostedMcpDriftCache => createHostedMcpDriftCache({
  listUpstreamTools: ({ connectionId }) => listUpstreamTools(connectionId, deps, entries),
});

const productionDriftCache = createHostedMcpRuntimeDriftCache({
  loadRow: (connectionId) => defaultDeps().loadRow(connectionId),
  credentialFor: (row) => defaultDeps().credentialFor(row),
  fetcher: hostedVendorFetch,
  newCallId: () => `hosted_list_${randomUUID()}`,
});

/** A removed row must not retain an assessment after its credential is gone. */
export const forgetHostedMcpDrift = (connectionId: string): void => {
  productionDriftCache.forget({ connectionId });
};

export const assertHostedToolUnchanged = async (
  entry: HostedMcpEntry,
  tool: HostedMcpPinnedTool,
  connection: ToolConnection,
  cache: HostedMcpDriftCache = productionDriftCache,
): Promise<void> => {
  if (connection.type !== 'hosted-mcp' || connection.entryId !== entry.id) {
    throw new RoomGrantError('connection_mismatch', 'hosted-MCP connection does not match the entry', 403);
  }
  let outcome: HostedMcpDriftOutcome;
  try {
    outcome = await cache.assess({ connectionId: connection.connectionId }, entry);
  } catch (error) {
    if (error instanceof HostedMcpCredentialError) throw error;
    const code = (error as { code?: unknown })?.code;
    if (code === 'reconnect_required' || code === 'connection_mismatch') {
      throw new RoomGrantError(code, messageOf(error), 403);
    }
    throw error;
  }
  if (outcome.state === 'provider_unavailable') {
    // Keep the credential service's code, retryability and broker trail
    // unchanged when tools/list fails before a vendor request can be made.
    if (outcome.cause instanceof HostedMcpCredentialError) throw outcome.cause;
    const reason = outcome.reason || 'provider_error';
    throw new RoomGrantError(reason, 'hosted-MCP tools/list could not be verified', reason === 'credential_rejected' ? 403 : 502);
  }
  const assessed = outcome.tools.find((candidate) => candidate.name === tool.name);
  if (!assessed || assessed.verdict !== 'ok') {
    const code = assessed?.verdict || 'tool_unavailable';
    throw new RoomGrantError(code, `${entry.id}.${tool.name}: ${assessed?.detail || 'tool is unavailable'}`, 403);
  }
};

const callHostedTool = async (
  entry: HostedMcpEntry,
  tool: HostedMcpPinnedTool,
  args: Record<string, unknown>,
  connection: ToolConnection,
  deps: HostedMcpToolDeps,
): Promise<unknown> => {
  if (connection.type !== 'hosted-mcp') {
    throw new RoomGrantError('connection_mismatch', 'a hosted-MCP tool was given a non-hosted connection', 403);
  }
  // The definition was built from an entry and the connection names another:
  // the tool list and the row that pays for it must be the same vendor's.
  if (connection.entryId !== entry.id) {
    throw new RoomGrantError(
      'connection_mismatch',
      `connection is for ${connection.entryId || '(none)'}, not ${entry.id}`,
      403,
    );
  }

  await assertHostedToolUnchanged(entry, tool, connection, deps.driftCache);

  const row = await deps.loadRow(connection.connectionId);
  if (!row) {
    throw new RoomGrantError('connection_mismatch', 'hosted-MCP connection row no longer exists', 403);
  }
  let token: string;
  try {
    ({ token } = await deps.credentialFor(row));
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === 'reconnect_required' || code === 'connection_mismatch') {
      // A client-id drift is an authority refusal, not a failed vendor call.
      // Direct callers reach this read; the broker catches the same credential
      // error earlier in its preflight and classifies it as refused there.
      throw new RoomGrantError(code, (error as Error).message, 403);
    }
    throw error;
  }

  const callId = deps.newCallId();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOSTED_MCP_CALL_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetcher(entry.resource, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: callId,
        method: 'tools/call',
        params: { name: tool.upstreamName, arguments: args },
      }),
      signal: controller.signal,
    });
  } catch (error) {
    throw new RoomGrantError('provider_unreachable', `hosted-MCP vendor unreachable: ${messageOf(error)}`, 502);
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    // The token was live when it was read and refused by the vendor, so the
    // grant behind it is gone: only a new consent restores this connection.
    throw new RoomGrantError(
      'credential_rejected',
      'the vendor rejected this connection\'s credential — reconnect to continue',
      403,
    );
  }
  if (!response.ok) {
    throw new RoomGrantError(
      'provider_error',
      `hosted-MCP vendor answered ${response.status}`,
      502,
    );
  }

  const reply = await jsonRpcReply(response);
  if (reply.error) {
    const vendorError = reply.error as { message?: unknown; code?: unknown };
    const detail = String(vendorError?.message || vendorError?.code || 'unknown error');
    throw new RoomGrantError('provider_error', `hosted-MCP vendor refused the call: ${detail}`, 502);
  }
  // MCP reports a tool that ran and failed as a result with `isError`, which is
  // the model's to read: throwing here would hide the vendor's own explanation
  // from the turn that asked for it.
  return reply.result;
};

/**
 * Every hosted tool a catalogue offers, as broker definitions.
 *
 * The projection is taken from `entryToolProjections` rather than rebuilt here,
 * so the tool an agent is offered and the tool the broker runs cannot drift:
 * one is a field of the other. The two are joined by NAME and a mismatch throws,
 * because an index-based join would silently pair a projection with the wrong
 * pin the first time that function stops mapping one-to-one.
 */
export const hostedToolDefinitions = (
  entries: HostedMcpEntry[] = HOSTED_MCP_ENTRIES,
  overrides: Partial<HostedMcpToolDeps> = {},
): ToolDefinition[] => {
  const deps: HostedMcpToolDeps = { ...defaultDeps(), ...overrides };
  return entries.flatMap((entry) => entryToolProjections(entry).map((projection) => {
    const tool = entry.tools.find(
      (candidate) => hostedMcpToolName(entry, candidate) === projection.name,
    );
    if (!tool) {
      throw new RoomGrantError(
        'broker_unavailable',
        `hosted-mcp entry ${entry.id} projected ${projection.name} with no matching pin`,
        503,
      );
    }
    return {
      ...projection,
      assess: (connection: ToolConnection) => assertHostedToolUnchanged(entry, tool, connection, deps.driftCache),
      call: (args: Record<string, unknown>, connection: ToolConnection) => (
        callHostedTool(entry, tool, args, connection, deps)
      ),
    };
  }));
};

/** The hosted definition for a namespaced tool name, or undefined if none offers it. */
export const findHostedToolDefinition = (
  name: string,
  entries: HostedMcpEntry[] = HOSTED_MCP_ENTRIES,
  overrides: Partial<HostedMcpToolDeps> = {},
): ToolDefinition | undefined => (
  hostedToolDefinitions(entries, overrides).find((definition) => definition.name === name)
);

/** The entry a connection names, or undefined when the catalogue no longer offers it. */
export const entryForConnection = (
  connection: Pick<ToolConnection, 'type'> & { entryId?: unknown },
  entries: HostedMcpEntry[] = HOSTED_MCP_ENTRIES,
): HostedMcpEntry | undefined => (
  connection.type === 'hosted-mcp'
    ? findHostedMcpEntry(entries, String(connection.entryId || ''))
    : undefined
);
