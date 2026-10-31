import assert from 'node:assert/strict';
import test from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

// `npm run dev:live` (TASK-686) proxies /api to a real backend. In prod
// read-only mode the proxy must refuse every HTTP write before it leaves the
// machine, and must not proxy the socket at all. These run the real
// vite.config.ts against prod's hostname, so a refusal that failed open would
// send a request to api.commonly.me; every assertion below is answered locally.

const frontendDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configFile = resolve(frontendDir, 'vite.config.ts');

async function withDevLive(env, port, fn) {
  const saved = { DEV_LIVE: process.env.DEV_LIVE, DEV_LIVE_TARGET: process.env.DEV_LIVE_TARGET };
  Object.assign(process.env, env);
  let server;
  try {
    server = await createServer({
      configFile,
      logLevel: 'silent',
      server: { port, strictPort: true, host: '127.0.0.1' },
    });
    await server.listen();
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await server?.close();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('prod read-only refuses every HTTP write at the proxy', async () => {
  await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'prod' }, 3199, async (base) => {
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
});

test('prod read-only does not proxy the socket path', async () => {
  await withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'prod' }, 3199, async (base) => {
    // Vite answers with its SPA fallback (HTML), not an engine.io handshake,
    // so the socket never reaches prod. A proxied handshake would carry "sid".
    const res = await fetch(`${base}/socket.io/?EIO=4&transport=polling`);
    const body = await res.text();
    assert.doesNotMatch(body, /"sid"/, '/socket.io must not reach prod in read-only mode');
    assert.match(res.headers.get('content-type') ?? '', /text\/html/);
  });
});

test('an unknown DEV_LIVE_TARGET fails the config load instead of falling through', async () => {
  await assert.rejects(
    withDevLive({ DEV_LIVE: '1', DEV_LIVE_TARGET: 'nowhere' }, 3199, async () => {}),
    /DEV_LIVE_TARGET must be one of: staging, prod/,
  );
});
