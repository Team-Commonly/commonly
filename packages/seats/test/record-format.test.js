import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  appendEntry, argsDigestOf, canonicalLine, hashLine, readRecord, verifyRecord, EGRESS_DENIED_REASONS, KINDS, ON_BEHALF_ROLES, SANDBOXES, SESSION_METHODS, RECORD_VERSION, RECORD_SCHEMA, toolSurfaceOf,
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

const request = (data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'permission.requested', data }, { runActor: AGENT }));
const askData = (overrides = {}) => ({
  toolCallId: 'tc-1', options: [{ optionId: 'allow', kind: 'allow_once' }], question: 'Resolve CHECKOUT-88?',
  askedOf: { id: 'u-ben', role: 'credential-owner' }, grantId: 'g-1', decisionCardId: 'card-1', ...overrides,
});

test('permission.requested: question and askedOf are required, askedOf.id is an id and its role is from the enum', () => {
  const entry = request(askData());
  assert.deepEqual(entry.data.askedOf, { id: 'u-ben', role: 'credential-owner' });
  assert.equal(entry.data.question, 'Resolve CHECKOUT-88?');
  assert.deepEqual(entry.actor, AGENT, 'the agent asks');
  const { askedOf, question, ...rest } = askData();
  assert.throws(() => request(rest), /question/);
  assert.throws(() => request({ ...rest, question }), /askedOf/);
  assert.throws(() => request(askData({ question: '' })), /question/);
  assert.throws(() => request(askData({ askedOf: { id: 'Ben Smith', role: 'credential-owner' } })), /askedOf.id/);
  assert.throws(() => request(askData({ askedOf: { id: 'u-ben' } })), /askedOf.role/);
  assert.throws(() => request(askData({ askedOf: { id: 'u-ben', role: 'boss' } })), /askedOf.role/);
  assert.throws(() => request(askData({ askedOf: { id: 'u-ben', role: 'policy', email: 'ben@example.com' } })), /unknown field/);
  assert.throws(() => request(askData({ decisionCardId: '' })), /decisionCardId/);
  assert.equal(request(askData({ askedOf: { id: 'grant:g-1', role: 'policy' } })).data.askedOf.id, 'grant:g-1');
});

test('decision.ruled: a card ruling, validated like permission.decided', () => {
  const rule = (data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'decision.ruled', data }));
  const good = { decisionCardId: 'card-2', value: 'retry', decidedBy: 'u-ana', decidedByRole: 'agent-owner' };
  const entry = rule(good);
  assert.deepEqual(entry.data, good);
  assert.deepEqual(entry.actor, { type: 'human', id: 'u-ana' }, 'the ruler is the actor');
  assert.deepEqual(rule({ ...good, decidedBy: 'policy', decidedByRole: 'policy' }).actor, { type: 'policy', id: 'policy' });
  for (const value of [true, 3, 'ship']) rule({ ...good, value });
  assert.throws(() => rule({ ...good, decisionCardId: undefined }), /decisionCardId/);
  assert.throws(() => rule({ ...good, decidedBy: 'Ana Smith' }), /decidedBy/);
  assert.throws(() => rule({ ...good, decidedBy: undefined }), /decidedBy/);
  assert.throws(() => rule({ ...good, decidedByRole: 'owner' }), /decidedByRole/);
  assert.throws(() => rule({ ...good, decidedByRole: null }), /decidedByRole/);
  for (const value of [undefined, null, { a: 1 }, ['x'], Number.NaN]) assert.throws(() => rule({ ...good, value }), /value/, `value ${value}`);
});

