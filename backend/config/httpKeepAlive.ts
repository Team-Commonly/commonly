import type { Server } from 'http';

/**
 * Keep-alive timeouts for the HTTP server users reach through the tunnel.
 *
 * cloudflared keeps an idle connection to its origin for 90 s by default
 * (`originRequest.keepAliveTimeout`) and sends the next request down it. Node
 * closes an idle keep-alive socket after 5 s by default. When the backend closes
 * first, a request the tunnel sends on that socket at the same moment fails with
 * "connection reset by peer". The browser then gets the tunnel's error page,
 * which carries no CORS header, so a fetch reports a CORS error. That happened
 * about 7 times a day (2026-11-20, F565).
 *
 * The origin must keep a socket open longer than the proxy in front of it, so
 * the proxy is always the side that closes. `headersTimeout` sits above
 * `keepAliveTimeout`, so a socket reused at the last moment is not cut off
 * while its request headers are still arriving. Node also requires
 * `headersTimeout` <= `requestTimeout` (300 s by default).
 *
 * Shutdown is unaffected: hostedShutdownService calls closeIdleConnections().
 */
export const TUNNEL_IDLE_MS = 90_000;
export const KEEP_ALIVE_TIMEOUT_MS = 95_000;
export const HEADERS_TIMEOUT_MS = 96_000;

export function applyKeepAliveTimeouts<S extends Server>(server: S): S {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
