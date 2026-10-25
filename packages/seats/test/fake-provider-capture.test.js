// Capture: every request is recorded with redacted auth, and findInRequests
// finds a canary wherever it reached the provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { post } from './fake-provider-helpers.js';

test('each model request is recorded as {format, path, headers, body, receivedAt} with auth redacted to its scheme', async () => {
  const fake = await startFakeProvider();
  try {
    const before = Date.now();
    await post(`${fake.baseURL}/chat/completions`, { model: 'm', messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer sk-secret-1' });
    await post(`${fake.anthropicBaseURL}/v1/messages`, { messages: [{ role: 'user', content: 'hi' }] }, { 'x-api-key': 'sk-secret-2', cookie: 'sid=sk-secret-3' });
    const [chatReq, anthReq] = fake.requests;
    assert.equal(chatReq.format, 'openai-chat');
    assert.equal(chatReq.path, '/v1/chat/completions');
    assert.deepEqual(chatReq.body, { model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(chatReq.receivedAt >= before);
    assert.equal(chatReq.headers.authorization, 'Bearer');
    assert.equal(chatReq.authorization, 'present', 'the older field keeps its meaning');
    assert.equal(anthReq.headers['x-api-key'], '[redacted]');
    assert.equal(anthReq.headers.cookie, '[redacted]');
    assert.deepEqual(anthReq.auth, { header: 'x-api-key', scheme: 'x-api-key' });
    assert.doesNotMatch(JSON.stringify(fake.allRequests), /sk-secret/, 'no secret survives in the record');
  } finally { await fake.close(); }
});

test('requests holds model calls only; allRequests holds every HTTP request', async () => {
  const fake = await startFakeProvider();
  try {
    const models = await (await fetch(`${fake.baseURL}/models`)).json();
    assert.equal(models.data[0].id, 'fake-model');
    assert.equal(models.data[0].type, 'model', 'readable as an Anthropic model list too');
    assert.equal((await fetch(`${fake.origin}/nope`, { method: 'POST', body: '{}' })).status, 404);
    await post(`${fake.baseURL}/responses`, { input: 'hi' });
    assert.equal(fake.requests.length, 1);
    assert.deepEqual(fake.allRequests.map((r) => `${r.method} ${r.path} ${r.format}`), ['GET /v1/models null', 'POST /nope null', 'POST /v1/responses openai-responses']);
  } finally { await fake.close(); }
});

test('findInRequests finds a canary in a body, a header (even a redacted one) and a URL, and nothing else', async () => {
  const fake = await startFakeProvider();
  try {
    await post(`${fake.anthropicBaseURL}/v1/messages`, { messages: [{ role: 'user', content: 'leak CANARY-BODY-1 here' }] });
    await post(`${fake.baseURL}/chat/completions`, { messages: [{ role: 'user', content: 'hi' }] }, { authorization: 'Bearer CANARY-HDR-2' });
    await fetch(`${fake.baseURL}/models?k=CANARY-URL-3`);
    // A JSON-escaped canary is still found through the parsed body.
    await fetch(`${fake.baseURL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"input":"\\u0043ANARY-ESC-4"}' });
    assert.deepEqual(fake.findInRequests('CANARY-BODY-1').map((h) => [h.index, h.where, h.format]), [[0, 'body', 'anthropic']]);
    assert.deepEqual(fake.findInRequests('CANARY-HDR-2').map((h) => [h.index, h.where]), [[1, 'header:authorization']]);
    assert.deepEqual(fake.findInRequests('CANARY-URL-3').map((h) => [h.index, h.where, h.path]), [[2, 'url', '/v1/models']]);
    assert.deepEqual(fake.findInRequests('CANARY-ESC-4').map((h) => h.where), ['body']);
    assert.equal(fake.findInRequests(/CANARY-[A-Z]+-\d/).length, 4);
    assert.deepEqual(fake.findInRequests('CANARY-NEVER-SENT'), []);
  } finally { await fake.close(); }
});

test('a compressed request body is decoded before it is recorded and searched', async () => {
  const fake = await startFakeProvider({ script: ['ok'] });
  try {
    const body = gzipSync(Buffer.from(JSON.stringify({ input: 'zipped CANARY-GZ-5' })));
    const res = await fetch(`${fake.baseURL}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, body });
    assert.equal((await res.json()).output[0].content[0].text, 'ok');
    assert.equal(fake.requests[0].body.input, 'zipped CANARY-GZ-5');
    assert.equal(fake.findInRequests('CANARY-GZ-5').length, 1);
  } finally { await fake.close(); }
});