test('argsDigest is sha256 of the canonical args, and anything else is refused, so raw args cannot ride in', () => {
  const digest = argsDigestOf({ b: 2, a: [1, 'x'] });
  assert.equal(digest, `sha256:${createHash('sha256').update('{"a":[1,"x"],"b":2}').digest('hex')}`);
  assert.equal(argsDigestOf({ a: [1, 'x'], b: 2 }), digest, 'key order does not change it');
  assert.equal(argsDigestOf(undefined), undefined);
  assert.equal(argsDigestOf({ n: Number.NaN }), undefined);
  assert.equal(argsDigestOf({ s: '\ud800' }), undefined, 'a lone surrogate has no digest (RFC 8785)');
  assert.equal(argsDigestOf({ ['k\udc00']: 1 }), undefined, 'in a key too');
  const call = (argsDigest) => appendEntry(null, { ...ENV, ts: ts(), kind: 'tool.call', data: { toolCallId: 't', title: 'x', argsDigest } });
  const decided = (argsDigest) => appendEntry(null, { ...ENV, ts: ts(), kind: 'permission.decided', data: { outcome: 'cancelled', toolCallId: 't', argsDigest } });
  for (const write of [call, decided, (d) => request(askData({ argsDigest: d }))]) {
    write(digest);
    for (const raw of [{ command: 'git push' }, 'git push origin main', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, `sha512:${'a'.repeat(64)}`, 'a'.repeat(64), ['x'], 42]) {
      assert.throws(() => write(raw), /argsDigest/, `raw ${JSON.stringify(raw)}`);
    }
  }
});

const BEHALF = { ...AGENT, onBehalfOf: { id: 'u-ben', role: 'requester' } };

test('actor.onBehalfOf: an agent entry carrying it hashes, chains and verifies, on every kind the agent authors', () => {
  assert.deepEqual(ON_BEHALF_ROLES, ['requester', 'assigner']);
  const lines = [];
  const add = (kind, data) => lines.push(appendEntry(lines.at(-1) ?? null, { ...ENV, ts: ts(), kind, data }, { runActor: BEHALF }));
  add('attempt.started', { attempt: 1, adapter: 'fake' });
  add('tool.call', { toolCallId: 'tc-1', title: 'resolve', surface: 'connector', argsDigest: argsDigestOf({ id: 88 }) });
  add('permission.requested', askData({ argsDigest: argsDigestOf({ id: 88 }) }));
  lines.push(appendEntry(lines.at(-1), {
    ...ENV, ts: ts(), kind: 'result.reported', data: { status: 'done' }, actor: { ...AGENT, onBehalfOf: { id: 'u-cy', role: 'assigner' } },
  }));
  const result = verifyRecord(text(lines));
  assert.deepEqual(result.errors, []);
  assert.equal(result.head, hashLine(lines.at(-1)));
  const entries = readRecord(text(lines));
  for (const entry of entries.slice(0, 3)) assert.deepEqual(entry.actor, BEHALF, `${entry.kind} carries the pair on its actor`);
  assert.deepEqual(entries[3].actor.onBehalfOf, { id: 'u-cy', role: 'assigner' });
  assert.equal(entries[2].data.onBehalfOf, undefined, 'the pair lives on the actor, never in data');
  assert.match(lines[1], /"actor":\{"id":"u-agent-1","name":"Ana's agent","onBehalfOf":\{"id":"u-ben","role":"requester"\},"owner":"u-ana","type":"agent"\}/);
});

test('actor.onBehalfOf: refused off agent actors, with a bad id, an unknown role or an extra key, by writer and verifier', () => {
  const at = (actor) => appendEntry(null, { runId: RUN, ts: ts(), kind: 'usage', data: {}, actor });
  const bad = [
    [{ type: 'human', id: 'u-ana', onBehalfOf: { id: 'u-ben', role: 'requester' } }, /agent actors only/],
    [{ type: 'system', id: 'seats', onBehalfOf: { id: 'u-ben', role: 'requester' } }, /agent actors only/],
    [{ ...AGENT, onBehalfOf: { id: 'Ben Smith', role: 'requester' } }, /onBehalfOf.id/],
    [{ ...AGENT, onBehalfOf: { id: 'u-ben' } }, /onBehalfOf.role/],
    [{ ...AGENT, onBehalfOf: { id: 'u-ben', role: 'owner' } }, /onBehalfOf.role/],
    [{ ...AGENT, onBehalfOf: { id: 'u-ben', role: 'requester', email: 'ben@example.com' } }, /unknown field actor.onBehalfOf.email/],
    [{ ...AGENT, onBehalfOf: 'u-ben' }, /onBehalfOf must be/],
    [{ ...AGENT, onBehalfOf: null }, /onBehalfOf must be/],
  ];
  const good = JSON.parse(at(BEHALF));
  for (const [actor, message] of bad) {
    assert.throws(() => at(actor), message, JSON.stringify(actor));
    // A hand-written line with the same actor, canonical and chained, fails the envelope check.
    const line = canonicalLine({ ...good, actor });
    assert.deepEqual(reasons(verifyRecord(`${line}\n`)), ['1:bad_envelope'], JSON.stringify(actor));
    assert.equal(verifyRecord(`${line}\n`).errors[0].detail, 'actor');
  }
});

