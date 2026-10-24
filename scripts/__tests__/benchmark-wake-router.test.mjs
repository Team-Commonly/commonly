import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, summarize, validateDecision } from '../benchmark-wake-router.mjs';

const context = { seats: [{ id: 'writer:default' }], humans: [{ id: 'human-1' }], rows: [], claims: [] };
const decision = { wake: ['writer:default'], digest: true, owner: { kind: 'seat', id: 'writer:default' } };
const sample = { id: 'message-1', author: 'human-1', content: 'Please fix the failing build' };
const reply = (value = decision) => ({ ok: true, status: 200, json: async () => ({ model: 'fixture-model',
  usage: { prompt_tokens: 2000, completion_tokens: 40 }, choices: [{ message: { content: JSON.stringify(value) } }] }) });
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
  for (const fetchImpl of [async () => ({ ok: false, status: 429 }), async () => ({ ok: true, status: 200, json: async () => { throw new Error('private provider text'); } })]) {
    const row = await classify(sample, context, { ...options, fetchImpl });
    assert.equal(row.verdict.digest, true);
    assert.deepEqual(row.verdict.wake, []);
    assert.equal(JSON.stringify(row).includes('private provider text'), false);
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
