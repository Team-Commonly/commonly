/**
 * Server-side fetches of a URL the operator did not choose.
 *
 * A fetch made by the backend can reach anything the backend's network can,
 * in-cluster services included, so a fetch whose URL arrived from a request
 * must be confined before it is made. This module confines it to a fixed set
 * of public hosts that the CALLER names:
 *
 *   - https only, on the default port, with no credentials in the URL;
 *   - the host must be an exact member of the caller's set;
 *   - redirects are followed here, by hand, never by `fetch` itself, and every
 *     hop is held to the same check before it is requested (at most
 *     `MAX_REDIRECTS` of them);
 *   - one deadline covers every hop and the body read, and the body is read
 *     against a byte cap the caller sets.
 *
 * An allowlist rather than an address-range check, because it does not depend
 * on DNS: a host outside the set is refused before anything resolves it, so
 * there is no gap between the name that was checked and the address that is
 * connected to. A caller whose legitimate destinations cannot be enumerated
 * needs an address-range guard instead, which this module does not provide.
 */

const MAX_REDIRECTS = 5;
const OUTBOUND_TIMEOUT_MS = 15 * 1000;

const OUTBOUND_URL_REFUSED = 'OUTBOUND_URL_REFUSED';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

// A reason carries the refused host, which came from a request and is logged by
// callers. The URL parser has already removed control characters from it; this
// bounds its length.
const MAX_REASON_LENGTH = 200;

class OutboundUrlRefusedError extends Error {
  readonly code = OUTBOUND_URL_REFUSED;

  constructor(reason: string) {
    super(`outbound URL refused: ${reason.slice(0, MAX_REASON_LENGTH)}`);
    this.name = 'OutboundUrlRefusedError';
  }
}

/**
 * True for the error this module throws when it refuses a URL or a redirect
 * hop. Routes map it to a 400 with a fixed message; the error's own message
 * names the refused host and belongs in the server log, not the response.
 */
export const isOutboundUrlRefused = (error: unknown): boolean => (
  typeof error === 'object'
  && error !== null
  && (error as { code?: unknown }).code === OUTBOUND_URL_REFUSED
);

const toAllowedUrl = (raw: string, allowedHosts: ReadonlySet<string>, base?: URL): URL => {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new OutboundUrlRefusedError('not a valid URL');
  }
  if (url.protocol !== 'https:') throw new OutboundUrlRefusedError(`scheme ${url.protocol} is not https`);
  if (url.username || url.password) throw new OutboundUrlRefusedError('credentials in URL');
  if (url.port) throw new OutboundUrlRefusedError(`non-default port ${url.port}`);
  if (!allowedHosts.has(url.hostname)) throw new OutboundUrlRefusedError(`host ${url.hostname} is not allowed`);
  return url;
};

const readTextCapped = async (response: Response, maxBytes: number): Promise<string> => {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new Error(`response body exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
};

interface AllowedHostFetchOptions {
  allowedHosts: ReadonlySet<string>;
  maxBytes: number;
  headers?: Record<string, string>;
}

interface AllowedHostFetchResult {
  ok: boolean;
  status: number;
  /** The body, read up to `maxBytes`. Empty when `ok` is false. */
  text: string;
}

/**
 * GET `rawUrl` as text, provided it and every redirect it produces stay on
 * `allowedHosts`. Throws a refusal (see `isOutboundUrlRefused`) before any
 * request is made to a URL outside the set; throws a plain error when the body
 * exceeds `maxBytes` or the deadline passes. A non-2xx final response is
 * returned, not thrown, so each caller keeps its own handling of it.
 */
export const fetchTextFromAllowedHost = async (
  rawUrl: string,
  { allowedHosts, maxBytes, headers }: AllowedHostFetchOptions,
): Promise<AllowedHostFetchResult> => {
  const signal = AbortSignal.timeout(OUTBOUND_TIMEOUT_MS);
  let url = toAllowedUrl(rawUrl, allowedHosts);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(url.href, { headers, redirect: 'manual', signal });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status, text: '' };
      }
      return { ok: true, status: response.status, text: await readTextCapped(response, maxBytes) };
    }
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) throw new OutboundUrlRefusedError(`more than ${MAX_REDIRECTS} redirects`);
    url = toAllowedUrl(location, allowedHosts, url);
  }
};