test('actor.onBehalfOf is additive: a record written without it is byte-identical to the writer before the field', () => {
  // Hashes pinned from the writer at b7b71f63a, before onBehalfOf existed.
  const env = { runId: 'run-fmt-0001', taskId: 'TASK-7', podId: 'pod-a' };
  const l1 = appendEntry(null, { ...env, ts: '2026-10-25T12:00:01.000Z', kind: 'attempt.started', data: { attempt: 1, adapter: 'fake' } }, { runActor: AGENT });
  const l2 = appendEntry(l1, { ...env, ts: '2026-10-25T12:00:02.000Z', kind: 'tool.call', data: { toolCallId: 'tc-1', title: 'x', surface: 'native' } }, { runActor: AGENT });
  assert.equal(hashLine(l1), 'f91b90fc46781ca9b915b80cce5b9633f603e90742bfc8b1f6dc82d17e01c264');
  assert.equal(hashLine(l2), '1689f865735018eafddcb3fcf0b267d8ead7d9546d45b6d9a471c23eed21cfc6');
  assert.ok(!l1.includes('onBehalfOf') && !l2.includes('onBehalfOf'));
  assert.deepEqual(verifyRecord(`${l1}\n${l2}\n`).errors, []);
});

test('a lone surrogate in agent text still records: only the args digest refuses it', () => {
  // A stream cut mid-pair leaves half a surrogate pair in a chunk.
  const chunk = `cut here ${'\ud83d'}`;
  const first = appendEntry(null, { ...ENV, ts: ts(), kind: 'agent.message_chunk', data: { text: chunk } }, { runActor: AGENT });
  assert.ok(first.includes('cut here \\ud83d'), 'the lone half is written as a \\u escape');
  const second = appendEntry(first, {
    ...ENV, ts: ts(), kind: 'tool.call', data: { toolCallId: 'tc-1', title: chunk, argsDigest: argsDigestOf({ q: 'ok' }) },
  }, { runActor: AGENT });
  assert.deepEqual(verifyRecord(`${first}\n${second}\n`).errors, []);
  assert.equal(readRecord(`${first}\n`)[0].data.text, chunk);
  assert.equal(argsDigestOf({ q: chunk }), undefined);
});

const egress = (kind, data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind, data }, { runActor: AGENT }));

test('egress.allowed: {host, port}, written by the system', () => {
  assert.deepEqual(KINDS['egress.allowed'], { group: 'egress', actor: 'system' });
  const ok = egress('egress.allowed', { host: 'api.sentry.io', port: 443 });
  assert.deepEqual(ok.data, { host: 'api.sentry.io', port: 443 });
  assert.deepEqual(ok.actor, { type: 'system', id: 'seats' });
  // host: a lowercase DNS name, an IP literal, or [redacted]; anything else is refused.
  for (const host of ['localhost', '[redacted]', '203.0.113.7', '2001:db8::1']) egress('egress.allowed', { host, port: 443 });
  for (const host of ['API.sentry.io', 'https://api.sentry.io', 'user@api.sentry.io', 'a b.io', '-x.io', '', '[REDACTED]', 42]) {
    assert.throws(() => egress('egress.allowed', { host, port: 443 }), /egress.allowed.host/, `host ${JSON.stringify(host)}`);
  }
  assert.throws(() => egress('egress.allowed', { host: `${'a'.repeat(60)}.`.repeat(5), port: 443 }), /egress.allowed.host/, 'over 253 characters');
  // port: an integer from 1 to 65535.
  egress('egress.allowed', { host: 'api.sentry.io', port: 65535 });
  for (const port of [0, 65536, 443.5, '443', -1]) assert.throws(() => egress('egress.allowed', { host: 'api.sentry.io', port }), /egress.allowed.port/, `port ${port}`);
  // An opened tunnel always names its target: no nulls, no missing fields.
  assert.throws(() => egress('egress.allowed', { host: null, port: null }), /needs a host and a port/);
  assert.throws(() => egress('egress.allowed', { port: 443 }), /egress.allowed.host/);
  assert.throws(() => egress('egress.allowed', { host: 'api.sentry.io' }), /egress.allowed.port/);
  // No other field: a header or an address can't ride in.
  assert.throws(() => egress('egress.allowed', { host: 'api.sentry.io', port: 443, address: '203.0.113.7' }), /unknown field egress.allowed.address/);
});

