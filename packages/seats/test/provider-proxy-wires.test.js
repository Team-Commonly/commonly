import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Agent, createServer, request as httpRequest } from 'node:http';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROVIDER_WIRES, startProviderProxy } from '../src/wire/provider-proxy.js';

const KEY = 'sk-ant-real-0123456789abcdefghij';

// A fake provider that records each request and answers 200 with what it saw.
const startUpstream = async () => {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: req.url }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((resolve) => server.close(resolve)) };
};

const call = (baseURL, method, path, headers = {}, body, agent = undefined) => new Promise((resolve, reject) => {
  const url = new URL(path, baseURL);
  const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, method, headers, agent }, (res) => {
    let text = '';
    res.on('data', (chunk) => { text += chunk; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  req.end(body);
});

const withProxy = async (wire, basePath, fn) => {
  const upstream = await startUpstream();
  const proxy = await startProviderProxy({ provider: { baseURL: `${upstream.url}${basePath}` }, keyMaterial: KEY, wire, adapterLabel: 'Test' });
  try { return await fn({ upstream, proxy }); } finally {
    await proxy.close();
    await upstream.close();
  }
};

test('the wires are the three the route table names', () => {
  assert.deepEqual([...PROVIDER_WIRES], ['openai-chat', 'anthropic-messages', 'openai-responses']);
});

test('an unknown wire is refused before anything listens', async () => {
  await assert.rejects(startProviderProxy({ provider: { baseURL: 'http://127.0.0.1:9' }, keyMaterial: KEY, wire: 'gemini' }), /wire must be one of/);
});

test('anthropic-messages: the token arrives as x-api-key and the real key leaves as x-api-key', () => withProxy('anthropic-messages', '', async ({ upstream, proxy }) => {
  const res = await call(proxy.baseURL, 'POST', '/v1/messages', {
    'x-api-key': proxy.token, 'anthropic-version': '2023-06-01', 'content-type': 'application/json',
  }, '{"model":"m","max_tokens":1,"messages":[]}');
  assert.equal(res.status, 200);
  assert.equal(upstream.seen.length, 1);
  const { headers, url, body } = upstream.seen[0];
  assert.equal(url, '/v1/messages');
  assert.equal(headers['x-api-key'], KEY);
  assert.equal(headers.authorization, undefined, 'no Bearer goes out on the Anthropic wire');
  assert.equal(headers['anthropic-version'], '2023-06-01');
  assert.equal(body, '{"model":"m","max_tokens":1,"messages":[]}');
}));

test('anthropic-messages: a Bearer token is accepted too, and count_tokens and models are routed', () => withProxy('anthropic-messages', '', async ({ upstream, proxy }) => {
  const bearer = { authorization: `Bearer ${proxy.token}` };
  assert.equal((await call(proxy.baseURL, 'POST', '/v1/messages/count_tokens', bearer, '{}')).status, 200);
  assert.equal((await call(proxy.baseURL, 'GET', '/v1/models', bearer)).status, 200);
  assert.deepEqual(upstream.seen.map((r) => [r.method, r.url, r.headers['x-api-key']]), [
    ['POST', '/v1/messages/count_tokens', KEY], ['GET', '/v1/models', KEY],
  ]);
}));

test('a missing or wrong token is 401 in either header, and nothing reaches the provider', () => withProxy('anthropic-messages', '', async ({ upstream, proxy }) => {
  for (const headers of [{}, { 'x-api-key': `${proxy.token}x` }, { 'x-api-key': KEY }, { authorization: proxy.token }, { authorization: `Bearer ${KEY}` }]) {
    assert.equal((await call(proxy.baseURL, 'POST', '/v1/messages', headers, '{}')).status, 401, JSON.stringify(Object.keys(headers)));
  }
  assert.equal(upstream.seen.length, 0);
}));

test('each wire refuses the routes it does not list', () => withProxy('anthropic-messages', '', async ({ upstream, proxy }) => {
  const auth = { 'x-api-key': proxy.token };
  for (const [method, path] of [['POST', '/v1/messages/batches'], ['POST', '/v1/chat/completions'], ['GET', '/v1/messages'], ['POST', '/v1/complete']]) {
    assert.equal((await call(proxy.baseURL, method, path, auth, '{}')).status, 403, `${method} ${path}`);
  }
  assert.equal(upstream.seen.length, 0);
}));

// #2766: a refusal answered before the body was read left the socket
// reusable, and the next request on it was reset (ECONNRESET in CI). One
// keep-alive socket, a body larger than one read, every wire.
test('a keep-alive client gets a 403 on each refused request, never a reset, on every wire', async () => {
  const body = JSON.stringify({ pad: 'x'.repeat(256 * 1024) });
  for (const wire of PROVIDER_WIRES) {
    // eslint-disable-next-line no-await-in-loop
    await withProxy(wire, '/v1', async ({ upstream, proxy }) => {
      const agent = new Agent({ keepAlive: true, maxSockets: 1 });
      const auth = { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' };
      try {
        for (let i = 0; i < 6; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          const refused = await call(proxy.baseURL, 'POST', '/v1/messages/batches', auth, body, agent);
          assert.equal(refused.status, 403, `${wire} request ${i}`);
          assert.equal(refused.headers.connection, 'close', `${wire} request ${i}`);
        }
      } finally {
        agent.destroy();
      }
      assert.equal(upstream.seen.length, 0);
    });
  }
});

test('openai-responses: POST responses and GET models under the base path, Bearer out; chat/completions refused', () => withProxy('openai-responses', '/v1', async ({ upstream, proxy }) => {
  const auth = { authorization: `Bearer ${proxy.token}` };
  assert.equal((await call(proxy.baseURL, 'POST', '/v1/responses', auth, '{}')).status, 200);
  assert.equal((await call(proxy.baseURL, 'GET', '/v1/models', auth)).status, 200);
  assert.equal((await call(proxy.baseURL, 'POST', '/v1/chat/completions', auth, '{}')).status, 403);
  assert.deepEqual(upstream.seen.map((r) => [r.method, r.url, r.headers.authorization, r.headers['x-api-key']]), [
    ['POST', '/v1/responses', `Bearer ${KEY}`, undefined], ['GET', '/v1/models', `Bearer ${KEY}`, undefined],
  ]);
}));

test('openai-chat stays the default: chat/completions and models only, Bearer out', () => withProxy(undefined, '/v1', async ({ upstream, proxy }) => {
  const auth = { authorization: `Bearer ${proxy.token}` };
  assert.equal((await call(proxy.baseURL, 'POST', '/v1/chat/completions', auth, '{}')).status, 200);
  assert.equal((await call(proxy.baseURL, 'POST', '/v1/responses', auth, '{}')).status, 403);
  assert.equal(upstream.seen[0].headers.authorization, `Bearer ${KEY}`);
  assert.equal(upstream.seen.length, 1);
}));

test('a WebSocket upgrade gets 426, so the client falls back to HTTP, and nothing reaches the provider', () => withProxy('openai-responses', '/v1', async ({ upstream, proxy }) => {
  const port = new URL(proxy.baseURL).port;
  const reply = await new Promise((resolve, reject) => {
    const socket = connect(Number(port), '127.0.0.1', () => {
      socket.write(`GET /v1/responses HTTP/1.1\r\nhost: 127.0.0.1\r\nauthorization: Bearer ${proxy.token}\r\nconnection: Upgrade\r\nupgrade: websocket\r\nsec-websocket-version: 13\r\nsec-websocket-key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
    });
    let text = '';
    socket.on('data', (chunk) => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
  });
  assert.match(reply, /^HTTP\/1\.1 426 /);
  assert.equal(upstream.seen.length, 0);
}));

test('without a tokenFile the proxy writes no file and hands the token back in memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-proxy-'));
  try {
    const proxy = await startProviderProxy({ provider: { baseURL: 'http://127.0.0.1:9/v1' }, keyMaterial: KEY });
    try {
      assert.match(proxy.token, /^[A-Za-z0-9_-]{43}$/);
      assert.equal(proxy.tokenFile, undefined);
    } finally { await proxy.close(); }
    const withFile = await startProviderProxy({ provider: { baseURL: 'http://127.0.0.1:9/v1' }, keyMaterial: KEY, tokenFile: join(dir, 'token') });
    try { assert.ok(existsSync(join(dir, 'token'))); } finally { await withFile.close(); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
