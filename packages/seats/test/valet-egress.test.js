/**
 * The egress allowlist: the grant's network field, the CONNECT proxy that
 * enforces it, and the composition invariant that the sandbox's network rule
 * and the proxy env only ever arrive together. Every connection here is to
 * loopback; names that would resolve elsewhere go through an injected lookup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect, createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateGrant, matchEgress, parseEgressEntry } from '../src/valet/grant.js';
import { startEgressProxy, startLoopbackRelay, isNonPublicAddress, EGRESS_DENIAL_REASONS } from '../src/valet/egress-proxy.js';
import { prepareRunEnv } from '../src/valet/env.js';
import { sandboxRunArgv, startRunEgress } from '../src/valet/sandbox.js';
import { buildSeatbeltProfile } from '../src/sandbox/seatbelt.js';
import { EVENT_TYPES } from '../src/trace/events.js';
import * as seats from '../src/index.js';

const SECRET = 'sk-egress-0123456789abcdef';
const macTest = process.platform === 'darwin' ? test : test.skip;
const recorder = () => { const events = []; return { events, emit: (type, data) => events.push({ type, data }) }; };

/** A loopback listener that counts connections and keeps every byte it gets. */
const listener = async (answer = null) => {
  const state = { connections: 0, bytes: Buffer.alloc(0) };
  const server = createServer((socket) => {
    state.connections += 1;
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      state.bytes = Buffer.concat([state.bytes, chunk]);
      if (answer) socket.end(answer);
    });
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  state.port = server.address().port;
  state.close = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
  return state;
};

/** Send `head` to the proxy; report the status line and what came back after it. */
const ask = (proxy, head, payload = '') => new Promise((done) => {
  const socket = connect(proxy.socketPath ? { path: proxy.socketPath } : { host: '127.0.0.1', port: proxy.port });
  let raw = '';
  let finished = false;
  const finish = (extra = {}) => {
    if (finished) return;
    finished = true;
    socket.destroy();
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0);
    done({ status, after: raw.includes('\r\n\r\n') ? raw.slice(raw.indexOf('\r\n\r\n') + 4) : '', ...extra });
  };
  socket.on('error', (error) => finish({ error: error.code }));
  socket.on('connect', () => socket.write(head + payload));
  socket.on('data', (chunk) => {
    raw += chunk;
    if (/^HTTP\/1\.1 (?!200)/.test(raw) || raw.includes('\r\n\r\npong')) finish();
  });
  socket.on('close', () => finish());
  setTimeout(() => finish({ timedOut: true }), 3000);
});
const connectHead = (target) => `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`;

// ---- grant ----------------------------------------------------------------

test('network.allow accepts host:port and *.suffix:port, normalised', () => {
  const grant = validateGrant({ network: { allow: ['API.Example.COM.:443', '*.example.com:8443', 'a-b.c.d:1', 'x.y:65535'] } });
  assert.deepEqual(grant.network.allow.map((rule) => rule.entry), ['api.example.com:443', '*.example.com:8443', 'a-b.c.d:1', 'x.y:65535']);
  assert.deepEqual(validateGrant({}).network.allow, [], 'no network field allows nothing');
  assert.deepEqual(validateGrant({ network: {} }).network.allow, []);
});

