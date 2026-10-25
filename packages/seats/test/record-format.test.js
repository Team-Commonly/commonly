import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendEntry, canonicalLine, hashLine, readRecord, verifyRecord, KINDS, RECORD_VERSION, RECORD_SCHEMA, toolSurfaceOf,
} from '../src/record/format.js';

const RUN = 'run-fmt-0001';
const ENV = { runId: RUN, taskId: 'TASK-7', podId: 'pod-a' };
const AGENT = { type: 'agent', id: 'u-agent-1', owner: 'u-ana', name: "Ana's agent" };
let clock = Date.UTC(2026, 9, 25, 12, 0, 0);
const ts = () => new Date((clock += 1000)).toISOString();

/** A small, settled record built through the writer: [lines], each without '\n'. */
const build = (count = 6) => {
  const lines = [];
  const add = (kind, data, extra = {}) => {
    lines.push(appendEntry(lines.at(-1) ?? null, { ...ENV, ts: ts(), kind, data, ...extra }, { runActor: AGENT }));
  };
  add('task.claimed', {});
  add('attempt.started', { attempt: 1, adapter: 'fake' });
  for (let i = 0; i < count - 3; i += 1) add('tool.call', { toolCallId: `tc-${i}`, title: `step ${i}`, surface: 'native' });
  add('run.settled', { outcome: 'ok', durationMs: 10, attempts: 1 });
  return lines;
};
const text = (lines) => lines.map((line) => `${line}\n`).join('');
const reasons = (result) => result.errors.map(({ seq, reason }) => `${seq}:${reason}`);

test('canonical form: sorted keys, no whitespace, absent fields omitted', () => {
  assert.equal(canonicalLine({ b: 1, a: { d: [1, 'x'], c: null }, e: undefined }), '{"a":{"c":null,"d":[1,"x"]},"b":1}');
  // UTF-16 code-unit order, as RFC 8785 asks: 'B' (0x42) sorts before 'a' (0x61).
  assert.equal(canonicalLine({ a: 1, B: 2 }), '{"B":2,"a":1}');
  assert.throws(() => canonicalLine({ x: Number.NaN }), /finite/);
});

test('round trip: what the writer wrote verifies, reads back, and chains by the exact bytes', () => {
  const lines = build();
  const result = verifyRecord(text(lines));
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.entries, lines.length);
  assert.equal(result.settled, true);
  assert.equal(result.head, createHash('sha256').update(lines.at(-1)).digest('hex'));
  const entries = readRecord(text(lines));
  assert.equal(entries.length, lines.length);
  entries.forEach((entry, i) => {
    assert.equal(entry.v, RECORD_VERSION);
    assert.equal(entry.schema, RECORD_SCHEMA);
    assert.equal(entry.seq, i + 1);
    assert.equal(entry.prev, i === 0 ? null : hashLine(lines[i - 1]));
    assert.equal(canonicalLine(entry), lines[i], 'each line is the canonical form of its entry');
    assert.equal(entry.taskId, 'TASK-7');
    assert.equal(entry.podId, 'pod-a');
  });
  assert.deepEqual(entries[0].actor, { type: 'agent', id: 'u-agent-1', owner: 'u-ana', name: "Ana's agent" });
  assert.deepEqual(entries.at(-1).actor, { type: 'system', id: 'seats' }, 'run.settled defaults to the system actor');
});

test('tamper: an edited byte is reported at the next seq as prev_mismatch', () => {
  const lines = build();
  // A byte inside seq 3's data: still JSON, still canonical, so only the chain sees it.
  lines[2] = lines[2].replace('step 0', 'step 9');
  const result = verifyRecord(text(lines));
  assert.equal(result.ok, false);
  assert.deepEqual(reasons(result), ['4:prev_mismatch']);
});

test('tamper: an edited byte that breaks canonical form is reported on its own line too', () => {
  const lines = build();
  lines[2] = lines[2].replace('"kind":"tool.call"', '"kind": "tool.call"');
  assert.deepEqual(reasons(verifyRecord(text(lines))), ['3:not_canonical', '4:prev_mismatch']);
});

test('tamper: a deleted line is a seq gap and a prev mismatch at the line after it', () => {
  const lines = build();
  lines.splice(2, 1); // seq 3 gone
  const result = verifyRecord(text(lines));
  assert.deepEqual(reasons(result), ['4:seq_mismatch', '4:prev_mismatch']);
});