test('egress.denied: {host, port, reason}, the reason from a closed set, null target only on a malformed request', () => {
  assert.deepEqual(KINDS['egress.denied'], { group: 'egress', actor: 'system' });
  assert.deepEqual(EGRESS_DENIED_REASONS, ['bad_request', 'not_connect', 'ip_literal', 'not_allowed', 'unresolved', 'private_address', 'unreachable']);
  const denied = egress('egress.denied', { host: 'evil.example', port: 443, reason: 'not_allowed' });
  assert.deepEqual(denied.data, { host: 'evil.example', port: 443, reason: 'not_allowed' });
  assert.deepEqual(denied.actor, { type: 'system', id: 'seats' });
  // reason: every listed reason is accepted; anything else is refused.
  for (const reason of EGRESS_DENIED_REASONS) egress('egress.denied', { host: '10.0.0.1', port: 80, reason });
  for (const reason of ['forbidden', undefined, null, 'NOT_ALLOWED']) {
    assert.throws(() => egress('egress.denied', { host: 'evil.example', port: 443, reason }), /egress.denied.reason/, `reason ${reason}`);
  }
  // host and port may be null, together, when the request was malformed.
  for (const reason of ['bad_request', 'not_connect']) {
    assert.deepEqual(egress('egress.denied', { host: null, port: null, reason }).data, { host: null, port: null, reason });
  }
  assert.throws(() => egress('egress.denied', { host: null, port: null, reason: 'not_allowed' }), /needs a host and a port/, 'a parsed target is never null');
  assert.throws(() => egress('egress.denied', { host: null, port: 443, reason: 'bad_request' }), /null together/);
  assert.throws(() => egress('egress.denied', { host: 'evil.example', port: null, reason: 'not_connect' }), /null together/);
  // host and port follow the egress.allowed rules when set.
  egress('egress.denied', { host: '[redacted]', port: 443, reason: 'not_allowed' });
  assert.throws(() => egress('egress.denied', { host: 'Evil.example', port: 443, reason: 'not_allowed' }), /egress.denied.host/);
  assert.throws(() => egress('egress.denied', { host: 'evil.example', port: 70000, reason: 'not_allowed' }), /egress.denied.port/);
  assert.throws(() => egress('egress.denied', { host: 'evil.example', port: 443, reason: 'not_allowed', status: 403 }), /unknown field egress.denied.status/);
});

test('sandbox.applied: {sandbox, reason?}, the reason only when the run is unsandboxed', () => {
  assert.deepEqual(KINDS['sandbox.applied'], { group: 'sandbox', actor: 'system' });
  assert.deepEqual(SANDBOXES, ['seatbelt', 'bwrap', 'none']);
  const at = (data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'sandbox.applied', data }, { runActor: AGENT }));
  const applied = at({ sandbox: 'seatbelt' });
  assert.deepEqual(applied.data, { sandbox: 'seatbelt' });
  assert.deepEqual(applied.actor, { type: 'system', id: 'seats' });
  // sandbox: one of seatbelt, bwrap, none.
  at({ sandbox: 'bwrap' });
  for (const sandbox of ['docker', undefined, null, 'Seatbelt']) assert.throws(() => at({ sandbox }), /sandbox.applied.sandbox/, `sandbox ${sandbox}`);
  // reason: a non-empty string, and only beside none.
  assert.deepEqual(at({ sandbox: 'none', reason: 'no supported OS sandbox on win32' }).data, { sandbox: 'none', reason: 'no supported OS sandbox on win32' });
  at({ sandbox: 'none' });
  assert.throws(() => at({ sandbox: 'seatbelt', reason: 'because' }), /only when sandbox is none/);
  for (const reason of ['', 42, null]) assert.throws(() => at({ sandbox: 'none', reason }), /sandbox.applied.reason/, `reason ${reason}`);
  // No other field.
  assert.throws(() => at({ sandbox: 'bwrap', egress: 'proxy' }), /unknown field sandbox.applied.egress/);
});

