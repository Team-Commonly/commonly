// The per-run loopback provider relay: pass-through auth, in-memory refusal
// taps, TLS upstreams with an explicit CA, teardown on every settle path, the
// not-covered status, and a canary search over every file a run writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { request as httpRequest } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, openSync, closeSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { createRelayStubAdapter } from '../test-support/relay-stub-adapter.js';
import { WIRES, post, parseSSE } from './fake-provider-helpers.js';
import { startProviderRelay } from '../src/wire/provider-relay.js';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';
import { COVERAGE, COMPAT_NOT_COVERED, compatRefusalStatus } from '../src/coverage.js';
import { RunFailure } from '../src/failures.js';
import * as seats from '../src/index.js';

const DRIVER = fileURLToPath(new URL('../test-support/relay-canary-driver.mjs', import.meta.url));

const tempDir = (label) => mkdtempSync(join(tmpdir(), `seats-relay-${label}-`));
const withTemp = async (label, fn) => {
  const dir = tempDir(label);
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

/** Resolves true when something accepts a TCP connection on 127.0.0.1:port. */
const portOpen = (port) => new Promise((resolve) => {
  const socket = connect({ host: '127.0.0.1', port });
  socket.once('connect', () => { socket.destroy(); resolve(true); });
  socket.once('error', () => resolve(false));
});

// `url` is a string, or { port, path } to send a path verbatim (URL parsing would resolve %2e%2e).
const rawRequest = (url, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const target = typeof url === 'string' ? [url, { method, headers }] : [{ host: '127.0.0.1', ...url, method, headers }];
  const req = httpRequest(...target, (res) => {
    let text = '';
    res.setEncoding('utf8');
    res.on('data', (d) => { text += d; });
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', reject);
  req.end(body);
});

/** A start() that records each relay, so a test can inspect it after the run settles. */
const recordingStart = () => {
  const started = [];
  const start = async (options) => {
    const relay = await startProviderRelay(options);
    started.push(relay);
    return relay;
  };
  return { started, start };
};

const memoryStore = () => withTempStore();
function withTempStore() {
  const dir = tempDir('trace');
  const store = createTraceStore({ root: dir });
  return { store, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const makeCert = (dir) => {
  const key = join(dir, 'key.pem');
  const cert = join(dir, 'cert.pem');
  const made = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { encoding: 'utf8' });
  assert.equal(made.status, 0, `openssl must be able to make a self-signed cert: ${made.stderr}`);
  return { key: readFileSync(key), cert: readFileSync(cert) };
};

// ── the relay on its own ────────────────────────────────────────────────────

test('relay: listens on 127.0.0.1 only, on an ephemeral port, and keeps the upstream path', async () => {
  const relay = await startProviderRelay();
  try {
    assert.ok(relay.port > 0);
    const base = relay.handle.bind({ upstream: 'https://example.invalid/backend-api/codex/' });
    const url = new URL(base);
    assert.equal(url.hostname, '127.0.0.1');
    assert.equal(Number(url.port), relay.port);
    assert.match(url.pathname, /^\/[A-Za-z0-9_-]{24}\/backend-api\/codex$/, 'a per-run token, then the upstream path unchanged');
    assert.throws(() => relay.handle.bind({ upstream: 'https://user:pw@example.invalid' }), /credentials/);
    assert.throws(() => relay.handle.bind({ upstream: 'file:///etc/passwd' }), /http/);
  } finally { await relay.close(); }
});

test('relay: auth headers reach the provider untouched, and the response comes back unchanged', async () => {
  const fake = await startFakeProvider({ script: ['relayed reply'] });
  const relay = await startProviderRelay();
  try {
    const base = relay.handle.bind({ upstream: fake.baseURL });
    const auth = {
      authorization: 'Bearer oauth-canary-6c1f',
      'x-api-key': 'key-canary-91ab',
      'anthropic-beta': 'oauth-2025-04-20,canary-beta-77',
      'anthropic-version': '2023-06-01',
      'chatgpt-account-id': 'acct-canary-3d2e',
    };
    const res = await post(`${base}/responses`, WIRES.responses.body('hi', true), auth);
    assert.equal(res.status, 200);
    const reply = WIRES.responses.readStream(parseSSE(await res.text()));
    assert.equal(reply.text, 'relayed reply');
    for (const [name, value] of Object.entries(auth)) {
      const hits = fake.findInRequests(value).filter((hit) => hit.where === `header:${name}`);
      assert.equal(hits.length, 1, `${name} arrived exactly as sent`);
    }
    assert.equal(fake.requests[0].path, '/v1/responses', 'the token segment is stripped');
    assert.equal(relay.verdict.requests, 1);
  } finally { await relay.close(); await fake.close(); }
});

test('relay: refuses requests that do not carry its token, leave the base path, or upgrade', async () => {
  const fake = await startFakeProvider();
  const relay = await startProviderRelay();
  try {
    assert.equal((await rawRequest(`http://127.0.0.1:${relay.port}/v1/models`)).status, 503, 'nothing is forwarded before bind');
    const base = relay.handle.bind({ upstream: fake.baseURL });
    const origin = `http://127.0.0.1:${relay.port}`;
    assert.equal((await rawRequest(`${origin}/v1/models`)).status, 404, 'no token, no forward');
    assert.equal((await rawRequest(`${base.replace('/v1', '')}/other/models`)).status, 404, 'outside the upstream base path');
    const basePath = new URL(base).pathname;
    assert.equal((await rawRequest({ port: relay.port, path: `${basePath}/%2e%2e/models` })).status, 400, 'encoded traversal');
    assert.equal((await rawRequest({ port: relay.port, path: `${basePath}/../../models` })).status, 400, 'literal traversal');
    const upgrade = await rawRequest(`${base}/responses`, { headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' } })
      .catch(() => ({ status: 'socket closed' }));
    assert.equal(upgrade.status, 426, 'a WebSocket upgrade is sent to HTTP');
    assert.equal(fake.allRequests.length, 0, 'none of these reached the provider');
    assert.equal((await rawRequest(`${base}/models`)).status, 200, 'a proper request still works');
  } finally { await relay.close(); await fake.close(); }
});

test('relay: taps every wire format for an in-band refusal, and keeps verdicts free of text', async () => {
  for (const [wire, format] of [['responses', 'openai-responses'], ['anthropic', 'anthropic'], ['chat', 'openai-chat']]) {
    const fake = await startFakeProvider({ script: [{ refuse: 'refusal-text-canary', refuseAs: 'inband' }] });
    const relay = await startProviderRelay();
    try {
      const base = relay.handle.bind({ upstream: wire === 'anthropic' ? fake.anthropicBaseURL : fake.baseURL });
      const proxied = { ...fake, baseURL: base, anthropicBaseURL: base };
      const res = await post(WIRES[wire].path(proxied), WIRES[wire].body('go', true), WIRES[wire].headers);
      await res.text();
      assert.equal(relay.refusals[0]?.format, format, wire);
      assert.equal(relay.verdict.status, COVERAGE.COVERED);
      assert.deepEqual(Object.keys(relay.verdict.refusals[0]).sort(), ['format', 'signal'], `${wire}: a verdict, never content`);
      assert.ok(!JSON.stringify(relay.verdict).includes('refusal-text-canary'));
    } finally { await relay.close(); await fake.close(); }
  }
});

test('relay: an https upstream is verified against the CA it is given, and refused without it', async () => {
  await withTemp('tls', async (dir) => {
    const { key, cert } = makeCert(dir);
    const fake = await startFakeProvider({ tls: { key, cert }, script: ['over tls'] });
    assert.ok(fake.baseURL.startsWith('https://'));
    const trusting = await startProviderRelay({ ca: cert });
    const strict = await startProviderRelay();
    try {
      assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined, 'verification is never turned off globally');
      const good = await post(`${trusting.handle.bind({ upstream: fake.baseURL })}/responses`, WIRES.responses.body('hi', true), WIRES.responses.headers);
      assert.equal(good.status, 200);
      assert.equal(WIRES.responses.readStream(parseSSE(await good.text())).text, 'over tls');
      const bad = await post(`${strict.handle.bind({ upstream: fake.baseURL })}/responses`, WIRES.responses.body('hi', true), WIRES.responses.headers);
      assert.equal(bad.status, 502, 'a self-signed cert the relay was not handed is refused');
      assert.equal(await bad.text(), 'provider relay: upstream request failed', 'with a fixed body');
      assert.equal(fake.requests.length, 1, 'only the verified request reached the provider');
    } finally { await trusting.close(); await strict.close(); await fake.close(); }
  });
});

test('relay: close() frees the port and cuts an upstream request in flight', async () => {
  const fake = await startFakeProvider({ script: [{ stall: true }] });
  const relay = await startProviderRelay();
  const base = relay.handle.bind({ upstream: fake.baseURL });
  const pending = post(`${base}/responses`, WIRES.responses.body('hang', true), WIRES.responses.headers)
    .then((res) => res.text()).then(() => 'answered', () => 'cut');
  while (fake.requests.length === 0) await new Promise((r) => setTimeout(r, 10));
  assert.equal(await portOpen(relay.port), true);
  await relay.close();
  assert.equal(await portOpen(relay.port), false, 'the port is closed');
  assert.equal(await pending, 'cut');
  await relay.close(); // idempotent
  await fake.close();
});

// ── under the supervisor ────────────────────────────────────────────────────

const SETTLE_PATHS = {
  ok: { adapter: (upstream) => createRelayStubAdapter({ upstream }), expect: 'ok' },
  failed: {
    adapter: (upstream) => ({
      name: 'thrower',
      async spawn(_p, ctx) {
        const base = ctx.providerRelay.bind({ upstream });
        await post(`${base}/responses`, WIRES.responses.body('hi', true), WIRES.responses.headers).then((r) => r.text());
        throw new RunFailure('protocol', 'broken');
      },
    }),
    expect: 'failed',
  },
  stuck: {
    adapter: (upstream) => ({
      name: 'hanger',
      spawn(_p, ctx) {
        ctx.providerRelay.bind({ upstream });
        return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      },
    }),
    policy: { stallMs: 150, cancelGraceMs: 200 },
    expect: 'stuck',
  },
  'stuck, adapter ignores cancel': {
    adapter: (upstream) => ({ name: 'deaf', spawn(_p, ctx) { ctx.providerRelay.bind({ upstream }); return new Promise(() => {}); } }),
    policy: { stallMs: 150, cancelGraceMs: 100 },
    expect: 'stuck',
  },
  cancelled: {
    adapter: (upstream) => ({
      name: 'cancellable',
      spawn(_p, ctx) {
        ctx.providerRelay.bind({ upstream });
        return new Promise((_resolve, reject) => ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason)));
      },
    }),
    cancelAfterMs: 100,
    expect: 'cancelled',
  },
};

for (const [name, scenario] of Object.entries(SETTLE_PATHS)) {
  test(`supervisor: the relay is up during the run and torn down when it settles ${name}`, async () => {
    const fake = await startFakeProvider();
    const { store, cleanup } = memoryStore();
    const { started, start } = recordingStart();
    const controller = new AbortController();
    try {
      let openDuringRun = null;
      const inner = scenario.adapter(fake.baseURL);
      const adapter = {
        ...inner,
        spawn: async (prompt, ctx) => {
          openDuringRun = await portOpen(started[0].port);
          return inner.spawn(prompt, ctx);
        },
      };
      if (scenario.cancelAfterMs) setTimeout(() => controller.abort(), scenario.cancelAfterMs);
      const out = await superviseRun({
        adapter, prompt: 'hi', store, policy: scenario.policy, relay: { start }, ctx: { signal: controller.signal },
      });
      assert.equal(out.outcome, scenario.expect);
      assert.equal(started.length, 1, 'one relay per run');
      assert.equal(openDuringRun, true, 'listening while the adapter runs');
      assert.equal(started[0].closed, true, 'closed on settle');
      assert.equal(await portOpen(started[0].port), false, 'the port is closed');
      const events = store.readRun(out.runId).map((e) => e.type);
      assert.equal(events.at(-1), 'run.settled');
      assert.equal(events.at(-2), 'provider.relay', 'the coverage verdict is traced before the settle');
    } finally {
      // close() is idempotent: a no-op when the supervisor tore it down, and
      // it keeps a missed teardown failing on the assertion instead of hanging.
      for (const relay of started) await relay.close();
      await fake.close(); cleanup();
    }
  });
}

test('supervisor: no relay option, no relay — the run is unchanged', async () => {
  const { store, cleanup } = memoryStore();
  try {
    let seen;
    const out = await superviseRun({ adapter: { name: 'plain', async spawn(_p, ctx) { seen = ctx; return { text: 'x' }; } }, prompt: 'hi', store });
    assert.equal(seen.providerRelay, undefined);
    assert.equal(out.relay, undefined);
    assert.ok(!store.readRun(out.runId).some((e) => e.type.startsWith('provider.')));
  } finally { cleanup(); }
});

test('supervisor: a covered run whose CLI drops an in-band refusal and exits 0 settles refusal_dropped', async () => {
  const fake = await startFakeProvider({ script: [{ refuse: 'refusal-canary-text', refuseAs: 'inband' }] });
  const { store, cleanup } = memoryStore();
  try {
    const out = await superviseRun({ adapter: createRelayStubAdapter({ upstream: fake.baseURL }), prompt: 'hi', store, relay: {} });
    assert.equal(out.outcome, 'failed');
    assert.equal(out.failure.kind, 'refusal_dropped');
    assert.deepEqual(out.failure.refusal, { format: 'openai-responses', signal: 'refusal_part' }, 'the returned failure carries no text');
    assert.equal(out.relay.status, COVERAGE.COVERED);
    assert.deepEqual(out.relay.refusals, [{ format: 'openai-responses', signal: 'refusal_part' }]);
    assert.equal(compatRefusalStatus(out), 'pass');
    const trace = store.readRun(out.runId);
    assert.deepEqual(trace.find((e) => e.type === 'provider.refusal').data, { format: 'openai-responses', signal: 'refusal_part', attempt: 1 });
    assert.equal(trace.at(-1).data.failure.kind, 'refusal_dropped');
    assert.ok(!JSON.stringify(trace).includes('refusal-canary-text'), 'the refusal text is not in the trace');
  } finally { await fake.close(); cleanup(); }
});

test('supervisor: a CLI that surfaces the refusal settles ok', async () => {
  const fake = await startFakeProvider({ script: [{ refuse: 'shown refusal', refuseAs: 'inband' }] });
  const { store, cleanup } = memoryStore();
  try {
    const out = await superviseRun({ adapter: createRelayStubAdapter({ upstream: fake.baseURL, surface: true }), prompt: 'hi', store, relay: {} });
    assert.equal(out.outcome, 'ok');
    assert.equal(out.result.text, 'shown refusal');
    assert.equal(out.relay.status, COVERAGE.COVERED);
    assert.equal(compatRefusalStatus(out), 'pass');
  } finally { await fake.close(); cleanup(); }
});

for (const [route, reason] of [
  ['notCovered', /cannot be pointed/],
  ['none', /did not point its CLI at the relay/],
  ['ignore', /no provider request reached the relay; the CLI may ignore its base-URL override/],
]) {
  test(`supervisor: a CLI the relay cannot see (${route}) is not_covered, never covered`, async () => {
    const fake = await startFakeProvider({ script: [{ refuse: true, refuseAs: 'inband' }] });
    const { store, cleanup } = memoryStore();
    try {
      const out = await superviseRun({ adapter: createRelayStubAdapter({ upstream: fake.baseURL, route }), prompt: 'hi', store, relay: {} });
      // The refusal went unseen, so the run reads ok, and the status is what says so.
      assert.equal(out.outcome, 'ok');
      assert.equal(out.relay.status, COVERAGE.NOT_COVERED);
      assert.equal(out.relay.status, 'not_covered');
      assert.match(out.relay.reason, reason);
      assert.notEqual(out.relay.status, COVERAGE.COVERED);
      assert.equal(compatRefusalStatus(out), COMPAT_NOT_COVERED);
      assert.notEqual(compatRefusalStatus(out), 'pass');
      const verdict = store.readRun(out.runId).find((e) => e.type === 'provider.relay').data;
      assert.equal(verdict.status, 'not_covered');
      assert.match(verdict.reason, reason);
    } finally { await fake.close(); cleanup(); }
  });
}

test('coverage: the compat mapping never reads not_covered as a pass', () => {
  assert.equal(COMPAT_NOT_COVERED, 'not_covered');
  assert.equal(compatRefusalStatus({ outcome: 'ok' }), 'not_covered', 'no relay at all');
  assert.equal(compatRefusalStatus({ outcome: 'ok', relay: { status: 'not_covered', refusals: [] } }), 'not_covered');
  assert.equal(compatRefusalStatus({ outcome: 'ok', relay: { status: 'not_covered', refusals: [{ format: 'anthropic', signal: 'stop_reason' }] } }), 'not_covered');
  assert.equal(compatRefusalStatus({ outcome: 'ok', relay: { status: 'covered', refusals: [] } }), 'fail', 'covered, but the scripted refusal was never seen');
  assert.equal(compatRefusalStatus({ outcome: 'failed', failure: new RunFailure('refusal_dropped', 'x'), relay: { status: 'covered', refusals: [{}] } }), 'pass');
  assert.equal(compatRefusalStatus({ outcome: 'failed', failure: new RunFailure('exited', 'x'), relay: { status: 'covered', refusals: [] } }), 'fail');
  for (const name of ['startProviderRelay', 'COVERAGE', 'COMPAT_NOT_COVERED', 'compatRefusalStatus']) assert.ok(name in seats, name);
  assert.ok(seats.EVENT_TYPES.includes('provider.relay') && seats.EVENT_TYPES.includes('provider.refusal'));
});

test('supervisor: an adapter cannot forge the relay verdict events', async () => {
  const { store, cleanup } = memoryStore();
  try {
    const out = await superviseRun({
      adapter: { name: 'forger', async spawn(_p, ctx) { ctx.trace.emit('provider.relay', { status: 'covered' }); ctx.trace.emit('provider.refusal', { format: 'x' }); return { text: '' }; } },
      prompt: 'hi', store, relay: {},
    });
    const relayEvents = store.readRun(out.runId).filter((e) => e.type.startsWith('provider.'));
    assert.deepEqual(relayEvents.map((e) => e.data.status), ['not_covered']);
  } finally { cleanup(); }
});

// ── canaries: nothing the run wrote carries auth or content ────────────────

const filesUnder = (dir) => readdirSync(dir).flatMap((name) => {
  const path = join(dir, name);
  return statSync(path).isDirectory() ? filesUnder(path) : [path];
});

test('canary: no auth header value and no body content reaches any file the run wrote', async () => {
  await withTemp('canary', async (runDir) => {
    const canaries = {
      CANARY_AUTH: 'oauth-bearer-canary-5f0e1d',
      CANARY_KEY: 'sk-ant-api-canary-0c9b8a',
      CANARY_ACCOUNT: 'acct-canary-77e1',
      CANARY_BETA: 'oauth-2025-04-20,beta-canary-a1',
      CANARY_PROMPT: 'request-body-canary-4242',
      CANARY_REFUSAL: 'refusal-body-canary-1313',
      CANARY_REPLY: 'reply-body-canary-9090',
    };
    const stdoutPath = join(runDir, 'driver.stdout.log');
    const stderrPath = join(runDir, 'driver.stderr.log');
    const out = openSync(stdoutPath, 'w');
    const err = openSync(stderrPath, 'w');
    const code = await new Promise((resolve) => {
      const child = spawn(process.execPath, [DRIVER, runDir], {
        cwd: runDir,
        env: { ...process.env, ...canaries, HOME: runDir, TMPDIR: runDir, NODE_DEBUG: '' },
        stdio: ['ignore', out, err],
      });
      child.on('close', resolve);
    });
    closeSync(out);
    closeSync(err);
    assert.equal(code, 0, readFileSync(stderrPath, 'utf8'));
    const report = JSON.parse(readFileSync(stdoutPath, 'utf8').trim().split('\n').at(-1));
    assert.deepEqual(report.runs.map((r) => [r.outcome, r.kind, r.relay]), [
      ['failed', 'refusal_dropped', 'covered'],
      ['ok', null, 'covered'],
    ], 'both runs went through the relay, and the dropped refusal was caught');
    for (const name of ['CANARY_AUTH', 'CANARY_KEY', 'CANARY_ACCOUNT', 'CANARY_BETA', 'CANARY_PROMPT']) {
      assert.equal(report.reached[name], true, `${name} did reach the provider, so its absence below means something`);
    }

    const files = filesUnder(runDir);
    assert.ok(files.some((f) => f.includes(`${join('trace', 'runs')}`)), 'the trace store wrote run files');
    assert.ok(files.some((f) => f.endsWith('index.jsonl')));
    // The search can see a planted canary, so a clean result is not a blind one.
    const control = join(runDir, 'control.txt');
    writeFileSync(control, `x${canaries.CANARY_AUTH}y`);
    const hits = (needle) => filesUnder(runDir).filter((f) => readFileSync(f).includes(needle));
    assert.deepEqual(hits(canaries.CANARY_AUTH), [control]);
    rmSync(control);
    for (const [name, value] of Object.entries(canaries)) {
      const tokens = name === 'CANARY_BETA' ? [value, 'beta-canary-a1'] : [value];
      for (const token of tokens) assert.deepEqual(hits(token), [], `${name} is in no file the run wrote`);
    }
  });
});