test('network.allow refuses every entry that is not a name and a port', () => {
  const bad = [
    ['*:443', /bare \*/], ['*.com:443', /one-label suffix/], ['*.localhost:80', /one-label suffix/],
    ['a.*.com:443', /whole leading label/], ['*example.com:443', /whole leading label/], ['ex*.com:443', /whole leading label/],
    ['1.2.3.4:443', /IP address/], ['[::1]:443', /brackets/], ['::1:443', /IP address/], ['fe80::1:443', /IP address/],
    ['2130706433:443', /valid host name/], ['127.1:443', /valid host name/], ['0x7f.1:443', /valid host name/],
    ['api.x', /must name a port/], ['api.x:', /outside 1-65535/], ['api.x:0', /outside 1-65535/],
    ['api.x:65536', /outside 1-65535/], ['api.x:-1', /outside 1-65535/], ['api.x:080', /outside 1-65535/], ['api.x:4e2', /outside 1-65535/],
    ['https://api.x:443', /scheme/], ['user@api.x:443', /userinfo/], ['user:pw@api.x:443', /userinfo/],
    ['api.x:443/v1', /path/], ['api.x/v1:443', /path/], ['api.x:443?q', /path/], [' api.x:443', /spaces/],
    ['api_x.com:443', /valid host name/], ['a..b:443', /valid host name/], ['-a.b:443', /valid host name/],
    [`${'a'.repeat(64)}.com:443`, /valid host name/], [':443', /valid host name/], ['', /non-empty string/], [443, /non-empty string/],
  ];
  for (const [entry, message] of bad) {
    assert.throws(() => validateGrant({ network: { allow: [entry] } }), message, JSON.stringify(entry));
  }
  assert.throws(() => validateGrant({ network: { allow: ['A.x.y:1', 'a.x.y.:1'] } }), /repeats a\.x\.y:1/);
  assert.throws(() => validateGrant({ network: { allow: ['a.x:1'], allowIps: ['1.2.3.4:1'] } }), /allowIps is not supported/);
  assert.throws(() => validateGrant({ network: { deny: [] } }), /unknown field network\.deny/);
  assert.throws(() => validateGrant({ network: { allow: 'a.x:1' } }), /network\.allow must be an array/);
  assert.throws(() => validateGrant({ network: [] }), /network must be an object/);
});

test('a wildcard matches one or more labels under its suffix and never the bare suffix', () => {
  const { allow } = validateGrant({ network: { allow: ['*.example.com:443', 'exact.test.org:443'] } }).network;
  const table = [
    ['api.example.com', 443, '*.example.com:443'],
    ['a.b.example.com', 443, '*.example.com:443'],
    ['API.EXAMPLE.COM.', 443, '*.example.com:443'],
    ['example.com', 443, null],
    ['example.com.', 443, null],
    ['.example.com', 443, null],
    ['xexample.com', 443, null],
    ['example.com.evil.io', 443, null],
    ['api.example.com.evil.io', 443, null],
    ['api.example.com', 8443, null],
    ['exact.test.org', 443, 'exact.test.org:443'],
    ['a.exact.test.org', 443, null],
    ['test.org', 443, null],
    ['api.example.com', '443', null],
  ];
  for (const [host, port, entry] of table) {
    assert.equal(matchEgress(allow, host, port)?.entry ?? null, entry, `${host}:${port}`);
  }
  assert.equal(matchEgress(allow, 'api.example.com', 443).exact, false);
  assert.equal(matchEgress(allow, 'exact.test.org', 443).exact, true);
  // An exact entry wins over a wildcard that also matches, wherever it is listed.
  const both = validateGrant({ network: { allow: ['*.example.com:443', 'api.example.com:443'] } }).network.allow;
  assert.deepEqual(matchEgress(both, 'api.example.com', 443), { entry: 'api.example.com:443', exact: true });
});

test('the proxy variables cannot be named as credentials', () => {
  for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY']) {
    assert.throws(() => validateGrant({ credentials: [{ name, from: 'env' }] }), /reserved/, name);
  }
});

test('non-public addresses are every range a public service does not live in', () => {
  for (const address of ['127.0.0.1', '127.9.9.9', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '100.64.0.1', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'ff02::1']) {
    assert.equal(isNonPublicAddress(address), true, address);
  }
  for (const address of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111', '::ffff:8.8.8.8']) {
    assert.equal(isNonPublicAddress(address), false, address);
  }
});

test('the egress events are part of the trace vocabulary and exported', () => {
  assert.ok(EVENT_TYPES.includes('egress.allowed'));
  assert.ok(EVENT_TYPES.includes('egress.denied'));
  for (const name of ['startRunEgress', 'startEgressProxy', 'EGRESS_DENIAL_REASONS', 'parseEgressEntry', 'matchEgress']) {
    assert.ok(name in seats, name);
  }
});

// ---- proxy ----------------------------------------------------------------

