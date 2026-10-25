/**
 * Pieces shared by the loopback HTTP relays that sit between a CLI and its
 * model provider: the key-injecting proxy the OpenAI-compatible adapters use
 * (cli/src/lib/provider-proxy.js) and the supervisor's pass-through relay
 * (provider-relay.js). Moved here from provider-proxy.js so both read one list.
 */

// Hop-by-hop headers describe one connection, never the request, so a relay
// that forwards them would describe the wrong connection to the next hop.
export const HOP_BY_HOP_HEADERS = Object.freeze([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/** A copy of `headers` without the hop-by-hop set and without `drop` (names, any case). */
export const withoutHeaders = (headers, drop = []) => {
  const dropped = new Set([...HOP_BY_HOP_HEADERS, ...drop].map((name) => name.toLowerCase()));
  return Object.fromEntries(Object.entries(headers || {})
    .filter(([name]) => !dropped.has(name.toLowerCase())));
};

/**
 * True when a request path is an origin-form path a relay can map onto its
 * upstream without reinterpretation: it starts with one slash, and carries no
 * encoded slash, backslash or dot that a server could decode into a different
 * path than the one the relay checked.
 */
export const isPlainRequestTarget = (path) => typeof path === 'string'
  && path.startsWith('/') && !path.startsWith('//')
  && !/%(?:2f|5c|2e)/i.test(path);
