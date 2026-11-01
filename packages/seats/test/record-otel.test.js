import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { toOtlpJson } from '../src/record/otel.js';
import { buildSample } from '../test-support/record-sample.js';

const sample = async () => {
  const root = mkdtempSync(join(tmpdir(), 'seats-record-otel-'));
  try { return await buildSample(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const spansOf = (otlp) => otlp.resourceSpans[0].scopeSpans[0].spans;
const attrOf = (holder, key) => holder.attributes.find((a) => a.key === key)?.value;
const ANY_VALUE_KEYS = new Set(['stringValue', 'boolValue', 'intValue', 'doubleValue', 'arrayValue', 'kvlistValue']);

const checkAnyValue = (value, where) => {
  const keys = Object.keys(value);
  assert.equal(keys.length, 1, `${where}: one AnyValue field`);
  assert.ok(ANY_VALUE_KEYS.has(keys[0]), `${where}: ${keys[0]}`);
  if (keys[0] === 'intValue') assert.match(value.intValue, /^-?\d+$/, `${where}: intValue is a decimal string in OTLP/JSON`);
  if (keys[0] === 'arrayValue') value.arrayValue.values.forEach((v, i) => checkAnyValue(v, `${where}[${i}]`));
  if (keys[0] === 'kvlistValue') value.kvlistValue.values.forEach((kv) => checkAnyValue(kv.value, `${where}.${kv.key}`));
};

test('OTLP/JSON structure: ids, times, kinds, typed attributes', async () => {
  const { entries } = await sample();
  const otlp = toOtlpJson(entries, { serviceName: 'seats-test' });
  assert.equal(otlp.resourceSpans.length, 1);
  assert.deepEqual(otlp.resourceSpans[0].resource.attributes, [{ key: 'service.name', value: { stringValue: 'seats-test' } }]);
  assert.deepEqual(otlp.resourceSpans[0].scopeSpans[0].scope, { name: 'seats.record', version: '1' });
  const spans = spansOf(otlp);
  assert.ok(spans.length > 0);
  const ids = new Set();
  for (const span of spans) {
    assert.match(span.traceId, /^[0-9a-f]{32}$/);
    assert.match(span.spanId, /^[0-9a-f]{16}$/);
    assert.ok(!/^0+$/.test(span.traceId) && !/^0+$/.test(span.spanId));
    assert.ok(!ids.has(span.spanId), `span ids are unique: ${span.name}`);
    ids.add(span.spanId);
    if (span.parentSpanId !== undefined) assert.match(span.parentSpanId, /^[0-9a-f]{16}$/);
    assert.equal(span.kind, 1, 'INTERNAL');
    assert.match(span.startTimeUnixNano, /^\d+$/);
    assert.match(span.endTimeUnixNano, /^\d+$/, `${span.name} has an end`);
    assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
    assert.ok([0, 2].includes(span.status.code));
    for (const a of span.attributes) checkAnyValue(a.value, `${span.name}.${a.key}`);
    for (const event of span.events) {
      assert.match(event.timeUnixNano, /^\d+$/);
      for (const a of event.attributes) checkAnyValue(a.value, `${span.name}/${event.name}.${a.key}`);
    }
  }
  // Content stays out: no message text anywhere in the export.
  assert.ok(!JSON.stringify(otlp).includes('Fixed the half-cent rounding in total.js'));
});

test('one task is one trace; ids follow the documented derivation', async () => {
  const { entries } = await sample();
  const spans = spansOf(toOtlpJson(entries));
  const expectedTrace = createHash('sha256').update('seats.record/trace/task/pod-checkout/TASK-101').digest('hex').slice(0, 32);
  assert.deepEqual([...new Set(spans.map((s) => s.traceId))], [expectedTrace]);
  const runSpan = spans.find((s) => s.name === 'seats.run' && attrOf(s, 'seats.run.id').stringValue === 'run-ana-0001');
  assert.equal(runSpan.spanId, createHash('sha256').update('seats.record/span/run-ana-0001/0').digest('hex').slice(0, 16));
  const first = entries.find((e) => e.runId === 'run-ana-0001' && e.kind === 'attempt.started');
  const attempt = spans.find((s) => s.spanId === createHash('sha256').update(`seats.record/span/run-ana-0001/${first.seq}`).digest('hex').slice(0, 16));
  assert.ok(attempt.name.startsWith('invoke_agent'));
});

test('parent/child links: run → attempt → tool, and decisions sit on their tool span', async () => {
  const { entries } = await sample();
  const spans = spansOf(toOtlpJson(entries));
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const runs = spans.filter((s) => s.name === 'seats.run');
  assert.equal(runs.length, 2);
  for (const run of runs) assert.equal(run.parentSpanId, undefined, 'a run span is a root');
  const attempts = spans.filter((s) => s.name.startsWith('invoke_agent'));
  assert.equal(attempts.length, 3, 'two attempts for Ana, one for Ben');
  for (const attempt of attempts) {
    assert.equal(byId.get(attempt.parentSpanId).name, 'seats.run');
    assert.equal(attrOf(attempt, 'gen_ai.operation.name').stringValue, 'invoke_agent');
  }
  const tools = spans.filter((s) => s.name.startsWith('execute_tool'));
  for (const tool of tools) {
    assert.ok(byId.get(tool.parentSpanId).name.startsWith('invoke_agent'), `${tool.name} is a child of an attempt`);
    assert.equal(attrOf(tool, 'gen_ai.operation.name').stringValue, 'execute_tool');
  }
  const resolve = tools.find((s) => s.name === 'execute_tool sentry.resolve_issue');
  const parent = byId.get(resolve.parentSpanId);
  assert.equal(attrOf(parent, 'seats.attempt.number').intValue, '2', 'the approved call ran in the retry');
  assert.equal(attrOf(resolve, 'gen_ai.tool.call.id').stringValue, 'tc-3');
  assert.equal(attrOf(resolve, 'seats.tool.surface').stringValue, 'connector');
  const decided = resolve.events.find((e) => e.name === 'permission.decided');
  assert.equal(attrOf(decided, 'seats.decided_by').stringValue, 'u-ben');
  assert.equal(attrOf(decided, 'seats.decided_by_role').stringValue, 'credential-owner');
  assert.equal(attrOf(decided, 'seats.actor.id').stringValue, 'u-ben');
  assert.equal(attrOf(parent, 'seats.agent.owner').stringValue, 'u-ana');
  // The stuck first attempt is an error with its failure kind; the run is not.
  const stuck = attempts.find((s) => attrOf(s, 'seats.attempt.number').intValue === '1' && attrOf(s, 'seats.agent.owner').stringValue === 'u-ana');
  assert.equal(stuck.status.code, 2);
  assert.equal(attrOf(stuck, 'error.type').stringValue, 'stuck');
  const push = tools.find((s) => s.name.startsWith('execute_tool git push'));
  assert.equal(push.status.code, 2);
  assert.equal(runs.every((r) => r.status.code === 0), true);
});

test('the export is deterministic: same entries, same bytes, in any input order', async () => {
  const a = await sample();
  const b = await sample();
  const one = JSON.stringify(toOtlpJson(a.entries));
  assert.equal(one, JSON.stringify(toOtlpJson(b.entries)));
  const reversedPerRun = [...a.entries.filter((e) => e.runId === 'run-ana-0001').reverse(), ...a.entries.filter((e) => e.runId === 'run-ben-0001')];
  assert.equal(JSON.stringify(toOtlpJson(reversedPerRun)), one);
});

test('a run without a task is its own trace; unknown kinds and newer versions are skipped', () => {
  const base = { v: 1, schema: 'seats.record', runId: 'run-solo-01', actor: null, prev: null };
  const entries = [
    { ...base, seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'attempt.started', data: { attempt: 1 } },
    { ...base, seq: 2, ts: '2026-10-25T12:00:01.000Z', kind: 'future.kind', data: {} },
    { ...base, seq: 3, ts: '2026-10-25T12:00:02.000Z', kind: 'run.settled', data: { outcome: 'failed', failure: { kind: 'crashed' } } },
    { ...base, v: 2, runId: 'run-v2-0001', seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'attempt.started', data: {} },
  ];
  const spans = spansOf(toOtlpJson(entries));
  assert.equal(spans.length, 2);
  assert.equal(spans[0].traceId, createHash('sha256').update('seats.record/trace/run/run-solo-01').digest('hex').slice(0, 32));
  assert.ok(spans.every((s) => s.events.every((e) => e.name !== 'future.kind')));
  assert.equal(spans[0].status.code, 2);
  assert.equal(attrOf(spans[0], 'error.type').stringValue, 'crashed');
  assert.equal(attrOf(spans[1], 'error.type').stringValue, 'crashed', 'an unsettled last attempt takes the run\'s failure');
});

test('decision.ruled joins the tool span of the request on its card, else the span current at the time; argsDigest is a tool attribute', async () => {
  const { entries } = await sample();
  const spans = spansOf(toOtlpJson(entries));
  const resolve = spans.find((s) => s.name === 'execute_tool sentry.resolve_issue');
  assert.match(attrOf(resolve, 'seats.tool.args_digest').stringValue, /^sha256:[0-9a-f]{64}$/);
  const asked = resolve.events.find((e) => e.name === 'permission.requested');
  assert.equal(attrOf(asked, 'seats.asked_of.id').stringValue, 'u-ben');
  assert.equal(attrOf(asked, 'seats.decision_card_id').stringValue, 'card-7f3');
  assert.equal(attrOf(asked, 'seats.args_digest').stringValue, attrOf(resolve, 'seats.tool.args_digest').stringValue);
  // The retry ruling rode no tool call: it lands on Ana's run span, between attempts.
  const anaRun = spans.find((s) => s.name === 'seats.run' && attrOf(s, 'seats.run.id').stringValue === 'run-ana-0001');
  const ruled = anaRun.events.find((e) => e.name === 'decision.ruled');
  assert.equal(attrOf(ruled, 'seats.value').stringValue, 'retry');
  assert.equal(attrOf(ruled, 'seats.decided_by_role').stringValue, 'agent-owner');
  // A ruling on a card a request carried goes to that request's tool span.
  const ana = entries.filter((e) => e.runId === 'run-ana-0001');
  const settle = ana.at(-1);
  const extra = [...ana.slice(0, -1), {
    ...settle, kind: 'decision.ruled', data: { decisionCardId: 'card-7f3', value: 'approved', decidedBy: 'u-ben', decidedByRole: 'credential-owner' },
  }, { ...settle, seq: settle.seq + 1 }];
  const again = spansOf(toOtlpJson(extra)).find((s) => s.name === 'execute_tool sentry.resolve_issue');
  assert.ok(again.events.some((e) => e.name === 'decision.ruled'));
});

test('actor.onBehalfOf maps beside actor.owner: on every event, the attempt span and the tool span', () => {
  const base = { v: 1, schema: 'seats.record', runId: 'run-obo-0001', prev: null };
  const actor = { type: 'agent', id: 'u-agent-ana', owner: 'u-ana', onBehalfOf: { id: 'u-ben', role: 'requester' } };
  const entries = [
    { ...base, seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'attempt.started', actor, data: { attempt: 1 } },
    { ...base, seq: 2, ts: '2026-10-25T12:00:01.000Z', kind: 'tool.call', actor, data: { toolCallId: 'tc-1', name: 'sentry.resolve_issue' } },
    {
      ...base, seq: 3, ts: '2026-10-25T12:00:02.000Z', kind: 'permission.requested', actor,
      data: { toolCallId: 'tc-1', question: 'Resolve?', askedOf: { id: 'u-ben', role: 'credential-owner' } },
    },
    { ...base, seq: 4, ts: '2026-10-25T12:00:03.000Z', kind: 'run.settled', actor: { type: 'system', id: 'seats' }, data: { outcome: 'ok' } },
  ];
  const spans = spansOf(toOtlpJson(entries));
  const attempt = spans.find((s) => s.name.startsWith('invoke_agent'));
  assert.equal(attrOf(attempt, 'seats.agent.owner').stringValue, 'u-ana');
  assert.equal(attrOf(attempt, 'seats.agent.on_behalf_of.id').stringValue, 'u-ben');
  assert.equal(attrOf(attempt, 'seats.agent.on_behalf_of.role').stringValue, 'requester');
  const tool = spans.find((s) => s.name === 'execute_tool sentry.resolve_issue');
  assert.equal(attrOf(tool, 'seats.actor.on_behalf_of.id').stringValue, 'u-ben', 'the pair is on the action itself');
  assert.equal(attrOf(tool, 'seats.actor.on_behalf_of.role').stringValue, 'requester');
  const asked = tool.events.find((e) => e.name === 'permission.requested');
  assert.equal(attrOf(asked, 'seats.actor.owner').stringValue, 'u-ana');
  assert.equal(attrOf(asked, 'seats.actor.on_behalf_of.id').stringValue, 'u-ben');
  assert.equal(attrOf(asked, 'seats.actor.on_behalf_of.role').stringValue, 'requester');
  // Without the field, no attribute appears.
  const plain = spansOf(toOtlpJson(entries.map((e) => (e.actor.type === 'agent' ? { ...e, actor: { type: 'agent', id: 'u-agent-ana', owner: 'u-ana' } } : e))));
  assert.ok(!JSON.stringify(plain).includes('on_behalf_of'));
});

test('egress entries are events on the span current at the time', () => {
  const base = { v: 1, schema: 'seats.record', runId: 'run-egr-0001', prev: null, actor: { type: 'system', id: 'seats' } };
  const entries = [
    { ...base, seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'egress.denied', data: { host: null, port: null, reason: 'bad_request' } },
    { ...base, seq: 2, ts: '2026-10-25T12:00:01.000Z', kind: 'attempt.started', actor: { type: 'agent', id: 'u-agent-ana' }, data: { attempt: 1 } },
    { ...base, seq: 3, ts: '2026-10-25T12:00:02.000Z', kind: 'egress.allowed', data: { host: 'api.sentry.io', port: 443 } },
    { ...base, seq: 4, ts: '2026-10-25T12:00:03.000Z', kind: 'egress.denied', data: { host: '[redacted]', port: 443, reason: 'not_allowed' } },
    { ...base, seq: 5, ts: '2026-10-25T12:00:04.000Z', kind: 'run.settled', data: { outcome: 'ok' } },
  ];
  const spans = spansOf(toOtlpJson(entries));
  const run = spans.find((s) => s.name === 'seats.run');
  const attempt = spans.find((s) => s.name.startsWith('invoke_agent'));
  const early = run.events.find((e) => e.name === 'egress.denied');
  assert.equal(attrOf(early, 'seats.reason').stringValue, 'bad_request');
  assert.equal(attrOf(early, 'seats.host'), undefined, 'a null host is left out');
  assert.equal(attrOf(early, 'seats.actor.id').stringValue, 'seats');
  const allowed = attempt.events.find((e) => e.name === 'egress.allowed');
  assert.equal(attrOf(allowed, 'seats.host').stringValue, 'api.sentry.io');
  assert.equal(attrOf(allowed, 'seats.port').intValue, '443');
  const denied = attempt.events.find((e) => e.name === 'egress.denied');
  assert.equal(attrOf(denied, 'seats.host').stringValue, '[redacted]');
  assert.equal(attrOf(denied, 'seats.reason').stringValue, 'not_allowed');
  assert.equal(attrOf(attempt, 'error.type'), undefined, 'a denial is an event, not an error status');
});

test('sandbox.applied is an event on the span current at the time', () => {
  const base = { v: 1, schema: 'seats.record', runId: 'run-sbx-0001', prev: null, actor: { type: 'system', id: 'seats' } };
  const entries = [
    { ...base, seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'sandbox.applied', data: { sandbox: 'none', reason: 'no supported OS sandbox on win32' } },
    { ...base, seq: 2, ts: '2026-10-25T12:00:01.000Z', kind: 'attempt.started', actor: { type: 'agent', id: 'u-agent-ana' }, data: { attempt: 1 } },
    { ...base, seq: 3, ts: '2026-10-25T12:00:02.000Z', kind: 'sandbox.applied', data: { sandbox: 'seatbelt' } },
    { ...base, seq: 4, ts: '2026-10-25T12:00:03.000Z', kind: 'run.settled', data: { outcome: 'ok' } },
  ];
  const spans = spansOf(toOtlpJson(entries));
  const none = spans.find((s) => s.name === 'seats.run').events.find((e) => e.name === 'sandbox.applied');
  assert.equal(attrOf(none, 'seats.sandbox').stringValue, 'none');
  assert.equal(attrOf(none, 'seats.reason').stringValue, 'no supported OS sandbox on win32');
  const seatbelt = spans.find((s) => s.name.startsWith('invoke_agent')).events.find((e) => e.name === 'sandbox.applied');
  assert.equal(attrOf(seatbelt, 'seats.sandbox').stringValue, 'seatbelt');
  assert.equal(attrOf(seatbelt, 'seats.reason'), undefined);
});

test('session.opened is an event that names the attempt\'s conversation; context usage lands on the attempt span', () => {
  const base = { v: 1, schema: 'seats.record', runId: 'run-ses-0001', prev: null, actor: { type: 'system', id: 'seats' } };
  const agent = { type: 'agent', id: 'u-agent-ana' };
  const entries = [
    { ...base, seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'attempt.started', actor: agent, data: { attempt: 1, adapter: 'acp' } },
    {
      ...base, seq: 2, ts: '2026-10-25T12:00:01.000Z', kind: 'session.opened',
      data: { method: 'new', sessionId: 'ses-2', requestedSessionId: 'ses-1', fallback: 'session/resume answered error -32601' },
    },
    { ...base, seq: 3, ts: '2026-10-25T12:00:02.000Z', kind: 'usage', actor: agent, data: { contextTokens: 900, contextSize: 128000 } },
    { ...base, seq: 4, ts: '2026-10-25T12:00:03.000Z', kind: 'usage', actor: agent, data: { inputTokens: 1200, outputTokens: 80, contextTokens: null } },
    { ...base, seq: 5, ts: '2026-10-25T12:00:04.000Z', kind: 'attempt.started', actor: agent, data: { attempt: 2, adapter: 'acp', sessionId: 'ses-9' } },
    { ...base, seq: 6, ts: '2026-10-25T12:00:05.000Z', kind: 'session.opened', data: { method: 'resume', sessionId: 'ses-other' } },
    { ...base, seq: 7, ts: '2026-10-25T12:00:06.000Z', kind: 'run.settled', data: { outcome: 'ok' } },
  ];
  const spans = spansOf(toOtlpJson(entries));
  const [first, second] = spans.filter((s) => s.name.startsWith('invoke_agent'));
  const opened = first.events.find((e) => e.name === 'session.opened');
  assert.equal(attrOf(opened, 'seats.method').stringValue, 'new');
  assert.equal(attrOf(opened, 'seats.requested_session_id').stringValue, 'ses-1');
  assert.equal(attrOf(opened, 'seats.fallback').stringValue, 'session/resume answered error -32601');
  assert.equal(attrOf(first, 'gen_ai.conversation.id').stringValue, 'ses-2');
  assert.equal(attrOf(first, 'seats.usage.context_tokens').intValue, '900', 'a later usage without context keeps the last known');
  assert.equal(attrOf(first, 'seats.usage.context_size').intValue, '128000');
  assert.equal(attrOf(first, 'gen_ai.usage.input_tokens').intValue, '1200');
  const seen = first.events.find((e) => e.name === 'usage');
  assert.equal(attrOf(seen, 'seats.context_tokens').intValue, '900');
  // attempt.started's own sessionId wins; one conversation id per span.
  assert.deepEqual(second.attributes.filter((a) => a.key === 'gen_ai.conversation.id').map((a) => a.value.stringValue), ['ses-9']);
  assert.equal(attrOf(second, 'seats.usage.context_tokens'), undefined);
});

test('a run\'s worktree reaches the export: base on the attempt, base/head/removed/kept on the run', () => {
  const base = { v: 1, schema: 'seats.record', runId: 'run-wt-00001', actor: null, prev: null };
  const sha = (c) => c.repeat(40);
  const entries = [
    { ...base, seq: 1, ts: '2026-10-25T12:00:00.000Z', kind: 'attempt.started', data: { attempt: 1, workspace: { base: sha('a') } } },
    { ...base, seq: 2, ts: '2026-10-25T12:00:01.000Z', kind: 'run.settled', data: { outcome: 'ok', attempts: 1, workspace: { base: sha('a'), head: sha('b'), removed: false, kept: 'committed' } } },
  ];
  const [run, attempt] = spansOf(toOtlpJson(entries));
  assert.equal(attrOf(attempt, 'seats.workspace.base').stringValue, sha('a'));
  assert.equal(attrOf(run, 'seats.workspace.base').stringValue, sha('a'));
  assert.equal(attrOf(run, 'seats.workspace.head').stringValue, sha('b'));
  assert.equal(attrOf(run, 'seats.workspace.removed').boolValue, false);
  assert.equal(attrOf(run, 'seats.workspace.kept').stringValue, 'committed');
  // A head that could not be read is left out, not exported as null.
  const unread = spansOf(toOtlpJson([entries[0], { ...entries[1], data: { outcome: 'ok', attempts: 1, workspace: { base: sha('a'), head: null, removed: false, kept: 'error' } } }]));
  assert.equal(attrOf(unread[0], 'seats.workspace.head'), undefined);
  assert.equal(attrOf(unread[0], 'seats.workspace.kept').stringValue, 'error');
});