const withProxy = async (options, fn) => {
  const allowed = await listener('pong');
  const canary = await listener('pong');
  const trace = recorder();
  const allow = typeof options.allow === 'function' ? options.allow({ allowed, canary }) : options.allow;
  const proxy = await startEgressProxy({ ...options, allow, trace });
  try {
    return await fn({ proxy, allowed, canary, trace });
  } finally {
    await proxy.close();
    await allowed.close();
    await canary.close();
  }
};

test('the proxy opens a tunnel to an allowed host and refuses the canary before connecting', () => withProxy({
  allow: ({ allowed }) => [`allowed.localhost:${allowed.port}`],
}, async ({ proxy, allowed, canary, trace }) => {
  const ok = await ask(proxy, connectHead(`allowed.localhost:${allowed.port}`), `KEY ${SECRET}\n`);
  assert.equal(ok.status, 200);
  assert.equal(ok.after, 'pong');
  assert.equal(allowed.connections, 1);
  assert.ok(allowed.bytes.toString().includes(SECRET), 'the allowed host received what the run sent');
  const no = await ask(proxy, connectHead(`canary.localhost:${canary.port}`), `KEY ${SECRET}\n`);
  assert.equal(no.status, 403);
  assert.equal(canary.connections, 0);
  assert.equal(canary.bytes.length, 0);
  assert.deepEqual(trace.events, [
    { type: 'egress.allowed', data: { host: 'allowed.localhost', port: allowed.port } },
    { type: 'egress.denied', data: { host: 'canary.localhost', port: canary.port, reason: 'not_allowed' } },
  ]);
  assert.ok(!JSON.stringify(trace.events).includes(SECRET), 'no payload in the trace');
}));

test('matching is case-insensitive and ignores one trailing dot', () => withProxy({
  allow: ({ allowed }) => [`allowed.localhost:${allowed.port}`],
}, async ({ proxy, allowed }) => {
  assert.equal((await ask(proxy, connectHead(`ALLOWED.Localhost.:${allowed.port}`), 'x')).status, 200);
  assert.equal((await ask(proxy, connectHead(`allowed.localhost..:${allowed.port}`), 'x')).status, 400);
}));

test('every request that is not an allowed CONNECT is refused with a named reason', () => withProxy({
  allow: ({ allowed }) => [`allowed.localhost:${allowed.port}`],
}, async ({ proxy, allowed, canary, trace }) => {
  const cases = [
    [connectHead(`127.0.0.1:${canary.port}`), 403, 'ip_literal'],
    [connectHead(`[::1]:${canary.port}`), 403, 'ip_literal'],
    [connectHead(`localhost:${canary.port}`), 403, 'not_allowed'],
    [connectHead(`allowed.localhost:${canary.port}`), 403, 'not_allowed'],
    [`GET http://allowed.localhost:${allowed.port}/ HTTP/1.1\r\nHost: allowed.localhost\r\n\r\n`, 405, 'not_connect'],
    [`POST http://canary.localhost:${canary.port}/ HTTP/1.1\r\n\r\n`, 405, 'not_connect'],
    ['CONNECT bad_host!:443 HTTP/1.1\r\n\r\n', 400, 'bad_request'],
    ['CONNECT allowed.localhost:99999 HTTP/1.1\r\n\r\n', 400, 'bad_request'],
    ['CONNECT allowed.localhost HTTP/1.1\r\n\r\n', 400, 'bad_request'],
    ['hello\r\n\r\n', 400, 'bad_request'],
  ];
  for (const [head, status, reason] of cases) {
    const before = trace.events.length;
    assert.equal((await ask(proxy, head, 'x')).status, status, head);
    assert.equal(trace.events.at(-1).type, 'egress.denied', head);
    assert.equal(trace.events.at(-1).data.reason, reason, head);
    assert.equal(trace.events.length, before + 1, head);
  }
  assert.equal(canary.connections, 0);
  assert.equal(allowed.connections, 0, 'a plain-HTTP request to an allowed host is refused, not forwarded');
  for (const event of trace.events) assert.ok(EGRESS_DENIAL_REASONS.includes(event.data.reason));
}));

