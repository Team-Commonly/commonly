// Trip mode of the provider relay: the first failing provider answer to a POST
// ends the attempt. The first eight tests are the provider watch's own tests,
// run through `startProviderWatch` written as a thin caller of the relay (the
// exact shape below), so the watch can become that caller without a behaviour
// change. The rest pin what the merge adds: verdicts only in the trace, a fresh
// trip state per attempt, and the supervisor carrying the trip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, readdirSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { failureForStatus, startProviderRelay } from '../src/wire/provider-relay.js';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { createRelayStubAdapter } from '../test-support/relay-stub-adapter.js';
import { RunFailure, FAILURE_KINDS } from '../src/failures.js';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';

// The thin caller provider-watch.js becomes. Kept here verbatim so these tests
// prove that shape, not a lookalike.
const startProviderWatch = async ({ baseURL, onFailure, credentials = [] }) => {
  const relay = await startProviderRelay({ credentials });
  const url = relay.handle.bind({ upstream: baseURL, onTrip: onFailure });
  return { baseURL: url, get tripped() { return relay.tripped; }, close: () => relay.close() };
};

const KEY = 'sk-test-0123456789abcdef';

const post = (baseURL, content, { stream = false, signal } = {}) => fetch(`${baseURL}/chat/completions`, {
  method: 'POST',
  signal,
  headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
  body: JSON.stringify({ model: 'fake-model', stream, messages: [{ role: 'user', content }] }),
});

const watched = async () => {
  const provider = await startFakeProvider();
  const failures = [];
  const watch = await startProviderWatch({
    baseURL: provider.baseURL, credentials: [KEY], onFailure: (failure) => failures.push(failure),
  });
  return {
    provider, watch, failures, close: async () => { await watch.close(); await provider.close(); },
  };
};

const waitUntil = async (predicate) => {
  const deadline = Date.now() + 10000;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => { setTimeout(r, 10); });
};

// ── the provider watch's tests, through the thin caller ─────────────────────

test('failureForStatus: 4xx is refusal_retry_loop; 5xx, 408 and 429 are provider_unavailable; 2xx/3xx are fine', () => {
  for (const status of [400, 401, 403, 404, 422]) assert.equal(failureForStatus(status, '').kind, 'refusal_retry_loop', String(status));
  for (const status of [408, 429, 500, 502, 503, 504]) assert.equal(failureForStatus(status, '').kind, 'provider_unavailable', String(status));
  for (const status of [200, 201, 204, 301, 399]) assert.equal(failureForStatus(status, ''), null, String(status));
  assert.equal(failureForStatus(400, '').retryable, false);
  assert.equal(failureForStatus(503, '').retryable, true);
});

test('failureForStatus scrubs a credential the provider echoed back', () => {
  const failure = failureForStatus(401, JSON.stringify({ error: { message: `bad key ${KEY}` } }), { credentials: [KEY] });
  assert.ok(failure instanceof RunFailure);
  assert.ok(!failure.message.includes(KEY), failure.message);
  assert.ok(!failure.providerMessage.includes(KEY), failure.providerMessage);
});

test('the relay passes healthy answers through, streamed and not, and keeps the base path', async () => {
  const w = await watched();
  try {
    assert.match(w.watch.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_-]+\/v1$/);
    const plain = await post(w.watch.baseURL, 'hi');
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).choices[0].message.content, 'PONG');
    const streamed = await post(w.watch.baseURL, '[[reply:STREAMED]]', { stream: true });
    assert.match(await streamed.text(), /STREAMED[\s\S]*\[DONE\]/);
    assert.equal(w.provider.requests.length, 2);
    assert.equal(w.provider.requests[0].url, '/v1/chat/completions');
    assert.equal(w.provider.requests[0].authorization, 'present');
    assert.equal(w.failures.length, 0);
    assert.equal(w.watch.tripped, null);
  } finally { await w.close(); }
});

