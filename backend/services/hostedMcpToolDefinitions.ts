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
 * The endpoint is the entry's `resource` — the same URL RFC 8707 puts in the
 * `resource` parameter at authorization, so the audience the vendor validated
 * the token for is the audience the token is presented to.
 *
 * The credential is fetched INSIDE the call, never by the broker's
 * `resolveConnection`: a seat listing its tools must not trigger a refresh, and
 * a call that never happens must not spend one. That is also why the connection
 * this module receives carries the row's ID rather than a token.
 */
import { randomUUID } from 'crypto';
import Integration from '../models/Integration';
import { HOSTED_MCP_ENTRIES, findHostedMcpEntry } from '../integrations/hostedMcp/entries';
import { RoomGrantError } from './roomGrantService';
import {
  entryToolProjections,
  hostedMcpToolName,
  type HostedMcpEntry,
  type HostedMcpPinnedTool,
} from './hostedMcpEntryService';
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
}

const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

const defaultDeps = (): HostedMcpToolDeps => ({
  fetcher: (input, init) => fetch(input, init),
  newCallId: () => `hosted_call_${randomUUID()}`,
  loadRow: async (connectionId) => {
    // A grant's connection id is an ObjectId string by construction, but an
    // untrusted value must not reach a BSON `_id` selector as a CastError.
    if (!/^[a-f\d]{24}$/i.test(connectionId)) return null;
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
    const body = await response.json() as Record<string, unknown>;
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

  const row = await deps.loadRow(connection.connectionId);
  if (!row) {
    throw new RoomGrantError('connection_mismatch', 'hosted-MCP connection row no longer exists', 403);
  }
  const { token } = await deps.credentialFor(row);

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