test('a wildcard-allowed name that resolves to a private address is refused; an exact entry is not', () => {
  const answers = {
    'a.rebind.test': ['127.0.0.1'],
    'mixed.rebind.test': ['8.8.8.8', '10.0.0.7'],
    'meta.rebind.test': ['169.254.169.254'],
    'exact.rebind.test': ['127.0.0.1'],
  };
  const lookup = (host, opts, done) => {
    if (!answers[host]) { done(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })); return; }
    done(null, answers[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 })));
  };
  return withProxy({
    lookup,
    allow: ({ canary }) => [`*.rebind.test:${canary.port}`, `exact.rebind.test:${canary.port}`, `*.wild.localhost:${canary.port}`],
  }, async ({ proxy, canary, trace }) => {
    for (const host of ['a.rebind.test', 'mixed.rebind.test', 'meta.rebind.test', 'x.wild.localhost']) {
      assert.equal((await ask(proxy, connectHead(`${host}:${canary.port}`), SECRET)).status, 403, host);
      assert.deepEqual(trace.events.at(-1), { type: 'egress.denied', data: { host, port: canary.port, reason: 'private_address' } });
    }
    assert.equal(canary.connections, 0, 'no refused name reached the host');
    assert.equal((await ask(proxy, connectHead(`gone.rebind.test:${canary.port}`), 'x')).status, 502);
    assert.equal(trace.events.at(-1).data.reason, 'unresolved');
    // Positive control: the same loopback target, named exactly, is reachable.
    assert.equal((await ask(proxy, connectHead(`exact.rebind.test:${canary.port}`), 'x')).status, 200);
    assert.equal(canary.connections, 1);
  });
});

test('an allowed host that is not listening is unreachable, not allowed', async () => {
  const gone = await listener();
  const port = gone.port;
  await gone.close();
  const trace = recorder();
  const proxy = await startEgressProxy({ allow: [`gone.localhost:${port}`], trace });
  try {
    assert.equal((await ask(proxy, connectHead(`gone.localhost:${port}`), 'x')).status, 502);
    assert.deepEqual(trace.events, [{ type: 'egress.denied', data: { host: 'gone.localhost', port, reason: 'unreachable' } }]);
  } finally { await proxy.close(); }
});

test('bytes sent with the CONNECT reach the target; headers and bodies never reach the trace', () => withProxy({
  allow: ({ allowed }) => [`allowed.localhost:${allowed.port}`],
}, async ({ proxy, allowed, trace }) => {
  const head = `CONNECT allowed.localhost:${allowed.port} HTTP/1.1\r\nProxy-Authorization: Basic ${SECRET}\r\nX-Key: ${SECRET}\r\n\r\n`;
  assert.equal((await ask(proxy, head, `early ${SECRET}`)).status, 200);
  assert.ok(allowed.bytes.toString().startsWith('early '), 'pipelined bytes are forwarded');
  assert.ok(!allowed.bytes.toString().includes('Proxy-Authorization'), 'the CONNECT head stays at the proxy');
  assert.ok(!JSON.stringify(trace.events).includes(SECRET));
}));

test('a host carrying a run credential is traced as [redacted]', async () => {
  const trace = recorder();
  const proxy = await startEgressProxy({ allow: [], trace, redact: [SECRET] });
  try {
    assert.equal((await ask(proxy, connectHead(`${SECRET}.exfil.test:443`))).status, 403);
    assert.equal((await ask(proxy, connectHead(`x${SECRET.toUpperCase()}.exfil.test:443`))).status, 403);
    assert.deepEqual(trace.events.map((event) => event.data.host), ['[redacted]', '[redacted]']);
    assert.ok(!JSON.stringify(trace.events).toLowerCase().includes(SECRET));
  } finally { await proxy.close(); }
});