test('session.opened: {method, sessionId, requestedSessionId?, fallback?}, the pair only when a new session replaced a requested one', () => {
  assert.deepEqual(KINDS['session.opened'], { group: 'attempt', actor: 'system' });
  assert.deepEqual(SESSION_METHODS, ['new', 'resume', 'load']);
  const at = (data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'session.opened', data }, { runActor: AGENT }));
  const opened = at({ method: 'resume', sessionId: 'ses-1' });
  assert.deepEqual(opened.data, { method: 'resume', sessionId: 'ses-1' });
  assert.deepEqual(opened.actor, { type: 'system', id: 'seats' });
  // method: new, resume or load.
  at({ method: 'load', sessionId: 'ses-1' });
  for (const method of ['open', undefined, 'NEW']) assert.throws(() => at({ method, sessionId: 'ses-1' }), /session.opened.method/, `method ${method}`);
  // sessionId: required, a non-empty string.
  at({ method: 'new', sessionId: '01JB5Z' });
  for (const sessionId of [undefined, '', 7]) assert.throws(() => at({ method: 'new', sessionId }), /needs a sessionId/, `sessionId ${sessionId}`);
  // requestedSessionId and fallback: together, and only on a new session.
  const replaced = { method: 'new', sessionId: 'ses-2', requestedSessionId: 'ses-1' };
  assert.deepEqual(at({ ...replaced, fallback: 'session/resume answered error -32603' }).data, { ...replaced, fallback: 'session/resume answered error -32603' });
  at({ ...replaced, fallback: 'agent supports neither session/resume nor session/load' });
  at({ ...replaced, fallback: 'session/load answered error 404' });
  assert.throws(() => at(replaced), /come together/);
  assert.throws(() => at({ method: 'new', sessionId: 'ses-2', fallback: 'session/load answered error 404' }), /come together/);
  assert.throws(() => at({ ...replaced, method: 'resume', fallback: 'session/load answered error 404' }), /only when method is new/);
  assert.throws(() => at({ ...replaced, requestedSessionId: '', fallback: 'session/load answered error 404' }), /requestedSessionId must be/);
  // fallback: one of the two forms the adapter writes, nothing else.
  for (const fallback of ['it broke', 'session/new answered error 1', 'session/load answered error x', 'session/load answered error 1; rm -rf', null, '']) {
    assert.throws(() => at({ ...replaced, fallback }), /session.opened.fallback/, `fallback ${JSON.stringify(fallback)}`);
  }
  assert.throws(() => at({ method: 'new', sessionId: 'ses-2', cwd: '/home/ana' }), /unknown field session.opened.cwd/);
});

test('usage: contextTokens and contextSize are integers >= 0, or null when unknown', () => {
  const at = (data) => JSON.parse(appendEntry(null, { ...ENV, ts: ts(), kind: 'usage', data }, { runActor: AGENT }));
  const filled = at({ inputTokens: null, outputTokens: null, totalTokens: null, cost: null, contextTokens: 41000, contextSize: 200000 });
  assert.equal(filled.data.contextTokens, 41000);
  assert.equal(filled.data.contextSize, 200000);
  at({ contextTokens: 0, contextSize: null });
  at({ inputTokens: 10, outputTokens: 2 });
  for (const key of ['contextTokens', 'contextSize']) {
    for (const value of [-1, 1.5, '41000', Number.NaN]) assert.throws(() => at({ [key]: value }), new RegExp(`usage.${key}`), `${key} ${value}`);
  }
});
