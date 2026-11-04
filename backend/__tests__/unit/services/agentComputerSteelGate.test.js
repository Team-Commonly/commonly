const http = require('node:http');
const net = require('node:net');
const { createSteelGate } = require('../../../services/agentComputerSteelGate');

const TOKEN = 'steel-gate-token-for-tests';

// Upgraded sockets leave the http server's own tracking, so the test keeps
// every connection and destroys it on teardown.
const listen = (server) => new Promise((resolve) => {
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  // eslint-disable-next-line no-param-reassign
  server.trackedSockets = sockets;
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});
const close = (server) => new Promise((resolve) => {
  (server.trackedSockets || new Set()).forEach((socket) => socket.destroy());
  server.close(() => resolve());
});

// A stand-in for Steel: records what reached it, answers /v1/health, echoes
// /v1/sessions, and accepts a WebSocket-style upgrade by echoing bytes.
const fakeSteel = ({ healthStatus = 200 } = {}) => {
  const seen = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({
        method: req.method, url: req.url, headers: req.headers, body,
      });
      if (req.url === '/v1/health') {
        res.writeHead(healthStatus);
        res.end('{"status":"ok"}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-steel-hop': 'internal', connection: 'x-steel-hop' });
      res.end(JSON.stringify({ sessions: [{ id: 's1', status: 'live' }] }));
    });
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ upgrade: true, url: req.url, headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
    socket.on('end', () => socket.end());
  });
  return { server, seen };
};

// Sends a raw upgrade request and resolves with everything read back after
// writing `payload` (or the rejection status line).
const rawUpgrade = (port, headers, payload = 'ping') => new Promise((resolve, reject) => {
  const socket = net.connect(port, '127.0.0.1', () => {
    const lines = ['GET / HTTP/1.1', 'Host: steel', 'Upgrade: websocket', 'Connection: Upgrade', ...headers];
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  });
  let data = '';
  let sent = false;
  socket.on('data', (chunk) => {
    data += chunk.toString();
    if (!sent && data.includes('101 Switching Protocols')) {
      sent = true;
      socket.write(payload);
    }
    if (sent && data.endsWith(payload)) { socket.end(); }
  });
  socket.on('close', () => resolve(data));
  socket.on('error', reject);
  setTimeout(() => socket.destroy(), 2000);
});

describe('agentComputerSteelGate', () => {
  let steel;
  let gate;
  let gatePort;

  beforeEach(async () => {
    steel = fakeSteel();
    const upstreamPort = await listen(steel.server);
    gate = createSteelGate({ token: TOKEN, upstreamHost: '127.0.0.1', upstreamPort });
    gatePort = await listen(gate);
  });

  afterEach(async () => {
    await close(gate);
    await close(steel.server);
  });

  test('a request without the token never reaches Steel', async () => {
    const results = await Promise.all([
      fetch(`http://127.0.0.1:${gatePort}/v1/sessions`),
      fetch(`http://127.0.0.1:${gatePort}/v1/sessions`, { headers: { Authorization: 'Bearer wrong' } }),
      fetch(`http://127.0.0.1:${gatePort}/v1/sessions/s1/context`, { headers: { Authorization: TOKEN } }),
    ]);
    expect(results.map((res) => res.status)).toEqual([401, 401, 401]);
    expect(steel.seen).toEqual([]);
  });

  test('a request with the token is forwarded, without the credential', async () => {
    const res = await fetch(`http://127.0.0.1:${gatePort}/v1/sessions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ persist: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sessions: [{ id: 's1', status: 'live' }] });
    expect(steel.seen).toHaveLength(1);
    expect(steel.seen[0]).toMatchObject({ method: 'POST', url: '/v1/sessions', body: '{"persist":true}' });
    expect(steel.seen[0].headers.authorization).toBeUndefined();
    expect(steel.seen[0].headers.host).toMatch(/^127\.0\.0\.1:\d+$/);
    // Nothing about the inside of the pod comes back out.
    expect(res.headers.get('host')).toBeNull();
    expect(res.headers.get('x-steel-hop')).toBeNull();
  });

  test('/healthz is open and reports only whether Steel is healthy', async () => {
    const ok = await fetch(`http://127.0.0.1:${gatePort}/healthz`);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('');
    await close(gate);
    await close(steel.server);
    steel = fakeSteel({ healthStatus: 503 });
    const upstreamPort = await listen(steel.server);
    gate = createSteelGate({ token: TOKEN, upstreamHost: '127.0.0.1', upstreamPort });
    gatePort = await listen(gate);
    expect((await fetch(`http://127.0.0.1:${gatePort}/healthz`)).status).toBe(503);
  });

  test('/healthz is 503 when Steel is not listening', async () => {
    await close(steel.server);
    steel = fakeSteel();
    await listen(steel.server);
    const dead = createSteelGate({ token: TOKEN, upstreamHost: '127.0.0.1', upstreamPort: 1 });
    const deadPort = await listen(dead);
    expect((await fetch(`http://127.0.0.1:${deadPort}/healthz`)).status).toBe(503);
    await close(dead);
  });

  test('a WebSocket upgrade without the token is refused before Steel sees it', async () => {
    const reply = await rawUpgrade(gatePort, ['Authorization: Bearer wrong']);
    expect(reply).toMatch(/^HTTP\/1\.1 401 Unauthorized/);
    expect(steel.seen).toEqual([]);
  });

  test('a WebSocket upgrade with the token is piped to Steel, without the credential', async () => {
    const reply = await rawUpgrade(gatePort, [`Authorization: Bearer ${TOKEN}`, 'Sec-WebSocket-Version: 13'], 'cdp-frame');
    expect(reply).toMatch(/^HTTP\/1\.1 101 Switching Protocols/);
    expect(reply.endsWith('cdp-frame')).toBe(true);
    expect(steel.seen).toHaveLength(1);
    expect(steel.seen[0]).toMatchObject({ upgrade: true, url: '/' });
    expect(steel.seen[0].headers.authorization).toBeUndefined();
    expect(steel.seen[0].headers['sec-websocket-version']).toBe('13');
  });
});
