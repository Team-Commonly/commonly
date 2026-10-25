import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { verifyRecord } from '../src/record/format.js';

const AGENT = { type: 'agent', id: 'u-agent-ana', owner: 'u-ana', name: "Ana's agent" };
const withStore = (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-record-'));
  let tick = Date.UTC(2026, 9, 25, 12, 0, 0);
  try { return fn(createTraceStore({ root, now: () => new Date((tick += 1000)) }), root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const fileOf = (root, runId) => join(root, 'runs', `${runId}.jsonl`);
const grantMeta = (grantId, extra = {}) => ({
  grantId, scope: { connectionId: 'conn-1', tools: ['sentry.get_issue'], audience: ['u-ana'] }, issuedBy: 'u-ana', ...extra,
});

test('readRun keeps the trace shape (type, data, runId, seq, ts) and adds the envelope', () => withStore((store) => {
  const run = store.startRun({ runId: 'run-st-0001', adapter: 'fake', taskId: 'TASK-9', podId: 'pod-a', actor: AGENT });
  run.emit('run.started', { adapter: 'fake', attempt: 1 });
  run.emit('agent.message_chunk', { text: 'hi' });
  run.emit('run.settled', { outcome: 'ok', durationMs: 5, attempts: 1 });
  const events = store.readRun('run-st-0001');
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'agent.message_chunk', 'run.settled']);
  assert.deepEqual(events.map((e) => e.kind), ['attempt.started', 'agent.message_chunk', 'run.settled']);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  for (const event of events) {
    assert.equal(event.runId, 'run-st-0001');
    assert.equal(event.taskId, 'TASK-9');
    assert.equal(event.podId, 'pod-a');
    assert.equal(typeof event.ts, 'string');
    assert.equal(event.v, 1);
  }
  assert.deepEqual(events[0].actor, AGENT);
  assert.deepEqual(events[0].data, { adapter: 'fake', attempt: 1 });
  const row = store.listRuns().find((r) => r.runId === 'run-st-0001');
  assert.equal(row.outcome, 'ok');
  assert.equal(row.taskId, 'TASK-9');
  assert.equal(row.entries, 3);
  assert.equal(store.verifyRun('run-st-0001').ok, true);
}));

test('startRun refuses a taskId without a podId, and a display name as actor id', () => withStore((store) => {
  assert.throws(() => store.startRun({ runId: 'run-st-0002', taskId: 'TASK-9' }), /needs a podId/);
  assert.throws(() => store.startRun({ runId: 'run-st-0003', actor: { type: 'agent', id: 'Ana agent' } }), /actor.id/);
}));

test('emit: unknown types throw, and nothing is written after run.settled', () => withStore((store) => {
  const run = store.startRun({ runId: 'run-st-0004' });
  assert.throws(() => run.emit('made.up', {}), /unknown trace event type/);
  run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
  assert.equal(run.emit('usage', {}), null);
  assert.equal(store.readRun('run-st-0004').length, 1);
}));

test('files are 0600 and directories 0700', () => withStore((store, root) => {
  store.startRun({ runId: 'run-st-0005' }).emit('usage', {});
  assert.equal(statSync(join(root, 'runs')).mode & 0o777, 0o700);
  assert.equal(statSync(fileOf(root, 'run-st-0005')).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, 'index.jsonl')).mode & 0o777, 0o600);
}));

test('verifyRun: a torn last line is reported', () => withStore((store, root) => {
  const run = store.startRun({ runId: 'run-st-0006' });
  run.emit('usage', {});
  run.emit('usage', {});
  appendFileSync(fileOf(root, 'run-st-0006'), '{"v":1,"schema":"seats.rec');
  const result = store.verifyRun('run-st-0006');
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors, [{ seq: 3, reason: 'torn' }]);
  assert.equal(store.readRun('run-st-0006').length, 2, 'readRun still returns the whole lines');
}));

