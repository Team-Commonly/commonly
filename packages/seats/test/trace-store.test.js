import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { EVENT_TYPES, traceOf, NULL_TRACE } from '../src/trace/events.js';
import { RunFailure, runFailure, FAILURE_KINDS } from '../src/failures.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const withRoot = (fn) => { const root = mkdtempSync(join(tmpdir(), 'seats-trace-')); try { return fn(root); } finally { rmSync(root, { recursive: true, force: true }); } };

test('a run appends events in seq order, settles once, and lists newest first', () => withRoot((root) => {
  let t = 0;
  const store = createTraceStore({ root, now: () => new Date(Date.UTC(2026, 9, 25, 0, 0, t++)) });
  const a = store.startRun({ runId: 'run-aaaaaa', adapter: 'stub' });
  a.emit('run.started', { adapter: 'stub', attempt: 1 });
  a.emit('agent.message_chunk', { text: 'PO' });
  a.emit('agent.message_chunk', { text: 'NG' });
  a.emit('run.settled', { outcome: 'ok', durationMs: 5, attempts: 1 });
  assert.equal(a.emit('agent.message_chunk', { text: 'late' }), null, 'nothing is written after settle');
  const b = store.startRun({ runId: 'run-bbbbbb', adapter: 'stub' });
  b.emit('run.started', { adapter: 'stub', attempt: 1 });

  assert.deepEqual(store.readRun('run-aaaaaa').map((e) => [e.seq, e.type]), [
    [1, 'run.started'], [2, 'agent.message_chunk'], [3, 'agent.message_chunk'], [4, 'run.settled']]);
  assert.deepEqual(store.listRuns().map((r) => [r.runId, r.outcome]), [['run-bbbbbb', 'running'], ['run-aaaaaa', 'ok']]);
  assert.equal(statSync(join(root, 'runs', 'run-aaaaaa.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'runs')).mode & 0o777, 0o700);
}));

test('unknown event types, duplicate and unsafe run ids are refused', () => withRoot((root) => {
  const store = createTraceStore({ root });
  const run = store.startRun({ runId: 'run-cccccc' });
  assert.throws(() => run.emit('made.up', {}), /unknown trace event type/);
  assert.throws(() => store.startRun({ runId: 'run-cccccc' }), /already exists/);
  assert.throws(() => store.startRun({ runId: '../escape' }), /runId/);
  assert.equal(store.readRun('../etc/passwd'), null);
  assert.ok(EVENT_TYPES.includes('liveness.stalled'));
}));

test('traceOf falls back to a no-op hook', () => {
  assert.equal(traceOf({}), NULL_TRACE);
  const hook = { emit() {} };
  assert.equal(traceOf({ trace: hook }), hook);
});

test('failures carry a kind, a retry flag, and scrub known credentials', () => {
  const error = runFailure('refusal', 'provider said no to sk-or-v1-secretsecretsecret', { credentials: ['sk-or-v1-secretsecretsecret'] });
  assert.ok(error instanceof RunFailure);
  assert.equal(error.kind, 'refusal');
  assert.equal(error.retryable, false);
  assert.doesNotMatch(error.message, /secretsecret/);
  assert.equal(FAILURE_KINDS.stuck.retryable, true);
  assert.throws(() => new RunFailure('nope'), /unknown failure kind/);
});

test('fake provider answers stream and non-stream turns and honours directives', async () => {
  const fake = await startFakeProvider();
  try {
    const post = (body) => fetch(`${fake.baseURL}/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const plain = await (await post({ model: 'fake-model', messages: [{ role: 'user', content: 'hi' }] })).json();
    assert.equal(plain.choices[0].message.content, 'PONG');
    const custom = await (await post({ messages: [{ role: 'user', content: 'say [[reply:PONG-7]]' }] })).json();
    assert.equal(custom.choices[0].message.content, 'PONG-7');
    const streamed = await (await post({ stream: true, messages: [{ role: 'user', content: 'hi' }] })).text();
    assert.match(streamed, /"content":"PONG"/);
    assert.match(streamed, /data: \[DONE\]/);
    assert.equal((await post({ messages: [{ role: 'user', content: '[[refuse]]' }] })).status, 400);
    const controller = new AbortController();
    const stalled = post({ messages: [{ role: 'user', content: '[[stall]]' }] });
    setTimeout(() => controller.abort(), 50);
    const outcome = await Promise.race([stalled.then(() => 'answered'), new Promise((r) => setTimeout(() => r('held'), 150))]);
    assert.equal(outcome, 'held');
    assert.deepEqual(fake.requests.map((r) => r.directive), ['reply', 'reply', 'reply', 'refuse', 'stall']);
  } finally { await fake.close(); }
});