test('idle tunnels and half-sent requests are closed', () => withProxy({
  idleMs: 150,
  allow: ({ allowed }) => [`allowed.localhost:${allowed.port}`],
}, async ({ proxy, allowed }) => {
  const closedWithin = (write) => new Promise((done) => {
    const started = Date.now();
    const socket = connect({ host: '127.0.0.1', port: proxy.port });
    socket.on('error', () => {});
    socket.on('connect', () => socket.write(write));
    socket.resume();
    socket.on('close', () => done(Date.now() - started));
    setTimeout(() => { socket.destroy(); done(Infinity); }, 3000);
  });
  assert.ok(await closedWithin('CONNECT allowed.localhost') < 2000, 'a request that never finishes its head');
  // `listener` answers only after it hears something, so this tunnel stays silent.
  assert.ok(await closedWithin(connectHead(`allowed.localhost:${allowed.port}`)) < 2000, 'an open tunnel that goes quiet');
  assert.equal(allowed.connections, 1);
}));

test('close() ends open tunnels and stops listening', () => withProxy({
  allow: ({ allowed }) => [`allowed.localhost:${allowed.port}`],
}, async ({ proxy, allowed }) => {
  const socket = connect({ host: '127.0.0.1', port: proxy.port });
  socket.on('error', () => {});
  await new Promise((done) => socket.on('connect', done));
  socket.write(connectHead(`allowed.localhost:${allowed.port}`));
  await new Promise((done) => socket.once('data', done));
  const closed = new Promise((done) => socket.on('close', done));
  await proxy.close();
  await closed;
  const refused = await new Promise((done) => {
    const again = connect({ host: '127.0.0.1', port: proxy.port });
    again.on('connect', () => { again.destroy(); done('connected'); });
    again.on('error', (error) => done(error.code));
  });
  assert.equal(refused, 'ECONNREFUSED');
  await proxy.close();
}));

test('the proxy serves a Unix socket for the bwrap route, and the relay reaches its fixed origin', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seat-egress-test-'));
  const allowed = await listener('pong');
  const proxy = await startEgressProxy({ allow: [`allowed.localhost:${allowed.port}`], socketPath: join(dir, 'egress.sock') });
  const relay = await startLoopbackRelay({ socketPath: join(dir, 'provider.sock'), host: '127.0.0.1', port: allowed.port });
  try {
    assert.equal(proxy.port, null);
    assert.equal((await ask(proxy, connectHead(`allowed.localhost:${allowed.port}`), 'x')).status, 200);
    const echoed = await new Promise((done) => {
      const socket = connect({ path: relay.socketPath });
      socket.on('connect', () => socket.write('hi'));
      socket.on('data', (chunk) => { socket.destroy(); done(chunk.toString()); });
    });
    assert.equal(echoed, 'pong');
    assert.equal(allowed.connections, 2);
  } finally {
    await relay.close();
    await proxy.close();
    await allowed.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- composition ----------------------------------------------------------

const rulesOf = (profile) => profile.split('\n').filter((line) => !line.trimStart().startsWith(';')).join('\n');
const networkAllows = (profile) => [...rulesOf(profile).matchAll(/\(allow network-outbound([^\n]*)\)/g)].map((m) => m[1].trim());

const composed = async ({ grant = {}, provider, workspace } = {}) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-egress-compose-'));
  const run = await prepareRunEnv({ grant, baseEnv: { HOME: process.env.HOME, PATH: '/usr/bin:/bin' }, root });
  const egress = await startRunEgress({ run, provider });
  const result = sandboxRunArgv({ argv: ['/usr/bin/true'], run, egress, ...(workspace ? { workspace: { path: root } } : {}) });
  await egress.close();
  await run.cleanup();
  rmSync(root, { recursive: true, force: true });
  return { egress, result };
};

macTest('the network rule and the proxy env always arrive together, naming the same port', async () => {
  const cases = [
    {},
    { grant: { network: { allow: ['*.example.com:443'] } } },
    { provider: { baseURL: 'https://api.provider.test/v1' } },
    { provider: { baseURL: 'http://127.0.0.1:43123/v1' } },
    { provider: { baseURL: 'http://localhost:43124' }, workspace: true },
  ];
  for (const options of cases) {
    const label = JSON.stringify(options);
    const { egress, result } = await composed(options);
    const profile = result.argv[2];
    assert.equal(result.sandbox, 'seatbelt', label);
    assert.equal(result.egress, 'proxy', label);
    const ports = [egress.port, ...(egress.direct ? [egress.direct.port] : [])];
    assert.deepEqual(networkAllows(profile), ports.map((port) => `(remote tcp "localhost:${port}")`), `${label}: only the proxy (and a loopback provider)`);
    assert.ok(!/\(allow network-outbound\)/.test(rulesOf(profile)), `${label}: no unfiltered allow`);
    const dnsAt = profile.indexOf('(remote ip "*:53")');
    assert.ok(dnsAt > profile.lastIndexOf('(allow '), `${label}: the DNS deny comes after every allow`);
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'https_proxy', 'http_proxy', 'all_proxy']) {
      assert.equal(result.env[name], `http://127.0.0.1:${egress.port}`, `${label}: ${name}`);
    }
    assert.equal(result.env.NO_PROXY, egress.direct ? egress.direct.host : undefined, label);
  }
});