test('tamper: deleting the first line is caught at seq 2', () => {
  const lines = build();
  lines.shift();
  assert.deepEqual(reasons(verifyRecord(text(lines))), ['2:seq_mismatch', '2:prev_mismatch']);
});

test('tamper: swapped lines are reported where the order breaks', () => {
  const lines = build();
  [lines[2], lines[3]] = [lines[3], lines[2]]; // seq 4 now sits before seq 3
  const result = verifyRecord(text(lines));
  assert.equal(result.ok, false);
  assert.deepEqual(reasons(result), ['4:seq_mismatch', '4:prev_mismatch', '3:seq_mismatch', '3:prev_mismatch', '5:seq_mismatch', '5:prev_mismatch']);
});

test('tamper: a torn final line is reported at the seq it would have had', () => {
  const lines = build();
  const torn = `${text(lines.slice(0, -1))}${lines.at(-1).slice(0, 25)}`;
  const result = verifyRecord(torn);
  assert.deepEqual(reasons(result), [`${lines.length}:torn`]);
  assert.equal(result.entries, lines.length - 1);
  assert.equal(result.settled, false);
  assert.equal(readRecord(torn).length, lines.length - 1, 'readers skip the torn tail');
});

test('a record cut short at a line boundary is an unsettled prefix, not tampering', () => {
  const result = verifyRecord(text(build().slice(0, 3)));
  assert.equal(result.ok, true);
  assert.equal(result.settled, false);
});

test('a line after run.settled, and a line from another run, are reported', () => {
  const lines = build();
  const extra = JSON.parse(lines.at(-1));
  const after = canonicalLine({ ...extra, seq: extra.seq + 1, kind: 'usage', data: {}, prev: hashLine(lines.at(-1)) });
  assert.deepEqual(reasons(verifyRecord(text([...lines, after]))), [`${extra.seq + 1}:after_settled`]);
  assert.throws(() => appendEntry(lines.at(-1), { ...ENV, ts: ts(), kind: 'usage', data: {} }), /after run.settled/);
  const mid = JSON.parse(lines[1]);
  lines[1] = canonicalLine({ ...mid, runId: 'run-other-01' });
  assert.ok(reasons(verifyRecord(text(lines))).includes('2:run_mismatch'));
});

test('a newer v is refused, and unknown kinds still chain', () => {
  const first = JSON.parse(build()[0]);
  const v2 = canonicalLine({ ...first, v: 2 });
  assert.deepEqual(reasons(verifyRecord(`${v2}\n`)), ['1:unsupported_version']);
  const unknown = canonicalLine({ ...first, kind: 'future.thing' });
  const next = canonicalLine({ ...JSON.parse(build()[1]), prev: hashLine(unknown) });
  assert.deepEqual(verifyRecord(`${unknown}\n${next}\n`).errors, []);
});

test('podId is required whenever taskId is set: writer and verifier', () => {
  assert.throws(() => appendEntry(null, { runId: RUN, taskId: 'TASK-7', ts: ts(), kind: 'task.claimed', data: {} }), /taskId needs a podId/);
  // A podId alone is fine; so is neither.
  appendEntry(null, { runId: RUN, podId: 'pod-a', ts: ts(), kind: 'task.claimed', data: {} });
  appendEntry(null, { runId: RUN, ts: ts(), kind: 'attempt.started', data: { attempt: 1 } });
  const line = canonicalLine({
    v: 1, schema: RECORD_SCHEMA, runId: RUN, taskId: 'TASK-7', seq: 1, ts: ts(), kind: 'task.claimed', actor: null, data: {}, prev: null,
  });
  assert.deepEqual(verifyRecord(`${line}\n`).errors, [{ seq: 1, reason: 'bad_envelope', detail: 'podId' }]);
});

test('taskId and podId are fixed for the run', () => {
  const first = appendEntry(null, { ...ENV, ts: ts(), kind: 'task.claimed', data: {} });
  assert.throws(() => appendEntry(first, { ...ENV, podId: 'pod-b', ts: ts(), kind: 'usage', data: {} }), /fixed for the whole run/);
});

