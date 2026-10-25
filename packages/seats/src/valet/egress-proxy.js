/**
 * The one way out of a sandboxed run. Seatbelt can only name a remote host
 * as `localhost` or `*` (sandbox-exec rejects a DNS name in a network rule),
 * and bwrap's --unshare-net leaves no route at all, so neither can hold a
 * hostname allowlist itself. Instead the sandbox admits one loopback port,
 * and on it this HTTP CONNECT proxy, running in the supervising process
 * outside the sandbox, opens a tunnel only to a host:port the allowlist names.
 *
 * Decisions, in order, for each request:
 *   - CONNECT only. A plain-HTTP absolute-URI request (GET http://x/) is
 *     refused with 405 rather than forwarded: forwarding means parsing and
 *     relaying the request itself, headers and body, and every provider worth
 *     fencing speaks TLS. A client sending plain HTTP through the proxy
 *     therefore fails closed.
 *   - the target must be a host name, never an IP literal (the grant cannot
 *     name an address, so no address can be allowed);
 *   - host:port must match the allowlist (case-insensitive, trailing dot
 *     dropped; a wildcard never matches its bare suffix);
 *   - the name is resolved here, not by the run, and a name that resolves to
 *     a loopback, link-local, private or otherwise non-public address is
 *     refused unless an exact (non-wildcard) entry names it. That stops a
 *     wildcard-allowed name being pointed at the host's own services (DNS
 *     rebinding). The tunnel connects to the address that was checked, so a
 *     second lookup cannot swap it.
 *   - `localhost` and `*.localhost` resolve to 127.0.0.1 without asking a
 *     resolver (RFC 6761 6.3), the same on every platform.
 *
 * Trace: egress.allowed {host, port} when a tunnel opens, egress.denied
 * {host, port, reason} otherwise. Never a header, a body or an address. A host
 * holding one of the `redact` values (the run's credentials) is traced as
 * [redacted], so a run cannot write its key into the trace by asking for
 * <key>.example.com.
 */
import { BlockList, connect, createServer, isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { traceOf } from '../trace/events.js';
import { isHostName, matchEgress, normalizeHost, parseEgressEntry } from './grant.js';

export const DEFAULT_IDLE_MS = 2 * 60 * 1000;
const MAX_HEAD_BYTES = 16 * 1024;
export const EGRESS_DENIAL_REASONS = Object.freeze([
  'bad_request', 'not_connect', 'ip_literal', 'not_allowed', 'unresolved', 'private_address', 'unreachable',
]);

// Every range a public service does not live in. IPv4-mapped IPv6
// (::ffff:a.b.c.d) is checked against the IPv4 ranges by BlockList itself.
const NON_PUBLIC = (() => {
  const list = new BlockList();
  for (const [net, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
    ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
  ]) list.addSubnet(net, prefix, 'ipv4');
  for (const [net, prefix] of [
    ['::', 128], ['::1', 128], ['::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001:db8::', 32],
    ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
  ]) list.addSubnet(net, prefix, 'ipv6');
  return list;
})();

/** True for any address that is not a public unicast one. */
export const isNonPublicAddress = (address) => {
  const family = isIP(address);
  if (family === 0) return true;
  return NON_PUBLIC.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

const isLocalhostName = (host) => host === 'localhost' || host.endsWith('.localhost');

/** `host:port` or `[v6]:port` → { host, port } | null. */
const parseTarget = (target) => {
  const bracketed = /^\[([^\]]+)\]:(\d{1,5})$/.exec(target);
  const match = bracketed || /^([^:]+):(\d{1,5})$/.exec(target);
  if (!match) return null;
  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: bracketed ? match[1] : normalizeHost(match[1]), port };
};

/** The host and port an absolute-URI request names, for the trace only. */
const absoluteTarget = (uri) => {
  try {
    const url = new URL(uri);
    const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
    return { host: normalizeHost(url.hostname.replace(/^\[|\]$/g, '')), port };
  } catch {
    return null;
  }
};

const reply = (socket, status, text) => {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
};

/**
 * startEgressProxy({ allow, trace?, ctx?, socketPath?, idleMs?, redact?, lookup? })
 *   → Promise<{ port, socketPath, close }>
 *
 * `allow` is network.allow entries, as strings or as parseEgressEntry's
 * result. Listens on 127.0.0.1 at an ephemeral port, or on the Unix socket
 * `socketPath` when given (the bwrap route); exactly one of port and
 * socketPath is set. `idleMs` closes a tunnel or a half-sent request that
 * moves no bytes for that long. `lookup` is dns.lookup's shape, for tests.
 * close() stops listening and destroys every open tunnel.
 */
