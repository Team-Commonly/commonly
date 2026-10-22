/**
 * The `fetch` every hosted-MCP request goes through (TASK-253).
 *
 * The tool calls (`hostedMcpToolDefinitions.ts`) and the OAuth calls (discovery,
 * token exchange, refresh, DCR registration and revocation, all through
 * `upstreamFetch.ts`) used the platform `fetch`: any address, any redirect. This
 * keeps their fetch-shaped seam, and the injected fetchers their tests use, but
 * makes the request through `requestVendorEndpoint`, so the outbound guard's
 * destination policy, address pin and no-redirect rule apply to each one. See
 * that function for the rules.
 *
 * A refusal surfaces as a TypeError, the way `fetch` reports a network failure,
 * so every call site keeps mapping it to the vendor being unreachable. The
 * refused host and address go to the server log, not into an error a turn or a
 * browser can read.
 */
import { isOutboundUrlRefused, requestVendorEndpoint } from './outboundUrlGuard';

/** The most of one vendor reply the backend reads. Airtable's largest real tools/list page is 608 KB. */
export const HOSTED_VENDOR_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The bound when a caller passes no signal; every current caller passes one. */
const DEFAULT_TIMEOUT_MS = 30 * 1000;

// Statuses whose Response may not carry a body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const urlOf = (input: Parameters<typeof fetch>[0]): string => {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
};

const headersOf = (headers: RequestInit['headers']): Record<string, string> => {
  const out: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => { out[key] = value; });
  return out;
};

const bodyOf = (body: RequestInit['body']): string | undefined => {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  if (body instanceof URLSearchParams) return body.toString();
  // Every hosted call sends JSON or a form; anything else is a caller bug, and
  // it fails loudly rather than being stringified into "[object Blob]".
  throw new TypeError('hostedVendorFetch sends only a string or URLSearchParams body');
};

export const hostedVendorFetch = (async (
  input: Parameters<typeof fetch>[0],
  init: RequestInit = {},
): Promise<Response> => {
  const url = urlOf(input);
  let reply;
  try {
    reply = await requestVendorEndpoint(url, {
      method: (init.method || 'GET').toUpperCase(),
      headers: headersOf(init.headers),
      body: bodyOf(init.body),
      signal: init.signal || AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      maxBytes: HOSTED_VENDOR_MAX_RESPONSE_BYTES,
    });
  } catch (error) {
    if (isOutboundUrlRefused(error)) {
      // eslint-disable-next-line no-console
      console.warn(`[hosted-mcp] outbound guard refused ${url}: ${(error as Error).message}`);
      throw new TypeError('fetch failed: the outbound guard refused the vendor endpoint');
    }
    throw error;
  }
  if (reply.status < 200 || reply.status > 599) {
    throw new TypeError(`fetch failed: the vendor answered with status ${reply.status}`);
  }
  const headers: Record<string, string> = {};
  if (reply.contentType) headers['content-type'] = reply.contentType;
  if (reply.location) headers.location = reply.location;
  return new Response(NULL_BODY_STATUSES.has(reply.status) ? null : reply.text, { status: reply.status, headers });
}) as typeof fetch;