test('the first refusal trips once, its body reaches the CLI, and nothing more is forwarded', async () => {
  const w = await watched();
  try {
    const first = await post(w.watch.baseURL, '[[refuse]]');
    assert.equal(first.status, 400);
    assert.match(JSON.stringify(await first.json()), /content policy/, 'the CLI still sees the real error body');
    assert.equal(w.failures.length, 1);
    assert.equal(w.failures[0].kind, 'refusal_retry_loop');
    assert.match(w.failures[0].detail, /400/);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assert.equal((await post(w.watch.baseURL, '[[refuse]]')).status, 503);
    }
    assert.equal(w.provider.requests.length, 1, 'retries after the trip never reach the provider');
    assert.equal(w.failures.length, 1, 'onFailure fires once');
    assert.equal(w.watch.tripped, w.failures[0]);
  } finally { await w.close(); }
});

test('the first 503 trips as provider_unavailable', async () => {
  const w = await watched();
  try {
    assert.equal((await post(w.watch.baseURL, '[[fail:503]]')).status, 503);
    assert.deepEqual(w.failures.map((failure) => failure.kind), ['provider_unavailable']);
  } finally { await w.close(); }
});

test('a failing GET is relayed but never judged', async () => {
  const w = await watched();
  try {
    const listing = await fetch(`${w.watch.baseURL}/models`);
    assert.equal(listing.status, 200);
    const missing = await fetch(`${w.watch.baseURL}/no-such-thing`);
    assert.equal(missing.status, 404);
    assert.equal(w.failures.length, 0);
  } finally { await w.close(); }
});

test('an unreachable provider trips as provider_unavailable on the first POST', async () => {
  const failures = [];
  const watch = await startProviderWatch({ baseURL: 'http://127.0.0.1:9/v1', onFailure: (failure) => failures.push(failure) });
  try {
    await post(watch.baseURL, 'hi').catch(() => null);
    assert.deepEqual(failures.map((failure) => failure.kind), ['provider_unavailable']);
  } finally { await watch.close(); }
});

test('a client that hangs up takes its upstream request with it', async () => {
  let open = 0;
  let seen = 0;
  const upstream = createServer(() => { seen += 1; });
  upstream.on('connection', (socket) => { open += 1; socket.on('close', () => { open -= 1; }); });
  await new Promise((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
  const failures = [];
  const watch = await startProviderWatch({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, onFailure: (failure) => failures.push(failure),
  });
  try {
    const controller = new AbortController();
    const held = post(watch.baseURL, 'hi', { signal: controller.signal }).catch(() => null);
    await waitUntil(() => seen === 1);
    assert.equal(open, 1);
    controller.abort();
    await held;
    await waitUntil(() => open === 0);
    assert.equal(open, 0, 'the relay dropped the upstream request when the client hung up');
    assert.equal(failures.length, 0, 'a hang-up is not a provider failure');
  } finally {
    await watch.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => { upstream.close(resolve); });
  }
});

// ── what the merge adds ──────────────────────────────────────────────────────

test('a GET is relayed and never judged, even a 5xx, and a POST after it still is', async () => {
  let gets = 0;
  const upstream = createServer((req, res) => {
    req.resume();
    if (req.method === 'GET') {
      gets += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"overloaded_error","message":"busy"}}');
      return;
    }
    req.on('end', () => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":{"type":"api_error","message":"boom"}}');
    });
  });
  await new Promise((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
  const failures = [];
  const watch = await startProviderWatch({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, onFailure: (failure) => failures.push(failure),
  });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await fetch(`${watch.baseURL}/models`)).status, 503);
    assert.equal(gets, 3, 'every GET reached the provider: none tripped the relay');
    assert.equal(failures.length, 0);
    assert.equal((await post(watch.baseURL, 'hi')).status, 500);
    assert.deepEqual(failures.map((f) => f.kind), ['provider_unavailable']);
  } finally {
    await watch.close();
    upstream.closeAllConnections();
    await new Promise((resolve) => { upstream.close(resolve); });
  }
});

test('a trip names the status and the error identifiers, and keeps the message text off the detail', () => {
  const body = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', code: 'content_policy', message: 'secret refusal words' } });
  const failure = failureForStatus(400, body);
  assert.equal(failure.detail, 'provider answered 400 (type invalid_request_error, code content_policy)');
  assert.ok(!failure.message.includes('secret refusal words'));
  assert.equal(failure.providerMessage, 'secret refusal words');
  // An identifier that is really prose is dropped, not carried.
  const prose = failureForStatus(429, JSON.stringify({ error: { type: 'you have hit a limit, try later', message: 'x' } }));
  assert.equal(prose.detail, 'provider answered 429');
});

