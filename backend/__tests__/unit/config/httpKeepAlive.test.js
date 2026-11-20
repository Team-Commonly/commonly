const http = require('http');
const {
  applyKeepAliveTimeouts,
  TUNNEL_IDLE_MS,
  KEEP_ALIVE_TIMEOUT_MS,
  HEADERS_TIMEOUT_MS,
} = require('../../../config/httpKeepAlive');

// The tunnel keeps an idle connection to the backend for 90 s and reuses it.
// Node's default keep-alive is 5 s, so Node closed first, and a request the
// tunnel sent down a socket Node had just closed failed with "connection reset
// by peer". The browser then got the tunnel's error page, with no CORS header.
describe('HTTP keep-alive outlasts the tunnel', () => {
  test('the tunnel idle is cloudflared’s default origin keep-alive, 90 s', () => {
    expect(TUNNEL_IDLE_MS).toBe(90000);
  });

  test('the backend keeps an idle socket open longer than the tunnel does', () => {
    expect(KEEP_ALIVE_TIMEOUT_MS).toBeGreaterThan(TUNNEL_IDLE_MS);
  });

  test('headersTimeout is above keepAliveTimeout, so a reused socket never times out mid-headers', () => {
    expect(HEADERS_TIMEOUT_MS).toBeGreaterThan(KEEP_ALIVE_TIMEOUT_MS);
  });

  test('it sets both on the server, and stays under requestTimeout, which Node requires', () => {
    const server = http.createServer();
    expect(server.keepAliveTimeout).toBe(5000);
    expect(applyKeepAliveTimeouts(server)).toBe(server);
    expect(server.keepAliveTimeout).toBe(KEEP_ALIVE_TIMEOUT_MS);
    expect(server.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(server.headersTimeout).toBeLessThanOrEqual(server.requestTimeout);
  });
});
