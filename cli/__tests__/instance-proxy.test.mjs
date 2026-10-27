import { createServer } from 'http';
import { connect } from 'net';
import { once } from 'events';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { startInstanceProxy } from '../src/lib/instance-proxy.js';

test.each(['client disconnect', 'proxy shutdown'])(
  '%s cancels a pending instance request', async (ending) => {
  const root = await mkdtemp(join(tmpdir(), 'commonly-instance-proxy-'));
  const upstreamSockets = new Set();
  let received;
  const hit = new Promise((resolve) => { received = resolve; });
  const target = createServer(() => { received(); });
  target.on('connection', (socket) => {
    upstreamSockets.add(socket);
    socket.on('close', () => upstreamSockets.delete(socket));
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const socketPath = join(root, 'instance.sock');
  let proxy;
  try {
    proxy = await startInstanceProxy({
      instanceUrl: `http://127.0.0.1:${target.address().port}`,
      socketPath,
    });
    expect((await stat(socketPath)).mode & 0o777).toBe(0o600);
    const client = connect(socketPath);
    await once(client, 'connect');
    client.write('GET /api/agents/runtime/pods/probe/context HTTP/1.1\r\nHost: proxy\r\n\r\n');
    await hit;
    if (ending === 'client disconnect') {
      const closed = once(client, 'close');
      client.destroy();
      await closed;
    } else {
      await proxy.close();
      proxy = null;
      client.destroy();
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(upstreamSockets.size).toBe(0);
  } finally {
    await proxy?.close();
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
  },
);

test('closes the downstream client when an upstream response ends incomplete', async () => {
  const root = await mkdtemp(join(tmpdir(), 'commonly-instance-proxy-'));
  const target = createServer((_request, response) => {
    response.writeHead(200, { 'content-length': '100' });
    response.write('partial');
    setTimeout(() => response.destroy(), 25);
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  let proxy;
  let client;
  let timeout;
  try {
    proxy = await startInstanceProxy({
      instanceUrl: `http://127.0.0.1:${target.address().port}`,
      socketPath: join(root, 'instance.sock'),
    });
    client = connect(proxy.socketPath);
    await once(client, 'connect');
    const closed = new Promise((resolve) => client.once('close', () => resolve(true)));
    client.write('GET /v1/models HTTP/1.1\r\nHost: proxy\r\n\r\n');
    await once(client, 'data');
    const timedOut = new Promise((resolve) => { timeout = setTimeout(() => resolve(false), 500); });
    expect(await Promise.race([closed, timedOut])).toBe(true);
  } finally {
    clearTimeout(timeout);
    client?.destroy();
    await proxy?.close();
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});

test('without a socket path the relay listens on a loopback port to the same origin', async () => {
  let seen;
  const target = createServer((request, response) => {
    seen = { path: request.url, host: request.headers.host, proxyAuth: request.headers['proxy-authorization'] };
    response.end('ok');
  });
  await new Promise((resolve) => target.listen(0, '127.0.0.1', resolve));
  const origin = `127.0.0.1:${target.address().port}`;
  let proxy;
  try {
    proxy = await startInstanceProxy({ instanceUrl: `http://${origin}` });
    expect(proxy.socketPath).toBeNull();
    expect(proxy.url).toBe(`http://127.0.0.1:${proxy.port}`);
    const response = await fetch(`${proxy.url}/api/agents/runtime/pods/p/context`, {
      headers: { 'proxy-authorization': 'Basic x' },
    });
    expect(await response.text()).toBe('ok');
    expect(seen).toEqual({ path: '/api/agents/runtime/pods/p/context', host: origin, proxyAuth: undefined });
    // An absolute-form target is refused, not followed to another origin.
    const client = connect(proxy.port, '127.0.0.1');
    await once(client, 'connect');
    client.write('GET //elsewhere.example/ HTTP/1.1\r\nHost: x\r\n\r\n');
    const [chunk] = await once(client, 'data');
    expect(String(chunk)).toMatch(/^HTTP\/1\.1 400/);
    client.destroy();
  } finally {
    await proxy?.close();
    target.closeAllConnections();
    await new Promise((resolve) => target.close(resolve));
  }
});
