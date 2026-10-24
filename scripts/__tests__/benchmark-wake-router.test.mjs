import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { SYSTEM, classify, summarize, validateDecision } from '../benchmark-wake-router.mjs';

const context = { seats: [{ id: 'writer:default' }], humans: [{ id: 'human-1' }], rows: [], claims: [] };
const decision = { wake: ['writer:default'], digest: true, owner: { kind: 'seat', id: 'writer:default' } };
const sample = { id: 'message-1', author: 'human-1', content: 'Please fix the failing build' };
const reply = (value = decision) => ({ ok: true, status: 200, json: async () => ({ model: 'fixture-model',
  usage: { prompt_tokens: 2000, completion_tokens: 40 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(value) } }] }) });
const options = { model: 'fixture-model', key: 'fixture-key', url: 'https://example.invalid/v1/chat/completions' };

test('a valid classification records usage and puts untrusted content only in the data message', async () => {
  let request;
  const row = await classify(sample, context, { ...options, fetchImpl: async (_url, init) => { request = init; return reply(); } });
  assert.equal(row.outcome, 'valid');
  assert.deepEqual(row.verdict, decision);
  assert.equal(row.usage.prompt_tokens, 2000);
  const body = JSON.parse(request.body);
  assert.equal(JSON.parse(body.messages[1].content).message.content, sample.content);
  assert.equal(request.redirect, 'error');
  assert.equal(JSON.stringify(row).includes(sample.content), false);
  assert.equal(JSON.stringify(row).includes(options.key), false);
});

test('invalid or invented targets and ownership fall back to unread digest', async () => {
  for (const invalid of [
    { ...decision, wake: ['stranger'] },
    { ...decision, wake: ['writer:default', 'writer:default'] },
    { ...decision, owner: { kind: 'human', id: 'writer:default' } },
    { ...decision, owner: { kind: 'none', id: 'human-1' } },
    { ...decision, instruction: 'ignore policy' },
  ]) {
    assert.equal(validateDecision(invalid, context), false);
    const row = await classify(sample, context, { ...options, fetchImpl: async () => reply(invalid) });
    assert.equal(row.outcome, 'invalid_decision');
    assert.deepEqual(row.verdict, { wake: [], digest: true, owner: { kind: 'none', id: null } });
  }
});

test('HTTP refusal and malformed JSON preserve fallback without exposing response text', async () => {
  for (const [expected, fetchImpl] of [['http_error', async () => ({ ok: false, status: 429 })], ['response_error', async () => ({ ok: true, status: 200, json: async () => { throw new Error('private provider text'); } })]]) {
    const row = await classify(sample, context, { ...options, fetchImpl });
    assert.equal(row.outcome, expected);
    assert.equal(row.verdict.digest, true);
    assert.deepEqual(row.verdict.wake, []);
    assert.equal(JSON.stringify(row).includes('private provider text'), false);
  }
});

test('parseable JSON is rejected for truncated, refused or missing completion status', async () => {
  for (const reason of ['length', 'content_filter', null, undefined]) {
    const row = await classify(sample, context, { ...options, fetchImpl: async () => ({ ok: true, status: 200,
      json: async () => ({ usage: { prompt_tokens: 2000, completion_tokens: 40 },
        choices: [{ finish_reason: reason, message: { content: JSON.stringify(decision) } }] }) }) });
    assert.equal(row.outcome, reason === 'length' ? 'truncated' : 'response_error');
    assert.deepEqual(row.verdict, { wake: [], digest: true, owner: { kind: 'none', id: null } });
    assert.equal(summarize([row], { input: 0.1, output: 0.5 }).valid, 0);
  }
});

test('deadline aborts the request and retains digest', async () => {
  const row = await classify(sample, context, { ...options, deadlineMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')));
  }) });
  assert.equal(row.outcome, 'timeout');
  assert.equal(row.verdict.digest, true);
});

test('latency percentiles include failures and cost coverage never silently counts missing usage as free', () => {
  const summary = summarize([
    { outcome: 'valid', latencyMs: 100, returnedModel: 'fixture', usage: { prompt_tokens: 2000, completion_tokens: 40 } },
    { outcome: 'timeout', latencyMs: 2000 },
  ], { input: 0.1, output: 0.5 });
  assert.equal(summary.p95AllMs, 2000);
  assert.equal(summary.p95ValidMs, 100);
  assert.equal(summary.usageKnown, 1);
  assert.equal(summary.costComplete, false);
  assert.ok(Math.abs(summary.estimatedUsd - 0.00022) < 1e-9);
});