test('actor.id is an id, never a display name; owner is a user id on agents only', () => {
  const at = (actor) => appendEntry(null, { runId: RUN, ts: ts(), kind: 'usage', data: {}, actor });
  assert.throws(() => at({ type: 'agent', id: "Ana's agent" }), /actor.id/);
  assert.throws(() => at({ type: 'human', id: 'Ben Smith' }), /actor.id/);
  assert.throws(() => at({ type: 'human', id: 'u-ben', owner: 'u-ana' }), /owner/);
  assert.throws(() => at({ type: 'robot', id: 'u-x' }), /actor.type/);
  const entry = JSON.parse(at({ type: 'human', id: 'u-ben', name: 'Ben Smith' }));
  assert.deepEqual(entry.actor, { id: 'u-ben', name: 'Ben Smith', type: 'human' });
  assert.equal(JSON.parse(at(null)).actor, null, 'null records "unknown" and is kept');
});

const grantData = (overrides = {}) => ({
  grantId: 'g-1',
  scope: { connectionId: 'conn-1', tools: ['sentry.get_issue'], writeMode: 'read', budget: { calls: 5, windowMs: 60000 }, audience: ['u-ana'] },
  issuedBy: 'u-ana',
  ...overrides,
});
const issue = (data) => appendEntry(null, { ...ENV, ts: ts(), kind: 'grant.issued', data });

test('grant.issued: scope matches a room grant, with exact tool names and a connection id', () => {
  const entry = JSON.parse(issue(grantData({
    parentGrantId: 'g-root', target: { kind: 'seat', id: 'u-agent-1' }, expiresAt: '2026-10-26T00:00:00Z',
    binding: { taskId: 'TASK-7', podId: 'pod-a', endsOn: 'task.done' },
  })));
  assert.deepEqual(entry.data.scope, grantData().scope);
  assert.equal(entry.data.parentGrantId, 'g-root');
  assert.deepEqual(entry.actor, { type: 'human', id: 'u-ana' }, 'the issuer is the default actor');
  // Patterns, a credential name in place of a connection, and unknown fields are refused.
  for (const tools of [['sentry.*'], ['execute:git push*'], ['read?'], ['two words']]) {
    assert.throws(() => issue(grantData({ scope: { ...grantData().scope, tools } })), /exact tool names/, `tools ${tools}`);
  }
  assert.throws(() => issue(grantData({ scope: { ...grantData().scope, credentials: ['SENTRY_TOKEN'] } })), /unknown field grant.issued.scope.credentials/);
  assert.throws(() => issue(grantData({ scope: { ...grantData().scope, writeMode: 'admin' } })), /writeMode/);
  assert.throws(() => issue(grantData({ scope: { ...grantData().scope, budget: { calls: -1 } } })), /budget.calls/);
  assert.throws(() => issue(grantData({ scope: { ...grantData().scope, audience: ['Ana Smith'] } })), /audience/);
  assert.throws(() => issue(grantData({ secret: 'x' })), /unknown field grant.issued.secret/);
  assert.equal(JSON.parse(issue(grantData({ issuedBy: 'policy' }))).actor.id, 'grant:g-1');
});

test('grant.issued binding: names the run\'s own task and pod, and ends on task.done or expiresAt', () => {
  issue(grantData({ binding: { taskId: 'TASK-7', podId: 'pod-a', endsOn: 'task.done' } }));
  issue(grantData({ expiresAt: '2026-10-26T00:00:00Z', binding: { taskId: 'TASK-7', podId: 'pod-a', endsOn: 'expiresAt' } }));
  assert.throws(() => issue(grantData({ binding: { taskId: 'TASK-7', podId: 'pod-a', endsOn: 'task.closed' } })), /endsOn/);
  assert.throws(() => issue(grantData({ binding: { taskId: 'TASK-7', podId: 'pod-a', endsOn: 'expiresAt' } })), /needs an expiresAt/);
  assert.throws(() => issue(grantData({ binding: { taskId: 'TASK-7', endsOn: 'task.done' } })), /taskId and podId/);
  assert.throws(() => issue(grantData({ binding: { taskId: 'TASK-8', podId: 'pod-a', endsOn: 'task.done' } })), /run's own/);
});

test('grant.revoked: a non-empty list of grant ids and a reason from the enum', () => {
  const revoke = (data) => appendEntry(null, { ...ENV, ts: ts(), kind: 'grant.revoked', data });
  for (const reason of ['task.done', 'expired', 'cascade', 'manual']) revoke({ grantIds: ['g-1', 'g-2'], reason });
  assert.throws(() => revoke({ grantIds: [], reason: 'manual' }), /non-empty/);
  assert.throws(() => revoke({ grantId: 'g-1', reason: 'manual' }), /grantIds/);
  assert.throws(() => revoke({ grantIds: ['g-1', 'g-1'], reason: 'manual' }), /repeats/);
  for (const reason of ['task.closed', 'run.settled', 'revoked_by:u-ana', undefined]) {
    assert.throws(() => revoke({ grantIds: ['g-1'], reason }), /reason/, `reason ${reason}`);
  }
});

test('task.done: written by the board, and only in a run with a task', () => {
  const entry = JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'task.done', data: { doneBy: 'u-ben' } }));
  assert.deepEqual(entry.actor, { type: 'system', id: 'board' });
  assert.throws(() => appendEntry(null, { runId: RUN, ts: ts(), kind: 'task.done', data: {} }), /needs a run with a taskId/);
  assert.equal(KINDS['task.done'].actor, 'board');
});

