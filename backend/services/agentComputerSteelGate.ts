/**
 * The token gate in front of a person's Steel browser (D244 pilot 2).
 *
 * Steel's API and its CDP WebSocket proxy take no credentials, and the browser
 * behind them holds the person's signed-in session. The gate runs in the same
 * pod (templates/agent-computer/steel.yaml): Steel and Chrome bind to
 * 127.0.0.1 only, and this is the one listener on the pod address. Every HTTP
 * request and WebSocket upgrade must carry `Authorization: Bearer <token>`,
 * which only the backend's broker holds (AGENT_COMPUTER_STEEL_TOKEN). The
 * header is stripped before Steel sees the request.
 *
 * `/healthz` is the one open path: it reports only whether Steel's own health
 * check answers 200, for the kubelet's readiness probe.
 *
 * Runs from the backend image: `node dist/services/agentComputerSteelGate.js`.
 */
import http from 'node:http';
import net from 'node:net';
import { tokenMatches } from './agentComputerWaker';

export type SteelGateConfig = {
  token: string;
  upstreamHost: string;
  upstreamPort: number;
};

// Hop-by-hop headers belong to one connection and are never forwarded, nor is
// any header a Connection header names. The credential stops here, and Host is
// set per direction (only on the way to Steel).
const HOP_BY_HOP = new Set([
  'authorization', 'proxy-authorization', 'connection', 'keep-alive', 'proxy-connection',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'host',
]);

const forwardHeaders = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const named = new Set(String(headers.connection || '').split(',').map((name) => name.trim().toLowerCase()));
  const out: http.OutgoingHttpHeaders = {};
  Object.entries(headers).forEach(([name, value]) => {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !named.has(lower) && value !== undefined) out[name] = value;
  });
  return out;
};

// The upgrade request is re-sent byte by byte, so build it from rawHeaders:
// same order and casing, minus the credential and Host.
const upgradeHead = (req: http.IncomingMessage, upstream: string): string => {
  const lines = [`${req.method} ${req.url} HTTP/1.1`, `Host: ${upstream}`];
  for (let i = 0; i + 1 < req.rawHeaders.length; i += 2) {
    const name = req.rawHeaders[i];
    const lower = name.toLowerCase();
    if (lower !== 'authorization' && lower !== 'proxy-authorization' && lower !== 'host') {
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
};

const reject = (socket: net.Socket, status: string) => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

export const createSteelGate = (config: SteelGateConfig): http.Server => {
  const upstream = `${config.upstreamHost}:${config.upstreamPort}`;
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      const probe = http.get({
        host: config.upstreamHost, port: config.upstreamPort, path: '/v1/health', timeout: 3_000,
      }, (up) => {
        up.resume();
        res.writeHead(up.statusCode === 200 ? 200 : 503, { 'Content-Length': 0 });
        res.end();
      });
      probe.on('timeout', () => probe.destroy(new Error('timeout')));
      probe.on('error', () => {
        if (!res.headersSent) res.writeHead(503, { 'Content-Length': 0 });
        res.end();
      });
      return;
    }
    if (!tokenMatches(req.headers.authorization, config.token)) {
      req.resume();
      res.writeHead(401, { 'Content-Length': 0 });
      res.end();
      return;
    }
    const proxied = http.request({
      host: config.upstreamHost,
      port: config.upstreamPort,
      method: req.method,
      path: req.url,
      headers: { ...forwardHeaders(req.headers), host: upstream },
    }, (up) => {
      res.writeHead(up.statusCode || 502, forwardHeaders(up.headers));
      up.pipe(res);
    });
    proxied.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Length': 0 });
      res.end();
    });
    req.pipe(proxied);
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    socket.on('error', () => socket.destroy());
    if (!tokenMatches(req.headers.authorization, config.token)) {
      reject(socket, '401 Unauthorized');
      return;
    }
    const target = net.connect(config.upstreamPort, config.upstreamHost, () => {
      target.write(upgradeHead(req, upstream));
      if (head.length) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });
    target.on('error', () => {
      if (socket.writable && !target.bytesRead) reject(socket, '502 Bad Gateway');
      else socket.destroy();
    });
    socket.on('close', () => target.destroy());
    target.on('close', () => socket.destroy());
  });
  return server;
};

if (require.main === module) {
  const token = String(process.env.STEEL_GATE_TOKEN || '');
  const upstreamPort = Number(process.env.STEEL_UPSTREAM_PORT || 3001);
  const port = Number(process.env.PORT || 3000);
  if (!token) {
    console.error('[steel-gate] STEEL_GATE_TOKEN is required');
    process.exit(1);
  }
  createSteelGate({ token, upstreamHost: '127.0.0.1', upstreamPort }).listen(port, () => {
    console.log(`[steel-gate] listening on ${port}, forwarding to 127.0.0.1:${upstreamPort}`);
  });
}
