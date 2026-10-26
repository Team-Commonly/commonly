/**
 * A per-spawn loopback CONNECT proxy that reaches only a fixed list of hosts.
 *
 * A confined run gets no outbound network of its own (Seatbelt `network:
 * 'loopback'`); HTTPS_PROXY points it here. Only CONNECT to an allowlisted
 * name on an allowlisted port is opened, and the name is resolved here and
 * the connection made to the address resolved, so a name that resolves to
 * loopback or a private network is refused rather than followed. Plain HTTP
 * requests are refused: the proxy never sees the content of what it carries.
 *
 * There is no proxy credential. Everything the proxy reaches, any process on
 * the host already reaches; it gives the confined run a route, not authority.
 */
import { createServer } from 'http';
import { BlockList, connect, isIP } from 'net';
import { lookup } from 'dns/promises';

export const GITHUB_HOSTS = Object.freeze([
  'github.com',
  'api.github.com',
  'codeload.github.com',
  'objects.githubusercontent.com',
]);

const CONNECT_TIMEOUT_MS = 10_000;
const MAX_REFUSALS_KEPT = 20;

const nonPublic = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) nonPublic.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96],
]) nonPublic.addSubnet(address, prefix, 'ipv6');

/** True for an address no public host name should resolve to. */
export const isNonPublicAddress = (address) => {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return nonPublic.check(mapped[1], 'ipv4');
  const family = isIP(address);
  if (!family) return true;
  return nonPublic.check(address, family === 6 ? 'ipv6' : 'ipv4');
};

/** `host:port` from a CONNECT target, or null when it is not one. */
const parseTarget = (target) => {
  const match = /^([A-Za-z0-9.-]+):(\d{1,5})$/.exec(target || '');
  if (!match) return null;
  const port = Number(match[2]);
  if (port < 1 || port > 65535) return null;
  return { host: match[1].toLowerCase().replace(/\.$/, ''), port };
};

/**
 * startEgressProxy({ allowHosts?, allowPorts? }) → { port, url, refusals, close }
 *
 * Listens on 127.0.0.1 at an ephemeral port. `_resolve` and `_allowPrivate`
 * exist for tests only, so a test can reach a loopback upstream.
 */
export const startEgressProxy = async ({
  allowHosts = GITHUB_HOSTS,
  allowPorts = [443],
  _resolve = (host) => lookup(host, { all: true, verbatim: true }),
  _allowPrivate = false,
} = {}) => {
  const hosts = new Set(allowHosts.map((host) => String(host).toLowerCase()));
  const ports = new Set(allowPorts);
  if (!hosts.size || [...ports].some((port) => !Number.isInteger(port) || port < 1 || port > 65535)) {
    throw new Error('Egress proxy needs at least one host and valid TCP ports');
  }
  const refusals = [];
  let opened = 0;
  const refuse = (socket, status, target, reason) => {
    refusals.push({ target, reason });
    if (refusals.length > MAX_REFUSALS_KEPT) refusals.shift();
    if (!socket.destroyed) socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  };
  const sockets = new Set();
  const track = (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  };

  const server = createServer((incoming, outgoing) => {
    incoming.resume();
    refusals.push({ target: String(incoming.url || '').slice(0, 200), reason: 'not CONNECT' });
    if (refusals.length > MAX_REFUSALS_KEPT) refusals.shift();
    outgoing.writeHead(405, { Connection: 'close' }).end();
  });
  server.on('connection', track);
  server.on('connect', async (request, client, head) => {
    client.on('error', () => {});
    const target = parseTarget(request.url);
    const label = String(request.url || '').slice(0, 200);
    if (!target) { refuse(client, '400 Bad Request', label, 'malformed target'); return; }
    if (isIP(target.host)) { refuse(client, '403 Forbidden', label, 'address literal'); return; }
    if (!hosts.has(target.host) || !ports.has(target.port)) {
      refuse(client, '403 Forbidden', label, 'not allowlisted');
      return;
    }
    let addresses;
    try {
      addresses = (await _resolve(target.host)).map((entry) => entry.address);
    } catch {
      refuse(client, '502 Bad Gateway', label, 'did not resolve');
      return;
    }
    // Every address must be public, not just the one used: a name that
    // resolves to both is not one this proxy was asked to reach.
    if (!addresses.length || (!_allowPrivate && addresses.some(isNonPublicAddress))) {
      refuse(client, '403 Forbidden', label, 'resolves to a non-public address');
      return;
    }
    if (client.destroyed) return;
    const upstream = connect({ host: addresses[0], port: target.port });
    track(upstream);
    let established = false;
    client.on('close', () => upstream.destroy());
    upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy());
    upstream.on('error', () => {});
    upstream.on('close', () => {
      if (established) client.destroy();
      else refuse(client, '502 Bad Gateway', label, 'upstream unreachable');
    });
    upstream.once('connect', () => {
      upstream.setTimeout(0);
      established = true;
      opened += 1;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    /** { opened, refusals: [{ target, reason }] } — the last 20 refusals. */
    stats: () => ({ opened, refusals: refusals.map((entry) => ({ ...entry })) }),
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const socket of sockets) socket.destroy();
      await closed;
    },
  };
};