test('permission.decided: decidedBy is separate from the agent owner, and credential-owner is a role', () => {
  const decide = (data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'permission.decided', data }, { runActor: AGENT }));
  const asked = decide({
    outcome: 'selected', optionId: 'allow', kind: 'allow_once', toolCallId: 'tc-1', rule: { list: 'ask', pattern: 'fetch' },
    approval: 'approved', decidedBy: 'u-ben', decidedByRole: 'credential-owner', decisionCardId: 'card-1',
  });
  assert.deepEqual(asked.actor, { type: 'human', id: 'u-ben' }, 'the decider is the actor, not the agent or its owner');
  assert.equal(asked.data.decidedByRole, 'credential-owner');
  for (const role of ['decision-owner', 'agent-owner', 'policy']) decide({ outcome: 'cancelled', toolCallId: 't', decidedBy: 'u-ben', decidedByRole: role });
  assert.throws(() => decide({ outcome: 'cancelled', toolCallId: 't', decidedBy: 'u-ben', decidedByRole: 'owner' }), /decidedByRole/);
  assert.throws(() => decide({ outcome: 'cancelled', toolCallId: 't', decidedBy: 'Ben Smith' }), /decidedBy/);
  const byRule = decide({ outcome: 'selected', optionId: 'reject', kind: 'reject_once', toolCallId: 't', rule: { list: 'deny', pattern: 'x' }, grantId: 'g-1' });
  assert.equal(byRule.data.decidedBy, 'policy');
  assert.equal(byRule.data.decidedByRole, 'policy');
  assert.deepEqual(byRule.actor, { type: 'policy', id: 'grant:g-1' });
  const unnamed = decide({ outcome: 'selected', optionId: 'allow', toolCallId: 't', rule: { list: 'ask', pattern: 'x' }, approval: 'approved' });
  assert.equal(unnamed.data.decidedBy, null, 'an ask with no named approver stays null');
  assert.equal(unnamed.actor, null);
});

test('tool.call surface is one of connector, commonly, native', () => {
  const call = (surface) => appendEntry(null, { ...ENV, ts: ts(), kind: 'tool.call', data: { toolCallId: 't', title: 'x', surface } });
  for (const surface of ['connector', 'commonly', 'native']) assert.equal(JSON.parse(call(surface)).data.surface, surface);
  assert.throws(() => call('mcp'), /surface/);
  assert.equal(toolSurfaceOf('commonly_post_message'), 'commonly');
  assert.equal(toolSurfaceOf('mcp__commonly__commonly_read'), 'commonly');
  assert.equal(toolSurfaceOf('mcp__sentry__resolve_issue'), 'connector');
  assert.equal(toolSurfaceOf('Bash'), 'native');
});

test('credential entries hold names only', () => {
  const granted = (names) => appendEntry(null, { ...ENV, ts: ts(), kind: 'credential.granted', data: { names } });
  granted(['OPENAI_API_KEY']);
  assert.throws(() => granted(['sk-live-0123456789']), /NAMES/);
  assert.throws(() => appendEntry(null, { ...ENV, ts: ts(), kind: 'credential.denied', data: { name: 'sk-abc', reason: 'unresolved' } }), /NAMES/);
});

test('the writer refuses unknown kinds, a bad seq, and a non-UTC ts', () => {
  assert.throws(() => appendEntry(null, { ...ENV, ts: ts(), kind: 'made.up', data: {} }), /unknown record kind/);
  assert.throws(() => appendEntry(null, { ...ENV, ts: ts(), kind: 'usage', data: {}, seq: 2 }), /seq 2/);
  assert.throws(() => appendEntry(null, { ...ENV, ts: '2026-10-25T12:00:00+02:00', kind: 'usage', data: {} }), /RFC 3339/);
});