test('verifyRun: the index head catches an edited or dropped last line', () => withStore((store, root) => {
  const run = store.startRun({ runId: 'run-st-0007' });
  run.emit('usage', { inputTokens: 1 });
  run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
  const path = fileOf(root, 'run-st-0007');
  const original = readFileSync(path, 'utf8');
  writeFileSync(path, original.replace('"durationMs":1', '"durationMs":2'));
  assert.equal(verifyRecord(readFileSync(path, 'utf8')).ok, true, 'the chain alone cannot see an edit to the last line');
  assert.deepEqual(store.verifyRun('run-st-0007').errors, [{ seq: 2, reason: 'head_mismatch' }]);
  writeFileSync(path, original.split('\n').slice(0, 1).join('\n').concat('\n'));
  assert.deepEqual(store.verifyRun('run-st-0007').errors.map((e) => e.reason), ['count_mismatch']);
}));

test('a failed append breaks the run: later emits throw instead of chaining past an unknown tail', () => withStore((store, root) => {
  const run = store.startRun({ runId: 'run-st-0008' });
  run.emit('usage', {});
  chmodSync(fileOf(root, 'run-st-0008'), 0o400);
  try {
    assert.throws(() => run.emit('usage', {}));
    chmodSync(fileOf(root, 'run-st-0008'), 0o600);
    assert.throws(() => run.emit('usage', {}), /broken/);
  } finally { chmodSync(fileOf(root, 'run-st-0008'), 0o600); }
}));

test('task.done ends every grant bound to the task, in one grant.revoked written by the board', () => withStore((store) => {
  const run = store.startRun({ runId: 'run-st-0009', taskId: 'TASK-9', podId: 'pod-a', actor: AGENT });
  run.emit('grant.issued', { ...grantMeta('g-bound-1'), binding: { taskId: 'TASK-9', podId: 'pod-a', endsOn: 'task.done' } });
  run.emit('grant.issued', { ...grantMeta('g-bound-2'), binding: { taskId: 'TASK-9', podId: 'pod-a', endsOn: 'task.done' } });
  run.emit('grant.issued', {
    ...grantMeta('g-timed', { expiresAt: '2026-10-25T23:00:00Z' }), binding: { taskId: 'TASK-9', podId: 'pod-a', endsOn: 'expiresAt' },
  });
  run.emit('grant.issued', grantMeta('g-free'));
  run.emit('task.done', { doneBy: 'u-ben' });
  const events = store.readRun('run-st-0009');
  const [done, revoked] = events.slice(-2);
  assert.equal(done.kind, 'task.done');
  assert.deepEqual(done.actor, { type: 'system', id: 'board' });
  assert.equal(revoked.kind, 'grant.revoked');
  assert.deepEqual(revoked.data, { grantIds: ['g-bound-1', 'g-bound-2'], reason: 'task.done' });
  assert.deepEqual(revoked.actor, { type: 'system', id: 'board' });
  assert.deepEqual(run.openGrants(), ['g-timed', 'g-free']);
}));

test('revokeGrant: a lineage is one cascade entry; a lone grant is manual', () => withStore((store) => {
  const run = store.startRun({ runId: 'run-st-0010' });
  run.emit('grant.issued', grantMeta('g-root'));
  run.emit('grant.issued', grantMeta('g-child', { parentGrantId: 'g-root' }));
  run.emit('grant.issued', grantMeta('g-grandchild', { parentGrantId: 'g-child' }));
  run.emit('grant.issued', grantMeta('g-lone'));
  const cascade = run.revokeGrant('g-root', { actor: { type: 'human', id: 'u-ben' } });
  assert.deepEqual(cascade.data, { grantIds: ['g-root', 'g-child', 'g-grandchild'], reason: 'cascade' });
  assert.deepEqual(cascade.actor, { type: 'human', id: 'u-ben' });
  assert.deepEqual(run.revokeGrant('g-lone').data, { grantIds: ['g-lone'], reason: 'manual' });
  assert.equal(run.revokeGrant('g-lone'), null, 'an ended grant is not revoked twice');
  assert.deepEqual(run.openGrants(), []);
}));