test('the Seatbelt builder keeps its old output when the network options take their defaults', () => {
  const opts = { workspacePath: '/tmp', executablePath: '/usr/bin/true', statePath: '/tmp', loopbackNetworkPorts: [1234] };
  const old = buildSeatbeltProfile(opts);
  assert.equal(buildSeatbeltProfile({ ...opts, allowNetworkOutbound: true, denyDns: false }), old);
  assert.ok(/\n\(allow network-outbound\)\n/.test(old), 'control: the default still carries the unfiltered allow');
  const fenced = buildSeatbeltProfile({ ...opts, allowNetworkOutbound: false, denyDns: true });
  assert.deepEqual(networkAllows(fenced), ['(remote tcp "localhost:1234")']);
  assert.equal(fenced.replace(/\n\n\(deny network-outbound\n[\s\S]*$/, ''), old.replace('\n(allow network-outbound)\n', '\n'),
    'only the unfiltered allow goes, and only the DNS deny is added');
});

test('startRunEgress adds the provider exactly once and keeps a loopback provider off the proxy', async () => {
  const run = await prepareRunEnv({ grant: { network: { allow: ['api.provider.test:443', '*.example.com:443'] } } });
  try {
    const hosted = await startRunEgress({ run, platform: 'darwin', provider: { baseURL: 'https://API.provider.test.:443/v1' } });
    assert.deepEqual(hosted.allow, ['api.provider.test:443', '*.example.com:443']);
    assert.equal(hosted.direct, null);
    await hosted.close();
    const wildOnly = await startRunEgress({ run, platform: 'darwin', provider: { baseURL: 'https://x.example.com' } });
    assert.deepEqual(wildOnly.allow, ['api.provider.test:443', '*.example.com:443', 'x.example.com:443'], 'a wildcard match is not exact, so the provider is named');
    await wildOnly.close();
    for (const baseURL of ['http://127.0.0.1:1234', 'http://[::1]:1234/v1', 'http://localhost:1234', 'http://fake.localhost:1234']) {
      const local = await startRunEgress({ run, platform: 'darwin', provider: { baseURL } });
      assert.equal(local.direct.port, 1234, baseURL);
      assert.deepEqual(local.allow, ['api.provider.test:443', '*.example.com:443'], baseURL);
      await local.close();
    }
    await assert.rejects(startRunEgress({ run, provider: { baseURL: 'https://10.0.0.5/v1' } }), /names an IP address/);
    await assert.rejects(startRunEgress({ run, provider: { baseURL: 'ftp://x.test' } }), /http or https/);
    await assert.rejects(startRunEgress({ run, provider: { baseURL: 'nope' } }), /must be a URL/);
    await assert.rejects(startRunEgress({ run: {} }), /prepareRunEnv/);
  } finally { await run.cleanup(); }
});

test('parseEgressEntry is the grant\'s parser, and the proxy refuses a malformed allowlist', async () => {
  assert.deepEqual(parseEgressEntry('*.A.b:9'), { entry: '*.a.b:9', host: 'a.b', port: 9, wildcard: true });
  await assert.rejects(startEgressProxy({ allow: ['*:443'] }), /bare \*/);
});
