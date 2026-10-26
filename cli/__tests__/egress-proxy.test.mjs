import { once } from 'events';
import { connect, createServer } from 'net';

import { GITHUB_CONTENT_HOSTS, isNonPublicAddress, startEgressProxy } from '../src/lib/egress-proxy.js';

// A raw CONNECT through the proxy; resolves with the status line and the socket.
const tunnel = async (port, target) => {
  const socket = connect(port, '127.0.0.1');
  await once(socket, 'connect');
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  let buffered = '';
  while (!buffered.includes('\r\n\r\n')) {
    const [chunk] = await once(socket, 'data');
    buffered += String(chunk);
  }
  return { status: buffered.split('\r\n')[0], rest: buffered.slice(buffered.indexOf('\r\n\r\n') + 4), socket };
};

describe('egress proxy', () => {
  let upstream;
  let upstreamPort;
  let proxy;

  beforeEach(async () => {
    // An echo server standing in for an allowlisted host.
    upstream = createServer((socket) => socket.pipe(socket));
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    upstreamPort = upstream.address().port;
  });

  afterEach(async () => {
    await proxy?.close();
    proxy = null;
    await new Promise((resolve) => upstream.close(resolve));
  });

  const start = (options = {}) => startEgressProxy({
    allowHosts: ['allowed.test'],
    allowPorts: [upstreamPort],
    _resolve: async () => [{ address: '127.0.0.1' }],
    _allowPrivate: true,
    ...options,
  });

  test('opens a tunnel to an allowlisted host and port', async () => {
    proxy = await start();
    const { status, socket } = await tunnel(proxy.port, `allowed.test:${upstreamPort}`);
    expect(status).toBe('HTTP/1.1 200 Connection Established');
    socket.write('ping');
    const [echo] = await once(socket, 'data');
    expect(String(echo)).toBe('ping');
    socket.destroy();
    expect(proxy.stats()).toEqual({ opened: 1, refusals: [] });
  });

  test.each([
    ['a host not on the list', () => 'other.test:PORT', 'not allowlisted'],
    ['an allowlisted host on another port', () => 'allowed.test:22', 'not allowlisted'],
    ['an address literal', () => '127.0.0.1:PORT', 'address literal'],
    ['a malformed target', () => 'allowed.test', 'malformed target'],
  ])('refuses %s', async (_label, target, reason) => {
    proxy = await start();
    const asked = target().replace('PORT', String(upstreamPort));
    const { status, socket } = await tunnel(proxy.port, asked);
    expect(status).toMatch(/^HTTP\/1\.1 (403|400) /);
    socket.destroy();
    expect(proxy.stats()).toEqual({ opened: 0, refusals: [{ target: asked, reason }] });
  });

  test('refuses a name that resolves to a non-public address, even partly', async () => {
    proxy = await start({
      _allowPrivate: false,
      _resolve: async () => [{ address: '140.82.112.3' }, { address: '10.0.0.5' }],
    });
    const { status, socket } = await tunnel(proxy.port, `allowed.test:${upstreamPort}`);
    expect(status).toBe('HTTP/1.1 403 Forbidden');
    socket.destroy();
    expect(proxy.stats().refusals).toEqual([
      { target: `allowed.test:${upstreamPort}`, reason: 'resolves to a non-public address' },
    ]);
  });

  test('refuses plain HTTP requests: it carries tunnels only', async () => {
    proxy = await start();
    const response = await fetch(`${proxy.url}/`, { headers: { host: 'allowed.test' } });
    expect(response.status).toBe(405);
    expect(proxy.stats().opened).toBe(0);
  });

  test('reports an unreachable upstream without opening a tunnel', async () => {
    proxy = await start();
    const closedPort = upstreamPort;
    await new Promise((resolve) => upstream.close(resolve));
    upstream = createServer();
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const { status, socket } = await tunnel(proxy.port, `allowed.test:${closedPort}`);
    expect(status).toBe('HTTP/1.1 502 Bad Gateway');
    socket.destroy();
    expect(proxy.stats().opened).toBe(0);
  });

  test('defaults to GitHub\'s download hosts on 443, and refuses the hosts that take writes', async () => {
    expect(GITHUB_CONTENT_HOSTS).toEqual([
      'codeload.github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com',
    ]);
    proxy = await startEgressProxy({ _resolve: async () => [{ address: '140.82.112.3' }] });
    for (const target of ['api.deepseek.com:443', 'github.com:443', 'api.github.com:443', 'gist.github.com:443', 'uploads.github.com:443']) {
      // eslint-disable-next-line no-await-in-loop
      const { status, socket } = await tunnel(proxy.port, target);
      expect([target, status]).toEqual([target, 'HTTP/1.1 403 Forbidden']);
      socket.destroy();
    }
    expect(proxy.stats().refusals.map((r) => r.reason)).toEqual(Array(5).fill('not allowlisted'));
  });

  test.each([
    ['127.0.0.1', true], ['10.1.2.3', true], ['172.20.0.1', true], ['192.168.1.1', true],
    ['169.254.169.254', true], ['100.64.0.1', true], ['0.0.0.0', true], ['::1', true],
    ['fd00::1', true], ['fe80::1', true], ['::ffff:127.0.0.1', true], ['not-an-ip', true],
    ['140.82.112.3', false], ['185.199.108.133', false], ['2606:50c0:8000::153', false],
  ])('isNonPublicAddress(%s) is %s', (address, expected) => {
    expect(isNonPublicAddress(address)).toBe(expected);
  });
});
