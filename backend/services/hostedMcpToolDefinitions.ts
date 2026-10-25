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

/**
 * The most of one vendor reply the backend will read (TASK-254). Past it the
 * call fails rather than buffering whatever the vendor sends: the reply is held
 * in memory whole before it is parsed. Airtable's real tools/list page is the
 * largest we have seen at 608 KB (fixtures/hostedMcp, 2026-10-09), so 4 MiB
 * leaves room for growth without letting one call fill the process.
 */
export const HOSTED_MCP_MAX_REPLY_BYTES = 4 * 1024 * 1024;

/**
 * The most of one tool result a turn sees, in characters, matching what native
 * web fetch passes on (MAX_FETCHED_TEXT_CHARS). A result over it is cut, and
 * the model is told so in the result itself, so it can ask a narrower question
 * instead of reasoning from a fragment it believes is whole.
 */
export const HOSTED_MCP_MAX_RESULT_CHARS = 24_000;

export interface HostedMcpToolDeps {
  /** The row the connection id names. Absent means the grant outlived its row. */
  loadRow: (connectionId: string) => Promise<HostedMcpRow | null>;
  /** The live credential for a row: a stored token, or a refresh behind §10.3's fence. */
  credentialFor: (row: HostedMcpRow) => Promise<{ token: string }>;
  fetcher: typeof fetch;
  driftCache: HostedMcpDriftCache;
}

const messageOf = (error: unknown): string => (
  error instanceof Error ? error.message : String(error)
);

// Through the outbound guard: public https only, no redirects (TASK-253).
// Loaded lazily, like the model and the credential service below: the frontend
// glyph-catalogue test imports this module for its pure projection, and must
// not pull the guard's node:dns and node:http transport in with it.
const guardedFetch: typeof fetch = (input, init) => {
  // eslint-disable-next-line global-require, @typescript-eslint/no-require-imports
  const { hostedVendorFetch } = require('./hostedVendorFetch');
  return hostedVendorFetch(input, init);
};