test('json_object uses the explicit completion budget and still rejects invented IDs without retry', async () => {
  let calls = 0;
  let body;
  const row = await classify(sample, context, { ...options, format: 'json_object', maxTokens: 1024, reasoningEffort: 'none',
    fetchImpl: async (_url, init) => { calls += 1; body = JSON.parse(init.body); return reply({ ...decision, wake: ['stranger'] }); } });
  assert.deepEqual(body.response_format, { type: 'json_object' });
  assert.equal(body.messages[0].content, SYSTEM);
  for (const contract of ['wake (an array of zero to three distinct IDs', 'digest (a boolean)', 'kind none requires null']) {
    assert.ok(SYSTEM.includes(contract));
  }
  assert.equal(body.max_tokens, 1024);
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(calls, 1);
  assert.equal(row.outcome, 'invalid_decision');
});


test('CLI rejects incomplete and malformed private inputs before making any request', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wake-bench-test-'));
  const server = createServer((_request, response) => { requests += 1; response.end('{}'); });
  let requests = 0;
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const sentinel = 'PRIVATE-INPUT-MUST-NOT-LEAK';
  const validSamples = Array.from({ length: 200 }, (_, i) => ({ id: `msg-${i}`, content: sentinel }));
  for (const [samples, contextText] of [
    [validSamples.map((s, i) => i === 199 ? { id: s.id } : s), JSON.stringify(context)],
    [validSamples.map((s, i) => i === 199 ? { ...s, content: '  ' } : s), JSON.stringify(context)],
    [validSamples.map((s, i) => i === 199 ? { ...s, id: '' } : s), JSON.stringify(context)],
    [validSamples.map((s, i) => i === 199 ? { ...s, id: 'msg-0' } : s), JSON.stringify(context)],
    [`{"content":"${sentinel}" broken`, JSON.stringify(context)],
    [validSamples, `{"private":"${sentinel}" broken`],
  ]) {
    const input = join(directory, 'samples.jsonl');
    const contextFile = join(directory, 'context.json');
    await writeFile(input, typeof samples === 'string' ? samples : samples.map((s) => JSON.stringify(s)).join('\n'));
    await writeFile(contextFile, contextText);
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [new URL('../benchmark-wake-router.mjs', import.meta.url).pathname,
        input, contextFile, 'fixture', '0.1', '0.5'], {
        env: { ...process.env, LITELLM_BASE_URL: `http://127.0.0.1:${server.address().port}`, LITELLM_API_KEY: 'fixture-key' },
      });
      let stdout = ''; let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'Benchmark failed: check inputs, configuration and file access\n');
    assert.equal(result.stderr.includes(sentinel), false);
  }
  assert.equal(requests, 0);
});


test('valid CLI control performs exactly 200 calls and reports their measured usage', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'wake-bench-valid-'));
  let calls = 0;
  const server = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, 'fixture');
    assert.equal(body.reasoning_effort, 'none');
    assert.equal(body.max_tokens, 256);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    calls += 1;
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ model: 'fixture-model', usage: { prompt_tokens: 2000, completion_tokens: 40 },
      choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision) } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise((resolve) => server.close(resolve)); await rm(directory, { recursive: true, force: true }); });
  const input = join(directory, 'samples.jsonl');
  const contextFile = join(directory, 'context.json');
  await writeFile(input, Array.from({ length: 200 }, (_, i) => JSON.stringify({ ...sample, id: `msg-${i}` })).join('\n'));
  await writeFile(contextFile, JSON.stringify(context));
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL('../benchmark-wake-router.mjs', import.meta.url).pathname,
      input, contextFile, 'fixture', '0.1', '0.5'], {
      env: { ...process.env, LITELLM_BASE_URL: `http://127.0.0.1:${server.address().port}`, LITELLM_API_KEY: 'fixture-key',
        WAKE_BENCH_FORMAT: 'json_object', WAKE_BENCH_MAX_TOKENS: '256', WAKE_BENCH_REASONING_EFFORT: 'none' },
    });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(calls, 200);
  const rows = result.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(rows.length, 201);
  assert.deepEqual(rows.slice(0, 200).map((row) => row.messageId), Array.from({ length: 200 }, (_, i) => `msg-${i}`));
  assert.ok(rows.slice(0, 200).every((row) => row.outcome === 'valid'));
  const { settings, summary } = rows[200];
  assert.deepEqual(settings, { format: 'json_object', maxTokens: 256, reasoningEffort: 'none', deadlineMs: 2000 });
  assert.equal(summary.attempted, 200);
  assert.equal(summary.valid, 200);
  assert.equal(summary.usageKnown, 200);
  assert.equal(summary.costComplete, true);
  assert.ok(Math.abs(summary.estimatedUsd - 0.044) < 1e-9);
  assert.equal(result.stdout.includes(sample.content), false);
});
