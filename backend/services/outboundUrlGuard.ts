/**
 * Server-side fetches of a URL the operator did not choose.
 *
 * A fetch made by the backend can reach anything the backend's network can,
 * in-cluster services included, so a fetch whose URL arrived from a request
 * must be confined before it is made. Two modes, chosen by whether the
 * legitimate destinations can be listed in advance.
 *
 * `fetchTextFromAllowedHost` — a fixed set of public hosts that the CALLER
 * names:
 *
 *   - https only, on the default port, with no credentials in the URL;
 *   - the host must be an exact key of the caller's origin map, and the request
 *     is then rebuilt on that key's constant origin: only the path and query
 *     come from the parsed URL, so the scheme and host that reach the socket
 *     are a value the caller wrote, never one parsed from input;
 *   - redirects are followed here, by hand, never by `fetch` itself, and every
 *     hop is held to the same check before it is requested (at most
 *     `MAX_REDIRECTS` of them);
 *   - one deadline covers every hop and the body read, and the body is read
 *     against a byte cap the caller sets.
 *
 * Prefer it whenever the destinations can be listed: it does not depend on DNS,
 * because a host outside the set is refused before anything resolves it.
 *
 * `postToPublicAddress` — an open destination, such as a webhook endpoint its
 * owner registered. The ADDRESS is checked instead of the name: http(s) only;
 * the host is resolved here and every address it resolves to must be public;
 * the connection is made to the address that was checked (a pinned `lookup`),
 * so a second DNS answer cannot substitute another; every redirect hop is
 * resolved and checked the same way. See `classifyAddress` for the ranges.
 *
 * `getFromPublicAddress` — a GET of a URL an AGENT chose, for a page it reads
 * mid-turn. The same address check and pin as `postToPublicAddress`, held
 * tighter because the caller is a model acting on outsider-written text:
 * https only, on port 443; public addresses only, whatever the webhook private-address flag
 * says; at most `MAX_FETCH_REDIRECTS` hops; a 10s deadline; the body read to
 * at most 1 MB and then cut off, not refused; only text/html, text/plain,
 * application/json, application/rss+xml and application/atom+xml. Only HTML
 * is reduced to its text; feeds remain raw text. No cookies and no auth
 * header ever leave, because the request carries only the headers named here.
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

import { htmlToText } from './htmlToText';

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

interface AllowedRequest {
  /** The parsed URL: what a relative redirect `Location` resolves against. */
  url: URL;
  /** What is actually requested: the caller's constant origin plus the parsed path and query. */
  target: string;
}

const toAllowedRequest = (raw: string, allowedOrigins: ReadonlyMap<string, string>, base?: URL): AllowedRequest => {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new OutboundUrlRefusedError('not a valid URL');
  }
  if (url.protocol !== 'https:') throw new OutboundUrlRefusedError(`scheme ${url.protocol} is not https`);
  if (url.username || url.password) throw new OutboundUrlRefusedError('credentials in URL');
  if (url.port) throw new OutboundUrlRefusedError(`non-default port ${url.port}`);
  const origin = allowedOrigins.get(url.hostname);
  if (origin === undefined) throw new OutboundUrlRefusedError(`host ${url.hostname} is not allowed`);
  // `pathname` always starts with '/', and every origin ends with one.
  return { url, target: `${origin}${url.pathname.slice(1)}${url.search}` };
};

const readBytesCapped = async (response: Response, maxBytes: number): Promise<Buffer> => {
  if (!response.body) return Buffer.alloc(0);
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
  return Buffer.concat(chunks);
};

interface AllowedHostFetchOptions {
  /**
   * Each allowed hostname mapped to the constant origin its requests are sent
   * to, written with a trailing slash: `'github.com' → 'https://github.com/'`.
   */
  allowedOrigins: ReadonlyMap<string, string>;
  maxBytes: number;
  headers?: Record<string, string>;
}

interface AllowedHostFetchResult {
  ok: boolean;
  status: number;
  /** The body, read up to `maxBytes`. Empty when `ok` is false. */
  text: string;
}

interface AllowedHostBytesResult {
  ok: boolean;
  status: number;
  /** The body, read up to `maxBytes`. Empty when `ok` is false. */
  bytes: Buffer;
}

/**
 * The one loop both readers share: every hop is rebuilt on the caller's
 * constant origin, redirects are followed by hand and re-checked, one deadline
 * spans all of it, and the final body is read against `maxBytes`.
 */
