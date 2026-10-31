import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// `npm run dev:live` (TASK-686) proxies /api to a real backend. These run the
// real vite.config.ts against a local stub backend (DEV_LIVE_UPSTREAM), so the
// assertions see exactly what would have reached the upstream. A refusal that
// failed open would show up as a recorded request on the stub.

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = resolve(frontendDir, 'vite.config.ts');

async function startStub() {
  const seen = [];
  const stub = createHttpServer((req, res) => {
    seen.push({ method: req.method, url: req.url, origin: req.headers.origin });
    res.setHeader('content-type', 'application/json');
    res.end('{"stub":true}');
  });
  await new Promise((ok) => stub.listen(0, '127.0.0.1', ok));
  return { seen, url: `http://127.0.0.1:${stub.address().port}`, close: () => new Promise((ok) => stub.close(ok)) };
}

async function withDevLive(env, fn) {
  const keys = ['DEV_LIVE', 'DEV_LIVE_TARGET', 'DEV_LIVE_UPSTREAM'];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, env);
  let server;
  try {
    server = await createServer({ configFile, logLevel: 'silent', server: { host: '127.0.0.1' } });
    await server.listen();
    const port = server.httpServer.address().port;
    return await fn(`http://127.0.0.1:${port}`, port);
  } finally {
    await server?.close();
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

test('prod read-only refuses every HTTP write locally, without an upstream call', async () => {
  const stub = await startStub();
  try {
    await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'prod', DEV_LIVE_UPSTREAM: stub.url }, async (base) => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const res = await fetch(`${base}/api/auth/login`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: method === 'DELETE' ? undefined : '{}',
        });
        assert.equal(res.status, 404, `${method} /api/* must be refused locally`);
        assert.notEqual(res.headers.get('content-type')?.includes('application/json'), true, `${method} must not carry a backend JSON body`);
      }
    });
    assert.deepEqual(stub.seen, [], 'a refused write must never reach the upstream');
  } finally {
    await stub.close();
  }
});

test('prod read-only still proxies GET reads', async () => {
  const stub = await startStub();
  try {
    await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'prod', DEV_LIVE_UPSTREAM: stub.url }, async (base) => {
      const res = await fetch(`${base}/api/health`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '{"stub":true}');
    });
    assert.deepEqual(stub.seen.map((r) => r.method), ['GET']);
  } finally {
    await stub.close();
  }
});

test('prod read-only does not proxy the socket path', async () => {
  const stub = await startStub();
  try {
    await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'prod', DEV_LIVE_UPSTREAM: stub.url }, async (base) => {
      // Vite answers with its SPA fallback (HTML), not an engine.io handshake.
      const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
      const body = await res.text();
      assert.doesNotMatch(body, /"sid"/, '/socket.io must not reach prod in read-only mode');
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    });
    assert.deepEqual(stub.seen, [], 'the socket path must not reach the upstream');
  } finally {
    await stub.close();
  }
});

test('staging proxies writes to the upstream with the browser Origin dropped', async () => {
  const stub = await startStub();
  try {
    await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'staging', DEV_LIVE_UPSTREAM: stub.url }, async (base) => {
      const res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: 'http://localhost:3102' },
        body: '{}',
      });
      assert.equal(res.status, 200);
    });
    assert.equal(stub.seen.length, 1);
    assert.equal(stub.seen[0].method, 'POST');
    assert.equal(stub.seen[0].origin, undefined, 'the proxy must drop the browser Origin');
  } finally {
    await stub.close();
  }
});

test('each target listens on its own port, so localStorage cannot cross targets', async () => {
  const stub = await startStub();
  try {
    await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'prod', DEV_LIVE_UPSTREAM: stub.url }, async (_base, port) => {
      assert.equal(port, 3101);
    });
    await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'staging', DEV_LIVE_UPSTREAM: stub.url }, async (_base, port) => {
      assert.equal(port, 3102);
    });
  } finally {
    await stub.close();
  }
});

test('an unknown DEV_LIVE_TARGET fails the config load instead of falling through', async () => {
  await assert.rejects(
    withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'nowhere' }, async () => {}),
    /DEV_LIVE_TARGET must be one of: staging, prod/,
  );
});
