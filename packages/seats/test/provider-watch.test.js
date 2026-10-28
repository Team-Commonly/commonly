import { test } from 'node:test';
import assert from 'node:assert/strict';
import { failureForStatus, startProviderWatch } from '../src/provider-watch.js';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { RunFailure } from '../src/failures.js';
import { createServer } from 'node:http';

const KEY = ['sk', 'test', '0123456789abcdef'].join('-');

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
});

test('the relay passes healthy answers through, streamed and not, and keeps the base path', async () => {
  const w = await watched();
  try {
    assert.match(w.watch.baseURL, /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
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
  // An upstream that never answers and counts the connections held open.
  let open = 0;
  let seen = 0;
  const upstream = createServer(() => { seen += 1; });
  upstream.on('connection', (socket) => { open += 1; socket.on('close', () => { open -= 1; }); });
  await new Promise((resolve) => { upstream.listen(0, '127.0.0.1', resolve); });
  const failures = [];
  const watch = await startProviderWatch({
    baseURL: `http://127.0.0.1:${upstream.address().port}/v1`, onFailure: (failure) => failures.push(failure),
  });
  const waitUntil = async (predicate) => {
    const deadline = Date.now() + 10000;
    while (!predicate() && Date.now() < deadline) await new Promise((r) => { setTimeout(r, 10); });
  };
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

test('failureForStatus reads its own status prefix: a JSON body keeps only its named message', () => {
  const extra = 'x'.repeat(2000);
  for (const [status, kind] of [[401, 'refusal_retry_loop'], [503, 'provider_unavailable']]) {
    const failure = failureForStatus(status, JSON.stringify({ error: { message: 'model is overloaded' }, extra }));
    assert.equal(failure.kind, kind);
    assert.equal(failure.detail, `provider answered ${status}: model is overloaded`);
  }
  // A structured body with no named field contributes nothing; the status stays.
  assert.equal(failureForStatus(400, JSON.stringify({ trace: extra })).detail, 'provider answered 400');
});
