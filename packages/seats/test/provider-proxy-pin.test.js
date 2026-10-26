import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startProviderProxy } from '../src/wire/provider-proxy.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const PIN = 'deepseek-flash-1017';
const KEY = 'test-provider-key-aaaaaaaaaaaaaaaa';

// `pinnedModel: null` runs the proxy with no pin at all.
const withProxy = async ({ provider: providerOptions = {}, pinnedModel = PIN } = {}, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-pin-'));
  const provider = await startFakeProvider({ model: PIN, ...providerOptions });
  const proxy = await startProviderProxy({
    provider: { baseURL: provider.baseURL }, keyMaterial: KEY,
    tokenFile: join(dir, 'token'), adapterLabel: 'test', pinnedModel: pinnedModel ?? undefined,
  });
  const { readFileSync } = await import('node:fs');
  const bearer = readFileSync(proxy.tokenFile, 'utf8').trim();
  const complete = (body) => fetch(`${proxy.baseURL.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], ...body }),
  });
  try { return await fn({ complete, proxy, provider }); } finally {
    await proxy.close(); await provider.close(); rmSync(dir, { recursive: true, force: true });
  }
};

// Every byte that arrived before the stream ended or was cut; a cut that lands
// before the headers flush is a failed fetch, which delivered nothing.
const received = async (pending) => {
  let res;
  try { res = await pending; } catch { return { status: null, text: '' }; }
  const chunks = [];
  const reader = res.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } catch { /* cut mid-stream */ }
  return { status: res.status, text: Buffer.concat(chunks).toString('utf8') };
};

// Stderr carries the proxy's refusals; keep test output clean.
const quiet = async (fn) => {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try { return await fn(); } finally { process.stderr.write = write; }
};

test('the pinned model is served, stream and not: the reply passes and the verdict is clean', async () => {
  await withProxy({}, async ({ complete, proxy, provider }) => {
    const plain = await complete({ model: PIN });
    assert.equal(plain.status, 200);
    assert.equal((await plain.json()).choices[0].message.content, 'PONG');
    const streamed = await complete({ model: PIN, stream: true });
    assert.equal(streamed.status, 200);
    assert.match(await streamed.text(), /"content":"PONG"[\s\S]*\[DONE\]/);
    assert.deepEqual(proxy.modelCheck(), { pinned: PIN, requested: [PIN], served: [PIN], refused: 0, failures: [] });
    assert.deepEqual(provider.requests.map((r) => r.authorization), ['present', 'present']);
  });
});

test('a completion for another model is refused before it reaches the provider', async () => {
  await quiet(() => withProxy({}, async ({ complete, proxy, provider }) => {
    const res = await complete({ model: 'deepseek-pro' });
    assert.equal(res.status, 403);
    assert.equal(provider.requests.length, 0);
    const missing = await complete({});
    assert.equal(missing.status, 403);
    assert.equal(proxy.modelCheck().refused, 2);
  }));
});

test('a substituted model fails the check: a whole body is withheld, a stream is cut before the chunk', async () => {
  await quiet(() => withProxy({ provider: { servedModel: 'deepseek-flash-0901' } }, async ({ complete, proxy }) => {
    const plain = await received(complete({ model: PIN }));
    assert.equal(plain.status, 502);
    assert.doesNotMatch(plain.text, /PONG|0901/);
    // The first chunk already names the substitute: not one byte of it is released.
    const streamed = await received(complete({ model: PIN, stream: true }));
    assert.doesNotMatch(streamed.text, /PONG|0901|chat\.completion/);
    const check = proxy.modelCheck();
    assert.deepEqual(check.served, ['deepseek-flash-0901']);
    assert.equal(check.failures.length, 2);
    assert.match(check.failures[0], /served model "deepseek-flash-0901" is not the pinned "deepseek-flash-1017"/);
  }));
});

test('a reply that names no model cannot be verified, so it fails closed', async () => {
  await quiet(() => withProxy({ provider: { servedModel: null } }, async ({ complete, proxy }) => {
    const plain = await complete({ model: PIN });
    assert.equal(plain.status, 502);
    const streamed = await received(complete({ model: PIN, stream: true }));
    assert.doesNotMatch(streamed.text, /\[DONE\]/);
    const check = proxy.modelCheck();
    assert.deepEqual(check.served, []);
    assert.equal(check.failures.length, 2);
    assert.match(check.failures[1], /named no model/);
  }));
});

test('an echoed provider key is still redacted on the pinned path', async () => {
  await withProxy({ provider: { echoAuthorization: true } }, async ({ complete }) => {
    const plain = await complete({ model: PIN });
    const text = (await plain.json()).choices[0].message.content;
    assert.equal(text, 'Bearer [redacted]');
    const streamed = await (await complete({ model: PIN, stream: true })).text();
    assert.doesNotMatch(streamed, new RegExp(KEY));
    assert.match(streamed, /Bearer \[redacted\]/);
  });
});

test('without a pin the proxy is unchanged: any model passes and nothing is checked', async () => {
  await withProxy({ pinnedModel: null, provider: { servedModel: 'something-else' } }, async ({ complete, proxy }) => {
    const res = await complete({ model: 'any-model' });
    assert.equal(res.status, 200);
    assert.equal((await res.json()).model, 'something-else');
    assert.deepEqual(proxy.modelCheck(), { pinned: null, requested: [], served: [], refused: 0, failures: [] });
  });
});

test('a pin must be a non-empty string', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-pin-'));
  try {
    writeFileSync(join(dir, 'unused'), '');
    await assert.rejects(startProviderProxy({
      provider: { baseURL: 'http://127.0.0.1:9/v1' }, keyMaterial: KEY, tokenFile: join(dir, 't'), pinnedModel: ' ',
    }), /pinnedModel must be a non-empty string/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
