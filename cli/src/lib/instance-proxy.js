/**
 * A per-spawn relay to one declared Commonly instance origin, on a Unix
 * socket, or on an ephemeral loopback TCP port when no socketPath is given
 * (for a Seatbelt run whose only network is loopback).
 */
import { createServer, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import { chmod, unlink } from 'fs/promises';

export const startInstanceProxy = async ({ instanceUrl, socketPath }) => {
  const target = new URL(instanceUrl);
  if (!['http:', 'https:'].includes(target.protocol)
    || target.username || target.password || target.search || target.hash
    || target.pathname !== '/') {
    throw new Error('Commonly instance proxy requires a bare http(s) origin');
  }
  const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
  const upstreams = new Set();
  const server = createServer((incoming, outgoing) => {
    const path = incoming.url || '';
    if (!path.startsWith('/') || path.startsWith('//')
      || incoming.method === 'CONNECT' || incoming.headers.upgrade) {
      incoming.resume();
      outgoing.writeHead(400).end();
      return;
    }
    const headers = { ...incoming.headers, host: target.host };
    delete headers.connection;
    delete headers['proxy-authorization'];
    delete headers['proxy-connection'];
    const upstream = transport(target, {
      method: incoming.method,
      path,
      headers,
    }, (response) => {
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.pipe(outgoing);
      response.on('error', () => outgoing.destroy());
      response.on('close', () => {
        if (!response.complete) outgoing.destroy();
      });
    });
    upstreams.add(upstream);
    upstream.on('close', () => upstreams.delete(upstream));
    outgoing.on('close', () => upstream.destroy());
    upstream.on('error', () => {
      if (outgoing.destroyed) return;
      if (!outgoing.headersSent) outgoing.writeHead(502);
      outgoing.end();
    });
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    const listening = () => {
      server.removeListener('error', reject);
      resolve();
    };
    if (socketPath) server.listen(socketPath, listening);
    else server.listen(0, '127.0.0.1', listening);
  });
  if (socketPath) await chmod(socketPath, 0o600);
  const port = socketPath ? null : server.address().port;
  return {
    socketPath: socketPath || null,
    port,
    url: port ? `http://127.0.0.1:${port}` : null,
    close: async () => {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const upstream of upstreams) upstream.destroy();
      server.closeAllConnections();
      await closed;
      if (socketPath) await unlink(socketPath).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    },
  };
};