const defaultDeps = (): HostedMcpToolDeps => ({
  fetcher: guardedFetch,
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

const replyTooLarge = (vendorStatus: number): RoomGrantError => new RoomGrantError(
  'provider_error',
  `hosted-MCP vendor reply is larger than ${HOSTED_MCP_MAX_REPLY_BYTES} bytes`,
  502,
  { failure: 'reply_too_large', vendorStatus },
);

/** The reply body as text, read no further than HOSTED_MCP_MAX_REPLY_BYTES. */
const readCappedText = async (response: Response): Promise<string> => {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > HOSTED_MCP_MAX_REPLY_BYTES) throw replyTooLarge(response.status);
    return text;
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > HOSTED_MCP_MAX_REPLY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw replyTooLarge(response.status);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
};

/**
 * A tool result cut to HOSTED_MCP_MAX_RESULT_CHARS of text, with the cut said
 * in the result. Text items are kept in order up to the budget; anything that
 * is not text (an image's base64, a structuredContent copy of the same data)
 * is dropped once the result is over it, since it would only be serialised
 * into the turn as more characters.
 */
export const capHostedToolResult = (result: unknown): unknown => {
  const serialised = JSON.stringify(result ?? null);
  if (serialised.length <= HOSTED_MCP_MAX_RESULT_CHARS) return result;
  const source = (result && typeof result === 'object') ? result as Record<string, unknown> : {};
  const items = Array.isArray(source.content) ? source.content as Array<Record<string, unknown>> : [];
  const kept: Array<Record<string, unknown>> = [];
  let budget = HOSTED_MCP_MAX_RESULT_CHARS;
  for (const item of items) {
    if (budget <= 0) break;
    if (item?.type !== 'text' || typeof item.text !== 'string') continue;
    const text = item.text.length > budget ? item.text.slice(0, budget) : item.text;
    kept.push({ type: 'text', text });
    budget -= text.length;
  }
  kept.push({
    type: 'text',
    text: `[Commonly: this result was ${serialised.length} characters and was cut to the first `
      + `${HOSTED_MCP_MAX_RESULT_CHARS}. Ask for less, for example with a filter or a smaller limit, `
      + 'to see the rest.]',
  });
  return {
    content: kept,
    ...(source.isError === true ? { isError: true } : {}),
    truncated: true,
  };
};

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
    const body = await readCappedText(response);
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

/**
 * SDK owns envelopes, request IDs, negotiation and JSON/SSE decoding. Commonly
 * owns outbound policy, byte/deadline limits, diagnostic redaction and the one
 * session-bound 404 renewal. No OAuth provider is supplied to the SDK: refresh
 * authority stays in credentialFor, and a vendor 401 never starts discovery.
 */
const openHostedMcpSession = async (
  resource: string,
  token: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
) => {
  // Lazy for the frontend's pure catalogue projection, which must not bundle
  // the Node SDK and its transport dependencies.
  // SDK package exports require .js subpaths; the legacy ESLint resolver cannot resolve them.
  /* eslint-disable global-require, @typescript-eslint/no-require-imports, import/extensions, import/no-unresolved */
  const { Client } = require('@modelcontextprotocol/sdk/client/index.js') as
    typeof import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js') as
    typeof import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const { ResultSchema, McpError, ProgressNotificationSchema } = require('@modelcontextprotocol/sdk/types.js') as
    typeof import('@modelcontextprotocol/sdk/types.js');
  /* eslint-enable global-require, @typescript-eslint/no-require-imports, import/extensions, import/no-unresolved */
  let client: InstanceType<typeof Client>;
  let transport: InstanceType<typeof StreamableHTTPClientTransport>;
  let vendorStatus: number | undefined;
  let phase = 'initialize';
  const readers = new Set<ReadableStreamDefaultReader<Uint8Array>>();
  let firstError: unknown;
  let fault = new AbortController();

  const mappedError = (error: unknown): RoomGrantError => {
    const cause = firstError || error;
    if (cause instanceof RoomGrantError && cause.code !== 'provider_unreachable') return cause;
    if (signal.aborted) return new RoomGrantError(
      'provider_unreachable', 'hosted-MCP vendor reply did not finish in time', 502,
    );
    if (cause instanceof RoomGrantError) return cause;
    if (cause instanceof McpError) {
      const detail = sanitizeVendorError(cause.message, token);
      return new RoomGrantError('provider_error', `hosted-MCP ${phase} failed: ${detail}`, 502,
        { vendorStatus, rpcCode: cause.code, vendorError: detail,
          ...(phase === 'initialize' ? { failure: 'unsupported_protocol' } : {}) });
    }
    const failure = cause instanceof SyntaxError ? 'invalid_json'
      : phase === 'initialize' ? 'unsupported_protocol' : 'missing_rpc_reply';
    return new RoomGrantError('provider_error', `hosted-MCP vendor returned an invalid ${phase} reply`, 502,
      { failure, vendorStatus });
  };

  const sdkFetch: typeof fetch = async (url, init: RequestInit = {}) => {
    // We only consume responses to requests. The SDK probes an optional GET
    // event channel after initialized; do not open a background vendor stream
    // for this short-lived, request/response-only broker session.
    if (init.method === 'GET') return new Response(null, { status: 405 });
    // SDK closes its transport on initialize failure. Cleanup still gets one
    // best-effort DELETE, bounded by the original deadline, not that closed
    // transport's signal or the failure latch.
    const combinedSignal = init.method === 'DELETE' ? signal
      : AbortSignal.any([signal, fault.signal, ...(init.signal ? [init.signal] : [])]);
    let response: Response;
    try {
      combinedSignal.throwIfAborted();
      response = await fetcher(url, { ...init, signal: combinedSignal });
    } catch (error) {
      const refused = new RoomGrantError('provider_unreachable',
        `hosted-MCP vendor unreachable: ${sanitizeVendorError(messageOf(error), token)}`, 502);
      firstError ||= refused;
      throw refused;
    }
    vendorStatus = response.status;
    if (response.status === 401 || response.status === 403) {
      const refused = new RoomGrantError('credential_rejected',
        'the vendor rejected this connection’s credential — reconnect to continue', 403);
      firstError ||= refused;
      await response.body?.cancel();
      throw refused;
    }
    if (!response.ok) {
      const vendorError = await vendorErrorLine(response, token);
      const refused = new RoomGrantError('provider_error', `hosted-MCP vendor answered ${response.status}`, 502,
        { vendorStatus: response.status, vendorError });
      firstError ||= refused;
      throw refused;
    }
    if (phase === 'initialize' && init.body && JSON.parse(String(init.body)).method === 'notifications/initialized'
      && response.status !== 202) {
      await response.body?.cancel();
      throw new RoomGrantError('provider_error', 'hosted-MCP vendor did not accept initialization', 502,
        { vendorStatus: response.status });
    }
    if (!response.body) return response;
    const reader = response.body.getReader();
    readers.add(reader);
    let bytes = 0;
    // Bound raw bytes before the SDK parses either JSON or SSE, without
    // buffering an event stream until EOF or implementing its framing ourselves.
    const bounded = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await reader.read();
          if (done) { readers.delete(reader); controller.close(); return; }
          bytes += value.byteLength;
          if (bytes > HOSTED_MCP_MAX_REPLY_BYTES) {
            const error = replyTooLarge(response.status);
            firstError ||= error;
            controller.error(error);
            await reader.cancel().catch(() => undefined);
            return;
          }
          controller.enqueue(value);
        } catch (error) {
          firstError ||= error;
          controller.error(error);
        }
      },
      cancel: () => reader.cancel().catch(() => undefined),
    });
    return new Response(bounded, { status: response.status, headers: response.headers });
  };
  const initialize = async () => {
    phase = 'initialize';
    firstError = undefined;
    fault = new AbortController();
    client = new Client({ name: 'commonly-hosted-mcp', version: '1.0.0' }, { capabilities: {} });
    transport = new StreamableHTTPClientTransport(new URL(resource), {
      fetch: sdkFetch,
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
      reconnectionOptions: { maxRetries: 0, initialReconnectionDelay: 1000,
        maxReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 },
    });
    // Progress is advisory; this broker does not expose progress callbacks.
    client.setNotificationHandler(ProgressNotificationSchema, () => {});
    client.onerror = (error) => { firstError ||= error; fault.abort(); };
    const setProtocolVersion = transport.setProtocolVersion.bind(transport);
    transport.setProtocolVersion = (version) => {
      if (!['2025-03-26', '2025-06-18', '2025-11-25'].includes(version)) {
        throw new RoomGrantError('provider_error', 'hosted-MCP vendor did not negotiate a supported protocol', 502,
          { failure: 'unsupported_protocol', vendorStatus });
      }
      setProtocolVersion(version);
    };
    await client.connect(transport, { signal, timeout: HOSTED_MCP_CALL_TIMEOUT_MS });
  };
  const close = async () => {
    try { await transport?.terminateSession(); } catch { /* Cleanup cannot replace the first failure. */ }
    await client?.close();
    await Promise.all([...readers].map((reader) => reader.cancel().catch(() => undefined)));
    readers.clear();
  };
  const expired = (error: unknown) => error instanceof RoomGrantError
    && error.details?.vendorStatus === 404 && Boolean(transport?.sessionId);
  try {
    try { await initialize(); } catch (error) {
      const mapped = mappedError(error);
      if (!expired(mapped)) throw mapped;
      await client!.close();
      await initialize();
    }
  } catch (error) {
    const mapped = mappedError(error);
    await close();
    throw mapped;
  }
  return {
    request: async (method: 'tools/list' | 'tools/call', params: Record<string, unknown>) => {
      const send = async () => {
        phase = method;
        firstError = undefined;
        try {
          // ResultSchema retains the broker's existing list-shape diagnostics
          // and opaque tool content. SDK still validates every JSON-RPC frame.
          return await client.request({ method, params }, ResultSchema,
            { signal: AbortSignal.any([signal, fault.signal]), timeout: HOSTED_MCP_CALL_TIMEOUT_MS });
        } catch (error) { throw mappedError(error); }
      };
      try { return await send(); } catch (error) {
        if (!expired(error)) throw error;
        await client.close();
        try { await initialize(); } catch (initializationError) { throw mappedError(initializationError); }
        return send();
      }
    },
    close,
  };
};