const getFromAllowedHost = async (
  rawUrl: string,
  { allowedOrigins, maxBytes, headers }: AllowedHostFetchOptions,
): Promise<AllowedHostBytesResult> => {
  const signal = AbortSignal.timeout(OUTBOUND_TIMEOUT_MS);
  let request = toAllowedRequest(rawUrl, allowedOrigins);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(request.target, { headers, redirect: 'manual', signal });
    const location = REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (location === null) {
      if (!response.ok) {
        await response.body?.cancel();
        return { ok: false, status: response.status, bytes: Buffer.alloc(0) };
      }
      return { ok: true, status: response.status, bytes: await readBytesCapped(response, maxBytes) };
    }
    await response.body?.cancel();
    if (redirects >= MAX_REDIRECTS) throw new OutboundUrlRefusedError(`more than ${MAX_REDIRECTS} redirects`);
    request = toAllowedRequest(location, allowedOrigins, request.url);
  }
};

/**
 * GET `rawUrl` as text, provided it and every redirect it produces stay on the
 * hosts in `allowedOrigins`. Throws a refusal (see `isOutboundUrlRefused`)
 * before any request is made to a URL outside the set; throws a plain error
 * when the body exceeds `maxBytes` or the deadline passes. A non-2xx final
 * response is returned, not thrown, so each caller keeps its own handling of it.
 */
export const fetchTextFromAllowedHost = async (
  rawUrl: string,
  options: AllowedHostFetchOptions,
): Promise<AllowedHostFetchResult> => {
  const { ok, status, bytes } = await getFromAllowedHost(rawUrl, options);
  return { ok, status, text: bytes.toString('utf8') };
};

/**
 * `fetchTextFromAllowedHost` for a binary body (a zip): the same hosts,
 * redirects, deadline and cap, with the body returned as bytes.
 */
export const fetchBytesFromAllowedHost = async (
  rawUrl: string,
  options: AllowedHostFetchOptions,
): Promise<AllowedHostBytesResult> => getFromAllowedHost(rawUrl, options);

// ── Open destinations ───────────────────────────────────────────────────────

const WEBHOOK_TIMEOUT_MS = 10 * 1000;
const WEBHOOK_MAX_RESPONSE_BYTES = 1024 * 1024;
// Refused by name as well as by address: in the cluster it resolves to a
// link-local address, but refusing it should not depend on that resolution.
const METADATA_HOSTNAMES = new Set(['metadata.google.internal', 'metadata.google.internal.']);

/**
 * `public`: reachable on the internet; always allowed.
 * `private`: loopback, RFC 1918, CGNAT, IPv6 unique-local; allowed only when
 *   the operator sets OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES=true, for a
 *   local or self-hosted setup whose webhook receivers run beside the backend.
 * `reserved`: unspecified, link-local (which holds the cloud metadata
 *   endpoint), multicast, broadcast and other reserved space; never allowed.
 */
export type AddressClass = 'public' | 'private' | 'reserved';

const ipv4ToInt = (address: string): number => address.split('.')
  .reduce((acc, octet) => (acc * 256) + Number(octet), 0);

// Same block when both addresses agree on the leading `bits` bits, i.e. on
// the quotient by the block size.
const inIPv4Block = (ip: number, base: string, bits: number): boolean => {
  const blockSize = 2 ** (32 - bits);
  return Math.floor(ip / blockSize) === Math.floor(ipv4ToInt(base) / blockSize);
};

// IANA's IPv4 special-purpose registry, less the globally reachable rows
// (AS112, AMT), plus multicast.
const RESERVED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // unspecified, "this network"
  ['169.254.0.0', 16], // link-local, including 169.254.169.254
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation (TEST-NET-1)
  ['192.88.99.0', 24], // deprecated 6to4 relay anycast
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation (TEST-NET-2)
  ['203.0.113.0', 24], // documentation (TEST-NET-3)
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, including 255.255.255.255
];
const PRIVATE_V4: Array<[string, number]> = [
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
];

const classifyIPv4 = (address: string): AddressClass => {
  const ip = ipv4ToInt(address);
  if (RESERVED_V4.some(([base, bits]) => inIPv4Block(ip, base, bits))) return 'reserved';
  if (PRIVATE_V4.some(([base, bits]) => inIPv4Block(ip, base, bits))) return 'private';
  return 'public';
};