export const startEgressProxy = async ({
  allow = [], trace, ctx, socketPath, idleMs = DEFAULT_IDLE_MS, redact = [], lookup = dnsLookup,
} = {}) => {
  const rules = Object.freeze(allow.map((entry, i) => (typeof entry === 'string'
    ? parseEgressEntry(entry, `allow[${i}]`)
    : parseEgressEntry(entry?.entry, `allow[${i}]`))));
  const hook = trace && typeof trace.emit === 'function' ? trace : traceOf(ctx);
  const secrets = redact.filter((value) => typeof value === 'string' && value.length >= 4).map((value) => value.toLowerCase());
  const traced = (host) => (host && secrets.some((secret) => host.toLowerCase().includes(secret)) ? '[redacted]' : host);
  const sockets = new Set();
  let closed = false;

  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(idleMs, () => socket.destroy());
    return socket;
  };

  const deny = (client, target, reason, status = 403, text = 'Forbidden') => {
    hook.emit('egress.denied', { host: traced(target?.host ?? null), port: target?.port ?? null, reason });
    reply(client, status, text);
  };

  const resolve = (host) => new Promise((done) => {
    if (isLocalhostName(host)) { done(['127.0.0.1']); return; }
    lookup(host, { all: true }, (error, addresses) => {
      done(error || !Array.isArray(addresses) ? [] : addresses.map((entry) => entry.address));
    });
  });

  const tunnel = async (client, target, rest) => {
    if (isIP(target.host)) { deny(client, target, 'ip_literal'); return; }
    if (!isHostName(target.host)) { deny(client, null, 'bad_request', 400, 'Bad Request'); return; }
    const hit = matchEgress(rules, target.host, target.port);
    if (!hit) { deny(client, target, 'not_allowed'); return; }
    const addresses = await resolve(target.host);
    if (closed || client.destroyed) return;
    if (addresses.length === 0) { deny(client, target, 'unresolved', 502, 'Bad Gateway'); return; }
    if (!hit.exact && addresses.some(isNonPublicAddress)) { deny(client, target, 'private_address'); return; }
    const upstream = track(connect({ host: addresses[0], port: target.port }));
    let opened = false;
    upstream.once('error', () => {
      if (!opened && !client.destroyed) deny(client, target, 'unreachable', 502, 'Bad Gateway');
    });
    upstream.once('connect', () => {
      if (closed || client.destroyed) { upstream.destroy(); return; }
      opened = true;
      hook.emit('egress.allowed', { host: traced(target.host), port: target.port });
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) upstream.write(rest);
      client.pipe(upstream).pipe(client);
      client.on('close', () => upstream.destroy());
      upstream.on('close', () => client.destroy());
      client.resume();
    });
  };

  const route = (client, head, rest) => {
    const line = /^([A-Z]+) (\S+) HTTP\/1\.[01]$/.exec(head.split('\r\n')[0]);
    if (!line) { deny(client, null, 'bad_request', 400, 'Bad Request'); return; }
    const [, method, target] = line;
    if (method !== 'CONNECT') {
      deny(client, absoluteTarget(target), 'not_connect', 405, 'Method Not Allowed');
      return;
    }
    const parsed = parseTarget(target);
    if (!parsed) { deny(client, null, 'bad_request', 400, 'Bad Request'); return; }
    tunnel(client, parsed, rest).catch(() => client.destroy());
  };

  const server = createServer((client) => {
    if (closed) { client.destroy(); return; }
    track(client);
    let head = Buffer.alloc(0);
    const onData = (chunk) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        if (head.length > MAX_HEAD_BYTES) { client.off('data', onData); deny(client, null, 'bad_request', 431, 'Request Header Fields Too Large'); }
        return;
      }
      client.off('data', onData);
      client.pause();
      route(client, head.subarray(0, end).toString('latin1'), head.subarray(end + 4));
    };
    client.on('data', onData);
  });

  await new Promise((done, fail) => {
    server.once('error', fail);
    if (socketPath) server.listen(socketPath, done);
    else server.listen(0, '127.0.0.1', done);
  });

  const close = () => new Promise((done) => {
    if (closed) { done(); return; }
    closed = true;
    for (const socket of sockets) socket.destroy();
    server.close(() => done());
  });
  return Object.freeze({ port: socketPath ? null : server.address().port, socketPath: socketPath || null, close });
};

/**
 * A Unix socket that forwards every connection to one fixed loopback origin.
 * Under bwrap a run cannot reach the host's loopback, so a provider that
 * listens there (a local model server) is reached through this, bridged into
 * the namespace by loopback-bridge.mjs. It takes no request and makes no
 * choice: the origin is fixed when it starts.
 */
export const startLoopbackRelay = async ({ socketPath, host, port, idleMs = DEFAULT_IDLE_MS }) => {
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    socket.setTimeout(idleMs, () => socket.destroy());
    return socket;
  };
  const server = createServer((local) => {
    track(local);
    const upstream = track(connect({ host, port }));
    local.pipe(upstream).pipe(local);
    local.on('close', () => upstream.destroy());
    upstream.on('close', () => local.destroy());
  });
  await new Promise((done, fail) => {
    server.once('error', fail);
    server.listen(socketPath, done);
  });
  return Object.freeze({
    socketPath,
    close: () => new Promise((done) => {
      for (const socket of sockets) socket.destroy();
      server.close(() => done());
    }),
  });
};