const listUpstreamTools = async (
  connectionId: string,
  deps: Pick<HostedMcpToolDeps, 'loadRow' | 'credentialFor' | 'fetcher'>,
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
    session = await openHostedMcpSession(entry.resource, token, deps.fetcher, controller.signal);
    const allTools: HostedMcpUpstreamTool[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const result = await session.request('tools/list', cursor ? { cursor } : {});
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
  deps: Pick<HostedMcpToolDeps, 'loadRow' | 'credentialFor' | 'fetcher'>,
  entries: HostedMcpEntry[] = HOSTED_MCP_ENTRIES,
): HostedMcpDriftCache => createHostedMcpDriftCache({
  listUpstreamTools: ({ connectionId }) => listUpstreamTools(connectionId, deps, entries),
});

const productionDriftCache = createHostedMcpRuntimeDriftCache({
  loadRow: (connectionId) => defaultDeps().loadRow(connectionId),
  credentialFor: (row) => defaultDeps().credentialFor(row),
  fetcher: guardedFetch,
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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOSTED_MCP_CALL_TIMEOUT_MS);
  let session: Awaited<ReturnType<typeof openHostedMcpSession>> | undefined;
  try {
    session = await openHostedMcpSession(entry.resource, token, deps.fetcher, controller.signal);
    const result = await session.request('tools/call', { name: tool.upstreamName, arguments: args });
    // MCP reports a tool that ran and failed as a result with `isError`, which is
    // the model's to read: throwing here would hide the vendor's own explanation
    // from the turn that asked for it.
    return capHostedToolResult(result);
  } catch (error) {
    // The deadline covers the body too: a vendor that sends headers and then
    // trickles the reply would otherwise hold the turn open past it (TASK-254).
    if (controller.signal.aborted && !(error instanceof RoomGrantError)) {
      throw new RoomGrantError('provider_unreachable', 'hosted-MCP vendor reply did not finish in time', 502);
    }
    throw error;
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
