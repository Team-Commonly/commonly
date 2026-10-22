/**
 * The `call` half of a hosted-MCP tool: §4's credential, then a short-lived
 * Streamable HTTP session with the entry's resource.
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
  fetcher: (input, init) => fetch(input, init),
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
      throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned invalid JSON', 502,
        { failure: 'invalid_json', vendorStatus: response.status });
    }
    if (body && (body.result !== undefined || body.error !== undefined)) return body;
    throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned no JSON-RPC reply', 502,
      { failure: 'missing_rpc_reply', vendorStatus: response.status });
  }
  const reader = response.body?.getReader();
  if (!reader) throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned no JSON-RPC reply', 502,
    { failure: 'missing_rpc_reply', vendorStatus: response.status });
  const decoder = new TextDecoder();
  let pending = '';
  let bytes = 0;
  const readLine = (line: string): Record<string, unknown> | undefined => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return undefined;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload) return undefined;
    try {
      const parsed = JSON.parse(payload) as Record<string, unknown>;
      if (parsed && (parsed.result !== undefined || parsed.error !== undefined)) return parsed;
    } catch {
      // A frame this parser cannot read is not the reply; keep looking.
    }
    return undefined;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const last = readLine(pending + decoder.decode());
        if (last) return last;
        break;
      }
      bytes += value.byteLength;
      if (bytes > 4 * 1024 * 1024) {
        throw new RoomGrantError('provider_error', 'hosted-MCP vendor reply exceeded 4 MiB', 502,
          { failure: 'reply_too_large', vendorStatus: response.status });
      }
      pending += decoder.decode(value, { stream: true });
      let newline = pending.indexOf('\n');
      while (newline !== -1) {
        const reply = readLine(pending.slice(0, newline));
        if (reply) return reply;
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    }
  } finally {
    void reader.cancel().catch(() => {});
  }
  throw new RoomGrantError('provider_error', 'hosted-MCP vendor returned no JSON-RPC reply', 502,
    { failure: 'missing_rpc_reply', vendorStatus: response.status });
};

const MCP_PROTOCOL_VERSION = '2025-11-25';
const MCP_HANDSHAKE_VERSIONS = new Set(['2025-03-26', '2025-06-18', MCP_PROTOCOL_VERSION]);

const sanitizeVendorError = (value: string, token: string): string | undefined => value
  .split(/[\r\n]/, 1)[0]
  .split(token).join('[redacted]')
  .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/(["']?)(access_token|refresh_token|client_secret|api_key)\1\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
    '$2=[redacted]')
  .replace(/\b[A-Za-z0-9_-]{24,}\b/g, '[redacted]')
  .slice(0, 200) || undefined;

const vendorErrorLine = async (response: Response, token: string): Promise<string | undefined> => {
  try {
    const body = await response.text();
    // Never turn a truncated or malformed structured response into a plain-text
    // diagnostic: it may contain unrelated private fields before the error.
    if (body.length > 4096) return undefined;
    const isStructured = response.headers.get('content-type')?.toLowerCase().includes('json')
      || /^[\s]*[\[{]/.test(body);
    let line: string | undefined;
    if (isStructured) {
      let parsed: { error?: { code?: unknown; message?: unknown } };
      try { parsed = JSON.parse(body); } catch { return undefined; }
      if (typeof parsed?.error?.message === 'string') {
        line = `JSON-RPC ${String(parsed.error.code ?? 'error')}: ${parsed.error.message}`;
      }
    } else {
      line = body;
    }
    return line ? sanitizeVendorError(line, token) : undefined;
  } catch { return undefined; }
};

/** One short-lived Streamable HTTP session, under one member's credential. */
const openHostedMcpSession = async (
  resource: string,
  token: string,
  fetcher: typeof fetch,
  newCallId: () => string,
  signal: AbortSignal,
) => {
  let sessionId: string | null = null;
  let version = MCP_PROTOCOL_VERSION;
  const send = async (body: Record<string, unknown>, initialized = false): Promise<Response> => {
    let response: Response;
    try {
      response = await fetcher(resource, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: `Bearer ${token}`,
          ...(initialized ? { 'MCP-Protocol-Version': version } : {}),
          ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      throw new RoomGrantError('provider_unreachable', `hosted-MCP vendor unreachable: ${messageOf(error)}`, 502);
    }
    if (response.status === 401 || response.status === 403) {
      throw new RoomGrantError(
        'credential_rejected', 'the vendor rejected this connection’s credential — reconnect to continue', 403,
      );
    }
    if (!response.ok) {
      const vendorError = await vendorErrorLine(response, token);
      throw new RoomGrantError('provider_error', `hosted-MCP vendor answered ${response.status}`, 502,
        { vendorStatus: response.status, vendorError });
    }
    return response;
  };

  const initializeSession = async () => {
    const initialized = await send({
      jsonrpc: '2.0', id: newCallId(), method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'commonly-hosted-mcp', version: '1.0.0' },
      },
    });
    sessionId = initialized.headers.get('mcp-session-id');
    const reply = await jsonRpcReply(initialized);
    const result = reply.result as { protocolVersion?: unknown } | undefined;
    if (reply.error || typeof result?.protocolVersion !== 'string'
      || !MCP_HANDSHAKE_VERSIONS.has(result.protocolVersion)) {
      throw new RoomGrantError('provider_error', 'hosted-MCP vendor did not negotiate a supported protocol', 502,
        { failure: 'unsupported_protocol', vendorStatus: initialized.status,
          rpcCode: (reply.error as { code?: unknown } | undefined)?.code });
    }
    version = result.protocolVersion;
    const notification = await send({ jsonrpc: '2.0', method: 'notifications/initialized' }, true);
    if (notification.status !== 202) {
      throw new RoomGrantError('provider_error', 'hosted-MCP vendor did not accept initialization', 502,
        { vendorStatus: notification.status });
    }
  };
  const initializeWithRenewal = async () => {
    try {
      await initializeSession();
    } catch (error) {
      if (!(error instanceof RoomGrantError) || error.details?.vendorStatus !== 404 || !sessionId) throw error;
      // A server can expire its new session before the initialized
      // notification. That notification carried the ID, so it earns the same
      // one-time renewal as a session-bound tools request.
      sessionId = null;
      await initializeSession();
    }
  };
  const close = async () => {
    if (!sessionId) return;
    const closingSessionId = sessionId;
    sessionId = null;
    try {
      await fetcher(resource, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${token}`,
          'MCP-Protocol-Version': version,
          'Mcp-Session-Id': closingSessionId,
        },
        signal,
      });
    } catch {
      // Session expiry and unsupported DELETE do not change the tool result.
    }
  };
  try {
    await initializeWithRenewal();
  } catch (error) {
    await close();
    throw error;
  }
  return {
    post: async (body: Record<string, unknown>) => {
      try {
        return await send(body, true);
      } catch (error) {
        if (!(error instanceof RoomGrantError) || error.details?.vendorStatus !== 404 || !sessionId) throw error;
        // A stateful server can expire a session between initialization and a
        // request. The spec requires a new initialize without the stale ID.
        sessionId = null;
        try {
          await initializeSession();
        } catch (initializationError) {
          await close();
          throw initializationError;
        }
        return send(body, true);
      }
    },
    close,
  };
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
  let session: Awaited<ReturnType<typeof openHostedMcpSession>> | undefined;
  try {
    session = await openHostedMcpSession(entry.resource, token, deps.fetcher, deps.newCallId, controller.signal);
    const allTools: HostedMcpUpstreamTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await session.post({
        jsonrpc: '2.0', id: deps.newCallId(), method: 'tools/list', params: cursor ? { cursor } : {},
      });
      const reply = await jsonRpcReply(response);
      if (reply.error) {
        const vendorError = reply.error as { code?: unknown; message?: unknown };
        const rpcLine = `JSON-RPC ${String(vendorError.code ?? 'error')}: ${String(vendorError.message ?? '')}`;
        throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned an error', 502,
          { vendorStatus: response.status, rpcCode: vendorError.code,
            vendorError: sanitizeVendorError(rpcLine, token) });
      }
      const result = reply.result as { tools?: unknown; nextCursor?: unknown } | undefined;
      if (!Array.isArray(result?.tools)) {
        throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned no tools array', 502,
          { failure: 'missing_tools' });
      }
      if (!result.tools.every((tool) => tool && typeof tool === 'object' && typeof tool.name === 'string')) {
        throw new RoomGrantError('provider_error', 'hosted-MCP tools/list returned malformed tools', 502,
          { failure: 'malformed_tools' });
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
    await session?.close();
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
  fetcher: (input, init) => fetch(input, init),
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
    const cause = outcome.cause instanceof RoomGrantError ? outcome.cause : undefined;
    const vendorStatus = cause?.details?.vendorStatus;
    const rpcCode = cause?.details?.rpcCode;
    const failure = cause?.details?.failure;
    const vendorError = cause?.details?.vendorError;
    console.warn(JSON.stringify({
      event: 'hosted_mcp_tools_list_failure', entryId: entry.id,
      connectionId: connection.connectionId, reason,
      ...(typeof vendorStatus === 'number' ? { vendorStatus } : {}),
      ...(typeof rpcCode === 'number' ? { rpcCode } : {}),
      ...(typeof failure === 'string' ? { failure } : {}),
    }));
    throw new RoomGrantError(
      reason, 'hosted-MCP tools/list could not be verified', reason === 'credential_rejected' ? 403 : 502,
      { ...(typeof vendorStatus === 'number' ? { vendorStatus } : {}),
        ...(typeof rpcCode === 'number' ? { rpcCode } : {}),
        ...(typeof vendorError === 'string' ? { vendorError } : {}) },
    );
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
  let session: Awaited<ReturnType<typeof openHostedMcpSession>> | undefined;
  let response: Response;
  try {
    session = await openHostedMcpSession(entry.resource, token, deps.fetcher, deps.newCallId, controller.signal);
    response = await session.post({
      jsonrpc: '2.0',
      id: callId,
      method: 'tools/call',
      params: { name: tool.upstreamName, arguments: args },
    });
    const reply = await jsonRpcReply(response);
    if (reply.error) {
      const vendorError = reply.error as { message?: unknown; code?: unknown };
      const detail = String(vendorError?.message || vendorError?.code || 'unknown error');
      throw new RoomGrantError('provider_error', `hosted-MCP vendor refused the call: ${sanitizeVendorError(detail, token)}`, 502,
        { vendorStatus: response.status, rpcCode: vendorError?.code,
          vendorError: sanitizeVendorError(`JSON-RPC ${String(vendorError?.code ?? 'error')}: ${detail}`, token) });
    }
    return reply.result;
  } finally {
    await session?.close();
    clearTimeout(timer);
  }
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