test('expireGrants records every grant past its expiresAt as expired', () => withStore((store) => {
  const run = store.startRun({ runId: 'run-st-0011' });
  run.emit('grant.issued', grantMeta('g-old', { expiresAt: '2026-10-25T12:00:01Z' }));
  run.emit('grant.issued', grantMeta('g-new', { expiresAt: '2026-10-26T00:00:00Z' }));
  const entry = run.expireGrants(new Date('2026-10-25T13:00:00Z'));
  assert.deepEqual(entry.data, { grantIds: ['g-old'], reason: 'expired' });
  assert.equal(run.expireGrants(new Date('2026-10-25T13:00:00Z')), null);
}));

test('redact: known values never reach a line, even inside agent text', () => withStore((store, root) => {
  const run = store.startRun({ runId: 'run-st-0012' });
  run.redact(['sk-secret-0123456789']);
  run.emit('agent.message_chunk', { text: 'my key is sk-secret-0123456789, ok' });
  run.emit('tool.call', { toolCallId: 't', title: 'curl -H "x: sk-secret-0123456789"' });
  const raw = readFileSync(fileOf(root, 'run-st-0012'), 'utf8');
  assert.ok(!raw.includes('sk-secret-0123456789'));
  assert.ok(raw.includes('[redacted]'));
  assert.equal(store.verifyRun('run-st-0012').ok, true, 'scrubbing happens before hashing');
}));

test('the store writes actor.onBehalfOf through emit, and refuses it on a non-agent run actor', () => withStore((store, root) => {
  const actor = { ...AGENT, onBehalfOf: { id: 'u-ben', role: 'requester' } };
  const run = store.startRun({ runId: 'run-st-obo1', adapter: 'fake', taskId: 'TASK-9', podId: 'pod-a', actor });
  run.emit('run.started', { adapter: 'fake', attempt: 1 });
  run.emit('tool.call', { toolCallId: 'tc-1', title: 'resolve', surface: 'connector' });
  run.emit('run.settled', { outcome: 'ok', durationMs: 5, attempts: 1 });
  const events = store.readRun('run-st-obo1');
  assert.deepEqual(events[1].actor, actor);
  assert.deepEqual(verifyRecord(readFileSync(fileOf(root, 'run-st-obo1'), 'utf8')).errors, []);
  assert.throws(() => store.startRun({ runId: 'run-st-obo2', actor: { type: 'human', id: 'u-ana', onBehalfOf: { id: 'u-ben', role: 'requester' } } }), /agent actors only/);
  assert.throws(() => store.startRun({ runId: 'run-st-obo3', actor: { ...AGENT, onBehalfOf: { id: 'u-ben', role: 'boss' } } }), /onBehalfOf.role/);
}));

test('the store records the egress proxy\'s trace types', () => withStore((store, root) => {
  const run = store.startRun({ runId: 'run-st-egr1', actor: AGENT });
  run.emit('egress.allowed', { host: 'api.sentry.io', port: 443 });
  run.emit('egress.denied', { host: null, port: null, reason: 'bad_request' });
  run.emit('egress.denied', { host: '[redacted]', port: 443, reason: 'not_allowed' });
  assert.throws(() => run.emit('egress.denied', { host: 'x.io', port: 443, reason: 'nope' }), /egress.denied.reason/);
  run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
  assert.deepEqual(store.readRun('run-st-egr1').map((e) => e.kind), ['egress.allowed', 'egress.denied', 'egress.denied', 'run.settled']);
  assert.deepEqual(verifyRecord(readFileSync(fileOf(root, 'run-st-egr1'), 'utf8')).errors, []);
}));

test('the store records sandbox.applied', () => withStore((store, root) => {
  const run = store.startRun({ runId: 'run-st-sbx1', actor: AGENT });
  run.emit('sandbox.applied', { sandbox: 'none', reason: 'no supported OS sandbox on win32' });
  assert.throws(() => run.emit('sandbox.applied', { sandbox: 'bwrap', reason: 'x' }), /only when sandbox is none/);
  run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
  assert.deepEqual(store.readRun('run-st-sbx1').map((e) => e.kind), ['sandbox.applied', 'run.settled']);
  assert.deepEqual(verifyRecord(readFileSync(fileOf(root, 'run-st-sbx1'), 'utf8')).errors, []);
}));
