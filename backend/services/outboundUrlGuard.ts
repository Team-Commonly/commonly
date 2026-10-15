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
 */

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

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

/**
 * GET `rawUrl` as text, provided it and every redirect it produces stay on the
 * hosts in `allowedOrigins`. Throws a refusal (see `isOutboundUrlRefused`)
 * before any request is made to a URL outside the set; throws a plain error
 * when the body exceeds `maxBytes` or the deadline passes. A non-2xx final
 * response is returned, not thrown, so each caller keeps its own handling of it.
 */
export const fetchTextFromAllowedHost = async (
  rawUrl: string,
  { allowedOrigins, maxBytes, headers }: AllowedHostFetchOptions,
): Promise<AllowedHostFetchResult> => {
  const signal = AbortSignal.timeout(OUTBOUND_TIMEOUT_MS);
  let request = toAllowedRequest(rawUrl, allowedOrigins);
  for (let redirects = 0; ; redirects += 1) {
    const response = await fetch(request.target, { headers, redirect: 'manual', signal });
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
    request = toAllowedRequest(location, allowedOrigins, request.url);
  }
};

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

const RESERVED_V4: Array<[string, number]> = [
  ['0.0.0.0', 8], // unspecified, "this network"
  ['169.254.0.0', 16], // link-local, including 169.254.169.254
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

/**
 * Classify one IP address. IPv4-mapped (`::ffff:a.b.c.d`) and NAT64
 * (`64:ff9b::a.b.c.d`) addresses are classified by the IPv4 address they
 * carry, so every IPv4 range is also refused in its IPv6 spellings. Anything
 * that does not parse is `reserved`.
 */
export const classifyAddress = (address: string): AddressClass => {
  if (net.isIPv4(address)) return classifyIPv4(address);
  const g = ipv6Groups(address);
  if (!g) return 'reserved';
  const embeddedIPv4 = () => `${Math.floor(g[6] / 256)}.${g[6] % 256}.${Math.floor(g[7] / 256)}.${g[7] % 256}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return classifyIPv4(embeddedIPv4());
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return classifyIPv4(embeddedIPv4());
  if (g.slice(0, 6).every((x) => x === 0)) {
    // ::1 is loopback; :: and the deprecated IPv4-compatible block are not routable.
    return g[6] === 0 && g[7] === 1 ? 'private' : 'reserved';
  }
  if (g[0] >= 0xfc00 && g[0] <= 0xfdff) return 'private'; // unique-local fc00::/7
  if (g[0] >= 0xfe80 && g[0] <= 0xfebf) return 'reserved'; // link-local fe80::/10
  if (g[0] >= 0xff00) return 'reserved'; // multicast ff00::/8
  return 'public';
};

const privateAddressesAllowed = (): boolean => process.env.OUTBOUND_WEBHOOK_ALLOW_PRIVATE_ADDRESSES === 'true';

const isAllowedAddress = (address: string): boolean => {
  const kind = classifyAddress(address);
  return kind === 'public' || (kind === 'private' && privateAddressesAllowed());
};

/** Parse, then resolve and check: the one address the hop connects to. */
const toPublicDestination = async (raw: string, base?: URL): Promise<{ url: URL; address: dns.LookupAddress }> => {
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    throw new OutboundUrlRefusedError('not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundUrlRefusedError(`scheme ${url.protocol} is not http or https`);
  }
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
  const refused = answers.find((answer) => !isAllowedAddress(answer.address));
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
  location?: string;
  text: string;
}

const requestPinned = (
  url: URL,
  address: dns.LookupAddress,
  { method, headers, body }: PinnedRequest,
  signal: AbortSignal,
): Promise<RawResponse> => new Promise((resolve, reject) => {
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
    if (location || status < 200 || status >= 300) {
      res.resume();
      resolve({ status, location, text: '' });
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    res.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > WEBHOOK_MAX_RESPONSE_BYTES) {
        req.destroy(new Error(`response body exceeds ${WEBHOOK_MAX_RESPONSE_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => resolve({ status, text: Buffer.concat(chunks).toString('utf8') }));
    res.on('error', reject);
  });
  req.on('error', reject);
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