/** Eight 16-bit groups, via the URL parser's canonical form; null if not IPv6. */
const ipv6Groups = (address: string): number[] | null => {
  let canonical: string;
  try {
    canonical = new URL(`http://[${address.split('%')[0]}]`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const [head, tail] = canonical.includes('::') ? canonical.split('::') : [canonical, undefined];
  const headGroups = head ? head.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - headGroups.length - tailGroups.length;
  const groups = [...headGroups, ...Array(fill).fill('0'), ...tailGroups].map((g) => parseInt(g, 16));
  return groups.length === 8 ? groups : null;
};

const groupsToIPv4 = (hi: number, lo: number): string => (
  `${Math.floor(hi / 256)}.${hi % 256}.${Math.floor(lo / 256)}.${lo % 256}`
);

// Same block when the leading `bits` bits agree. `base` may omit trailing
// zero groups.
const inIPv6Block = (g: number[], base: number[], bits: number): boolean => g
  .slice(0, Math.ceil(bits / 16))
  .every((x, i) => {
    const blockSize = 2 ** (16 - Math.min(16, bits - (16 * i)));
    return Math.floor(x / blockSize) === Math.floor((base[i] ?? 0) / blockSize);
  });

// Ranges that carry an IPv4 address, classified by that address so every
// IPv4 range is refused in each of its IPv6 spellings. The pair names the two
// groups holding it.
const EMBEDDED_V4: Array<[number[], number, [number, number]]> = [
  [[0, 0, 0, 0, 0, 0xffff], 96, [6, 7]], // IPv4-mapped, ::ffff:a.b.c.d
  [[0, 0, 0, 0, 0xffff, 0], 96, [6, 7]], // IPv4-translated, ::ffff:0:a.b.c.d
  [[0x64, 0xff9b], 96, [6, 7]], // NAT64, 64:ff9b::a.b.c.d
  [[0x2002], 16, [1, 2]], // 6to4, 2002:aabb:ccdd::
];
const TEREDO: [number[], number] = [[0x2001], 32];

// IANA's IPv6 special-purpose registry, less the globally reachable rows
// outside 2001::/23, plus the deprecated site-local block and multicast.
const RESERVED_V6: Array<[number[], number]> = [
  [[0x64, 0xff9b, 1], 48], // local-use IPv4/IPv6 translation
  [[0x100], 64], // discard-only
  [[0x100, 0, 0, 1], 64], // dummy prefix
  [[0x2001], 23], // IETF protocol assignments, after Teredo is decoded
  [[0x2001, 0xdb8], 32], // documentation
  [[0x3fff], 20], // documentation
  [[0x5f00], 16], // segment routing SIDs
  [[0xfe80], 10], // link-local
  [[0xfec0], 10], // deprecated site-local
  [[0xff00], 8], // multicast
];
const PRIVATE_V6: Array<[number[], number]> = [
  [[0xfc00], 7], // unique-local
];

/**
 * Classify one IP address. IPv6 addresses that carry an IPv4 address (mapped,
 * translated, NAT64, 6to4, Teredo) are classified by that IPv4 address, so
 * every IPv4 range is also refused in its IPv6 spellings. Anything that does
 * not parse is `reserved`.
 */
export const classifyAddress = (address: string): AddressClass => {
  if (net.isIPv4(address)) return classifyIPv4(address);
  const g = ipv6Groups(address);
  if (!g) return 'reserved';
  const embedded = EMBEDDED_V4.find(([base, bits]) => inIPv6Block(g, base, bits));
  if (embedded) return classifyIPv4(groupsToIPv4(g[embedded[2][0]], g[embedded[2][1]]));
  // Teredo stores the client's IPv4 address with every bit inverted.
  if (inIPv6Block(g, ...TEREDO)) return classifyIPv4(groupsToIPv4(0xffff - g[6], 0xffff - g[7]));
  if (g.slice(0, 6).every((x) => x === 0)) {
    // ::1 is loopback; :: and the deprecated IPv4-compatible block are not routable.
    return g[6] === 0 && g[7] === 1 ? 'private' : 'reserved';
  }
  if (RESERVED_V6.some(([base, bits]) => inIPv6Block(g, base, bits))) return 'reserved';
  if (PRIVATE_V6.some(([base, bits]) => inIPv6Block(g, base, bits))) return 'private';
  return 'public';
};

const privateAddressesAllowed = (): boolean => process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES === 'true';

const isAllowedAddress = (address: string, allowPrivate: boolean): boolean => {
  const kind = classifyAddress(address);
  return kind === 'public' || (kind === 'private' && allowPrivate);
};

interface DestinationPolicy {
  /** Allow only https, refusing http as well as everything else. */
  httpsOnly: boolean;
  /** Whether a `private` address may pass. `reserved` never does. */
  allowPrivate: () => boolean;
}

// Webhooks: http(s), and private addresses only when the operator's flag allows.
const WEBHOOK_POLICY: DestinationPolicy = { httpsOnly: false, allowPrivate: () => privateAddressesAllowed() };
// An agent's fetch: https, public addresses only. The webhook flag does not
// apply, because a local receiver the operator trusts is not a page a model may read.
const AGENT_FETCH_POLICY: DestinationPolicy = { httpsOnly: true, allowPrivate: () => false };

/** Parse, then resolve and check: the one address the hop connects to. */
const toPublicDestination = async (
  raw: string,
  base?: URL,
  policy: DestinationPolicy = WEBHOOK_POLICY,
): Promise<{ url: URL; address: dns.LookupAddress }> => {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new OutboundUrlRefusedError('not a valid URL');
  }
  if (policy.httpsOnly && url.protocol !== 'https:') {
    throw new OutboundUrlRefusedError(`scheme ${url.protocol} is not https`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundUrlRefusedError(`scheme ${url.protocol} is not http or https`);
  }
  if (policy.httpsOnly && (url.username || url.password)) throw new OutboundUrlRefusedError('credentials in URL');
  // The URL parser drops a default :443, so any port left here is a non-default one.
  if (policy.httpsOnly && url.port) throw new OutboundUrlRefusedError(`non-default port ${url.port}`);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (METADATA_HOSTNAMES.has(host)) throw new OutboundUrlRefusedError(`host ${host} is not allowed`);
  const family = net.isIP(host);
  const answers: dns.LookupAddress[] = family
    ? [{ address: host, family }]
    : await dns.promises.lookup(host, { all: true, verbatim: true }).catch(() => {
      throw new OutboundUrlRefusedError(`host ${host} does not resolve`);
    });
  if (!answers.length) throw new OutboundUrlRefusedError(`host ${host} does not resolve`);
  // Every answer must pass, not just the first, so a name with a public and a
  // private record is refused rather than decided by which one is used.
  const refused = answers.find((answer) => !isAllowedAddress(answer.address, policy.allowPrivate()));
  if (refused) throw new OutboundUrlRefusedError(`host ${host} resolves to ${refused.address}, which is not allowed`);
  return { url, address: answers[0] };
};

interface PinnedRequest {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

interface RawResponse {
  status: number;
  mcpSessionId?: string;
  location?: string;
  text: string;
  /** The response's media type, lowercased and without parameters; '' when absent. */
  contentType: string;
  /** True when the body was cut off at `maxBytes` rather than read to its end. */
  truncated: boolean;
}

interface ReadPolicy {
  maxBytes: number;
  /** `error` fails the request at the cap; `truncate` keeps the first `maxBytes` and stops reading. */
  overflow: 'error' | 'truncate';
  /** Checked on a 2xx before any body byte is read; a refused type ends the request. */
  acceptContentType?: (mediaType: string) => boolean;
  /**
   * Read a non-2xx body too, against the same cap. Off by default: a webhook or
   * a page only needs the status. A vendor's OAuth error body is how its caller
   * tells `invalid_grant` from an outage, so the vendor mode turns it on.
   */
  readErrorBodies?: boolean;
}

const WEBHOOK_READ: ReadPolicy = { maxBytes: WEBHOOK_MAX_RESPONSE_BYTES, overflow: 'error' };

const mediaTypeOf = (header: string | string[] | undefined): string => (
  String(Array.isArray(header) ? header[0] : header || '').split(';')[0].trim().toLowerCase()
);

const requestPinned = (
  url: URL,
  address: dns.LookupAddress,
  { method, headers, body }: PinnedRequest,
  signal: AbortSignal,
  read: ReadPolicy = WEBHOOK_READ,
): Promise<RawResponse> => new Promise((resolve, reject) => {
  // Destroying the request after a cut-off or a refused type also emits an
  // error; only the first outcome counts.
  let settled = false;
  const settle = (fn: () => void) => { if (!settled) { settled = true; fn(); } };
  const client = url.protocol === 'https:' ? https : http;
  // The socket connects to the address checked above, whatever DNS answers now.
  // TLS still verifies the certificate against the URL's hostname.
  const lookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  }) as unknown as net.LookupFunction;
  const req = client.request(url, { method, headers, lookup, signal }, (res) => {
    const status = res.statusCode || 0;
    const location = REDIRECT_STATUSES.has(status) ? res.headers.location : undefined;
    const contentType = mediaTypeOf(res.headers['content-type']);
    const mcpSessionId = typeof res.headers['mcp-session-id'] === 'string'
      ? res.headers['mcp-session-id'] : undefined;
    if (location || ((status < 200 || status >= 300) && !read.readErrorBodies)) {
      res.resume();
      settle(() => resolve({ status, location, text: '', contentType, truncated: false }));
      return;
    }
    if (read.acceptContentType && status >= 200 && status < 300 && !read.acceptContentType(contentType)) {
      settle(() => reject(new OutboundUrlRefusedError(`content type ${contentType || '(none)'} is not allowed`)));
      req.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    res.on('data', (chunk: Buffer) => {
      if (settled) return;
      if (received + chunk.length > read.maxBytes) {
        if (read.overflow === 'error') {
          req.destroy(new Error(`response body exceeds ${read.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk.subarray(0, read.maxBytes - received));
        settle(() => resolve({ status, text: Buffer.concat(chunks).toString('utf8'), contentType, truncated: true }));
        req.destroy();
        return;
      }
      received += chunk.length;
      chunks.push(chunk);
    });
    res.on('end', () => settle(() => resolve({
      status, text: Buffer.concat(chunks).toString('utf8'), contentType, truncated: false,
      ...(mcpSessionId ? { mcpSessionId } : {}),
    })));
    res.on('error', (error) => settle(() => reject(error)));
  });
  req.on('error', (error) => settle(() => reject(error)));
  if (body !== undefined) req.write(body);
  req.end();
});

/**
 * POST `body` to `rawUrl`, an open destination, provided the host and every
 * redirect hop resolve only to allowed addresses (see `classifyAddress`), with
 * each connection pinned to the address that was checked. A redirect is
 * followed at most `MAX_REDIRECTS` times: 307/308 keep the method and body,
 * 301/302/303 continue as a GET, as `fetch` does. Throws a refusal (see
 * `isOutboundUrlRefused`) before connecting anywhere refused; a non-2xx final
 * response is returned, not thrown. One 10s deadline covers every hop.
 */
export const postToPublicAddress = async (
  rawUrl: string,
  { headers, body }: { headers: Record<string, string>; body: string },
): Promise<AllowedHostFetchResult> => {
  const signal = AbortSignal.timeout(WEBHOOK_TIMEOUT_MS);
  let request: PinnedRequest = { method: 'POST', headers, body };
  let destination = await toPublicDestination(rawUrl);
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestPinned(destination.url, destination.address, request, signal);
    if (!response.location) {
      const ok = response.status >= 200 && response.status < 300;
      return { ok, status: response.status, text: response.text };
    }
    if (redirects >= MAX_REDIRECTS) throw new OutboundUrlRefusedError(`more than ${MAX_REDIRECTS} redirects`);
    if (response.status !== 307 && response.status !== 308) {
      const { 'Content-Type': _contentType, ...rest } = request.headers;
      request = { method: 'GET', headers: rest };
    }
    destination = await toPublicDestination(response.location, destination.url);
  }
};

// ── A page an agent reads ───────────────────────────────────────────────────

const MAX_FETCH_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10 * 1000;
const FETCH_MAX_BYTES = 1024 * 1024;
const FETCH_CONTENT_TYPES = new Set([
  'text/html', 'text/plain', 'application/json', 'application/rss+xml', 'application/atom+xml',
]);
// The only headers sent. Nothing a caller passes is merged in, so no cookie and
// no Authorization header can leave with an agent's fetch.
const FETCH_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'User-Agent': 'CommonlyAgentFetch/1.0 (+https://commonly.me)',
  Accept: 'text/html, text/plain;q=0.9, application/json;q=0.9, '
    + 'application/rss+xml;q=0.9, application/atom+xml;q=0.9',
});

export interface PublicPageResult {
  ok: boolean;
  status: number;
  /** The final hop's media type, lowercased, without parameters. */
  contentType: string;
  /** The body as text, HTML reduced to its words. Empty when `ok` is false. */
  text: string;
  /** True when the body passed 1 MB and only its start was read. */
  truncated: boolean;
  /** The URL the final response came from, after any redirects. */
  url: string;
}

/**
 * GET `rawUrl` on an agent's behalf. Every hop must be https and resolve only
 * to public addresses, and each connection is pinned to the address that was
 * checked, so a second DNS answer (rebinding) cannot redirect it. Redirects
 * are followed by hand, re-checked, at most `MAX_FETCH_REDIRECTS` times; one
 * 10s deadline covers every hop and the body. A 2xx must be text/html,
 * text/plain, application/json, application/rss+xml or application/atom+xml,
 * checked before any body byte is read. Feeds remain raw text; the
 * body is read to at most 1 MB and then cut off, reported as `truncated`.
 * Throws a refusal (see `isOutboundUrlRefused`) for a refused URL, hop or
 * content type, before connecting where the URL is refused; a non-2xx final
 * response is returned, not thrown.
 */
export const getFromPublicAddress = async (rawUrl: string): Promise<PublicPageResult> => {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const request: PinnedRequest = { method: 'GET', headers: { ...FETCH_HEADERS } };
  const read: ReadPolicy = {
    maxBytes: FETCH_MAX_BYTES,
    overflow: 'truncate',
    acceptContentType: (mediaType) => FETCH_CONTENT_TYPES.has(mediaType),
  };
  let destination = await toPublicDestination(rawUrl, undefined, AGENT_FETCH_POLICY);
  for (let redirects = 0; ; redirects += 1) {
    const response = await requestPinned(destination.url, destination.address, request, signal, read);
    if (!response.location) {
      const ok = response.status >= 200 && response.status < 300;
      const text = ok && response.contentType === 'text/html' ? htmlToText(response.text) : response.text;
      return {
        ok, status: response.status, contentType: response.contentType, text, truncated: response.truncated,
        url: destination.url.toString(),
      };
    }
    if (redirects >= MAX_FETCH_REDIRECTS) {
      throw new OutboundUrlRefusedError(`more than ${MAX_FETCH_REDIRECTS} redirects`);
    }
    destination = await toPublicDestination(response.location, destination.url, AGENT_FETCH_POLICY);
  }
};

// ── A credentialed request to a hosted-MCP vendor (TASK-253) ────────────────

/** A vendor reply as the guard read it. `location` is set on a 3xx, which is never followed. */
export interface VendorEndpointResult {
  status: number;
  mcpSessionId?: string;
  contentType: string;
  text: string;
  location?: string;
}

/**
 * One request to a hosted-MCP vendor's MCP or OAuth endpoint. Each one carries
 * a credential: a bearer token, an authorization code and its verifier, a
 * refresh token, or a client secret.
 *
 * Today every such URL is pinned in the catalog or served by the vendor's own
 * metadata under a pinned issuer. It is held to the agent-fetch destination
 * policy anyway, because a URL the catalog did not write (a by-URL entry, a
 * metadata document) must not be able to aim a credential at an internal
 * address:
 *   - https on the default port, no credentials in the URL;
 *   - every address the host resolves to must be public, and the socket is
 *     pinned to the address that was checked;
 *   - NO redirect is followed. A 3xx comes back as its status with its
 *     `location`, because a 307 or 308 would re-send the credential in the body
 *     to whatever host the Location names;
 *   - the body, a non-2xx body included, is read to `maxBytes` and then fails.
 * The caller's signal bounds the whole request.
 */
export const requestVendorEndpoint = async (
  rawUrl: string,
  {
    method, headers, body, signal, maxBytes,
  }: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    maxBytes: number;
  },
): Promise<VendorEndpointResult> => {
  const destination = await toPublicDestination(rawUrl, undefined, AGENT_FETCH_POLICY);
  const response = await requestPinned(
    destination.url,
    destination.address,
    { method, headers, ...(body !== undefined ? { body } : {}) },
    signal,
    { maxBytes, overflow: 'error', readErrorBodies: true },
  );
  return {
    status: response.status,
    contentType: response.contentType,
    text: response.text,
    ...(response.location ? { location: response.location } : {}),
    ...(response.mcpSessionId ? { mcpSessionId: response.mcpSessionId } : {}),
  };
};