test('without onTrip the relay never trips: a failing answer is relayed and the attempt goes on', async () => {
  const provider = await startFakeProvider();
  const relay = await startProviderRelay();
  try {
    const base = relay.handle.bind({ upstream: provider.baseURL });
    assert.equal((await post(base, '[[refuse]]')).status, 400);
    assert.equal((await post(base, 'hi')).status, 200);
    assert.equal(relay.tripped, null);
    assert.equal(relay.verdict.tripped, undefined);
  } finally { await relay.close(); await provider.close(); }
});

test('a trip belongs to its attempt: the next attempt forwards again', async () => {
  const provider = await startFakeProvider();
  const relay = await startProviderRelay();
  const trips = [];
  try {
    let base = relay.handle.bind({ upstream: provider.baseURL, onTrip: (f) => trips.push(f) });
    assert.equal((await post(base, '[[fail:503]]')).status, 503);
    assert.equal((await post(base, 'hi')).status, 503, 'stopped locally after the trip');
    assert.deepEqual(relay.verdict.tripped, { kind: 'provider_unavailable', status: 503 });
    relay.beginAttempt();
    assert.equal(relay.tripped, null);
    base = relay.handle.bind({ upstream: provider.baseURL, onTrip: (f) => trips.push(f) });
    assert.equal((await post(base, 'hi')).status, 200);
    assert.equal(trips.length, 1);
    assert.equal(provider.requests.length, 2);
  } finally { await relay.close(); await provider.close(); }
});

test('supervised: a trip ends the run with its kind, and no file the run wrote carries the provider message', async () => {
  const CANARY_MESSAGE = 'CANARY-PROVIDER-MESSAGE-7f3a9c';
  const CANARY_KEY = 'sk-canary-trip-5b2e81d0';
  const provider = await startFakeProvider({
    script: [{ error: { status: 400, type: 'invalid_request_error', message: CANARY_MESSAGE } }],
  });
  const dir = mkdtempSync(join(tmpdir(), 'seats-relay-trip-'));
  try {
    const store = createTraceStore({ root: join(dir, 'trace') });
    const adapter = createRelayStubAdapter({
      upstream: provider.baseURL, wire: 'chat', trip: true, headers: { authorization: `Bearer ${CANARY_KEY}` },
    });
    const run = await superviseRun({ adapter, prompt: 'hello', store, relay: {} });
    assert.equal(run.outcome, 'failed');
    assert.equal(run.failure.kind, 'refusal_retry_loop');
    assert.equal(FAILURE_KINDS[run.failure.kind].retryable, false);
    assert.equal(run.failure.providerMessage, CANARY_MESSAGE, 'the message is held in memory');
    assert.deepEqual(run.relay.tripped, { kind: 'refusal_retry_loop', status: 400 });
    assert.equal(provider.findInRequests(CANARY_KEY).length > 0, true, 'positive control: the auth reached the provider');

    const events = store.readRun(run.runId);
    const relayEvent = events.find((e) => e.type === 'provider.relay');
    assert.equal(relayEvent.data.tripped, 'refusal_retry_loop');
    const settled = events.at(-1);
    assert.equal(settled.type, 'run.settled');
    assert.equal(settled.data.failure.kind, 'refusal_retry_loop');
    assert.match(settled.data.failure.detail, /^provider answered 400/);

    const files = [];
    const walk = (p) => {
      if (statSync(p).isDirectory()) { for (const name of readdirSync(p)) walk(join(p, name)); } else files.push(p);
    };
    walk(dir);
    assert.ok(files.length >= 2, `the run wrote its trace (${files.length} files)`);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      assert.ok(!text.includes(CANARY_MESSAGE), `${file} carries the provider message`);
      assert.ok(!text.includes(CANARY_KEY), `${file} carries the auth`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await provider.close();
  }
});
