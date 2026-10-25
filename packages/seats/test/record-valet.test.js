import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { prepareRunEnv } from '../src/valet/env.js';
import { createPermissionPolicy, MAX_REFUSED_ANSWERS } from '../src/valet/permissions.js';
import { argsDigestOf } from '../src/record/format.js';

const FROM_ENV = 'sk-env-planted-0a1b2c3d4e5f';
const FROM_FILE = 'sk-file-planted-6a7b8c9d0e1f';
const FROM_RESOLVER = 'sk-resolver-planted-2f3e4d5c';
const UNGRANTED = 'sk-ungranted-planted-9z8y7x6w';
const OPTIONS = [
  { optionId: 'allow', kind: 'allow_once' }, { optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' },
];

const withRoot = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-record-valet-'));
  try { return await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const everyByte = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile()).map((d) => readFileSync(join(d.parentPath ?? d.path, d.name), 'utf8')).join('\n');

test('no secret values in the record: env, file and resolver values, even echoed by the agent', () => withRoot(async (root) => {
  const store = createTraceStore({ root: join(root, 'trace') });
  const run = store.startRun({ runId: 'run-va-0001', taskId: 'TASK-1', podId: 'pod-a', actor: { type: 'agent', id: 'u-agent-1', owner: 'u-ana' } });
  const secretFile = join(root, 'token.txt');
  writeFileSync(secretFile, `${FROM_FILE}\n`, { mode: 0o600 });
  const grant = {
    credentials: [
      { name: 'OPENAI_API_KEY', from: 'env' }, { name: 'FILE_TOKEN', from: 'file', ref: secretFile }, { name: 'BROKER_TOKEN', from: 'resolver' },
    ],
    tools: { allow: ['read'], ask: ['fetch'] },
  };
  const env = await prepareRunEnv({
    grant,
    baseEnv: { OPENAI_API_KEY: FROM_ENV, ANTHROPIC_API_KEY: UNGRANTED },
    resolveSecret: async () => FROM_RESOLVER,
    root,
    ctx: { trace: run },
    grantMeta: {
      grantId: 'g-1', scope: { connectionId: 'conn-1', tools: ['sentry.get_issue'], audience: ['u-ana'] }, issuedBy: 'u-ana', taskId: 'TASK-1', podId: 'pod-a',
    },
  });
  // Positive control: the values really reached the run, so their absence below means something.
  assert.equal(env.env.OPENAI_API_KEY, FROM_ENV);
  assert.equal(env.env.FILE_TOKEN, FROM_FILE);
  assert.equal(env.env.BROKER_TOKEN, FROM_RESOLVER);
  const decide = createPermissionPolicy(grant, { trace: run, approve: async () => ({ approved: true, by: 'u-ben', role: 'credential-owner' }) });
  run.emit('run.started', { adapter: 'fake', attempt: 1 });
  run.emit('agent.message_chunk', { text: `env ${FROM_ENV} file ${FROM_FILE} resolver ${FROM_RESOLVER}` });
  run.emit('tool.call', { toolCallId: 'tc-1', title: `curl -H "Authorization: Bearer ${FROM_RESOLVER}"`, kind: 'fetch' });
  await decide({ toolCall: { toolCallId: 'tc-1', title: 'fetch', kind: 'fetch' }, options: OPTIONS });
  run.emit('usage', { note: `${FROM_FILE}` });
  run.emit('run.settled', { outcome: 'ok', durationMs: 3, attempts: 1 });
  await env.cleanup();

  const bytes = everyByte(join(root, 'trace'));
  assert.ok(bytes.includes('agent.message_chunk'), 'positive control: the agent text was written');
  for (const value of [FROM_ENV, FROM_FILE, FROM_RESOLVER, UNGRANTED]) assert.ok(!bytes.includes(value), `${value.slice(0, 12)}… reached the trace`);
  assert.equal((bytes.match(/\[redacted\]/g) || []).length, 5);
  const kinds = store.readRun('run-va-0001').map((e) => e.kind);
  assert.deepEqual(kinds.slice(0, 2), ['grant.issued', 'credential.granted']);
  assert.deepEqual(store.readRun('run-va-0001')[1].data, { names: ['OPENAI_API_KEY', 'FILE_TOKEN', 'BROKER_TOKEN'] });
  assert.equal(store.verifyRun('run-va-0001').ok, true);
}));

test('grant.issued from grantMeta: bound to the task, ending on task.done by default', () => withRoot(async (root) => {
  const store = createTraceStore({ root: join(root, 'trace') });
  const run = store.startRun({ runId: 'run-va-0002', taskId: 'TASK-2', podId: 'pod-a' });
  const env = await prepareRunEnv({
    grant: { credentials: [] }, root, trace: run,
    grantMeta: {
      grantId: 'g-2', parentGrantId: 'g-root', issuedBy: 'u-ben', taskId: 'TASK-2', podId: 'pod-a',
      scope: { connectionId: 'conn-ben', tools: ['github.get_pull_request'], writeMode: 'read', budget: { calls: 3 }, audience: ['u-ben'] },
      target: { kind: 'seat', id: 'u-agent-ben' },
    },
  });
  await env.cleanup();
  assert.equal(env.grantId, 'g-2');
  const [issued] = store.readRun('run-va-0002');
  assert.equal(issued.kind, 'grant.issued');
  assert.deepEqual(issued.data.binding, { taskId: 'TASK-2', podId: 'pod-a', endsOn: 'task.done' });
  assert.equal(issued.data.parentGrantId, 'g-root');
  assert.deepEqual(issued.actor, { type: 'human', id: 'u-ben' });
  run.emit('task.done', {});
  assert.deepEqual(store.readRun('run-va-0002').at(-1).data, { grantIds: ['g-2'], reason: 'task.done' });
}));

test('without grantMeta, prepareRunEnv emits what it always has', () => withRoot(async (root) => {
  const events = [];
  const env = await prepareRunEnv({ grant: { credentials: [] }, root, trace: { emit: (type, data) => events.push({ type, data }) } });
  await env.cleanup();
  assert.deepEqual(events, [{ type: 'credential.granted', data: { names: [] } }]);
}));

const ask = async (answer) => {
  const events = [];
  const decide = createPermissionPolicy({ tools: { ask: ['fetch'] } }, {
    trace: { emit: (type, data) => events.push({ type, data }) }, approve: async () => answer, approveTimeoutMs: 1000, grantId: 'g-9',
  });
  const result = await decide({ toolCall: { toolCallId: 'tc-1', title: 'fetch it', kind: 'fetch' }, options: OPTIONS });
  return { result, data: events[0].data };
};

const BEN = { by: 'u-ben', role: 'credential-owner' };

test('an approver approves only with approved exactly true and a named owner', async () => {
  for (const role of ['credential-owner', 'agent-owner']) {
    assert.deepEqual((await ask({ approved: true, by: 'u-ben', role })).result, { outcome: 'selected', optionId: 'allow' }, role);
  }
  for (const approved of ['yes', 1, 'true', {}, [true], null, undefined]) {
    const { result, data } = await ask({ approved, ...BEN });
    assert.deepEqual(result, { outcome: 'selected', optionId: 'reject' }, `approved ${JSON.stringify(approved)} must not approve`);
    assert.equal(data.approval, 'failed');
  }
});

test('a bare true approves nothing: the ask fails and policy denies (CTO, 10-25)', async () => {
  const { result, data } = await ask(true);
  assert.deepEqual(result, { outcome: 'selected', optionId: 'reject' });
  assert.deepEqual([data.approval, data.decidedBy, data.decidedByRole], ['failed', 'policy', 'policy']);
});

test('a malformed answer approves nothing: the ask fails and policy denies; no decided line names nobody', async () => {
  const malformed = [
    'yes', 1, false, null, undefined, [true], {},
    { approved: true },
    { approved: true, by: 'u-ben' },
    { approved: true, role: 'credential-owner' },
    { approved: true, by: 'Ben Smith', role: 'credential-owner' },
    { approved: true, by: 'u-ben', role: 'boss' },
    { approved: true, by: 'u-ben', role: 'policy' },
    { approved: true, by: 'u-ben', role: null },
    { approved: false },
  ];
  for (const answer of malformed) {
    const { result, data } = await ask(answer);
    assert.deepEqual(result, { outcome: 'selected', optionId: 'reject' }, `${JSON.stringify(answer)} must not approve`);
    assert.deepEqual([data.approval, data.decidedBy, data.decidedByRole], ['failed', 'policy', 'policy'], JSON.stringify(answer));
  }
});

test('the decision names who decided and as what, separate from the agent and its owner', async () => {
  const { data } = await ask({ approved: true, by: 'u-ben', role: 'credential-owner', decisionCardId: 'card-1' });
  assert.equal(data.approval, 'approved');
  assert.equal(data.decidedBy, 'u-ben');
  assert.equal(data.decidedByRole, 'credential-owner');
  assert.equal(data.decisionCardId, 'card-1');
  assert.equal(data.grantId, 'g-9');
  const refused = await ask({ approved: false, by: 'u-ben', role: 'credential-owner' });
  assert.equal(refused.data.approval, 'rejected');
  assert.equal(refused.data.decidedBy, 'u-ben', 'a refusal is attributed too');
  // A malformed card id is dropped rather than trusted.
  const odd = await ask({ approved: true, ...BEN, decisionCardId: '' });
  assert.equal(odd.data.decidedBy, 'u-ben');
  assert.equal('decisionCardId' in odd.data, false);
});

test('a pod member\'s answer decides nothing: the call stays parked until the owner answers (ADR-033 D5)', async () => {
  const events = [];
  const seen = [];
  let ownerAnswers;
  const ownerAnswer = new Promise((resolve) => { ownerAnswers = resolve; });
  const decide = createPermissionPolicy({ tools: { ask: ['fetch'] } }, {
    trace: { emit: (type, data) => events.push({ type, data }) }, approveTimeoutMs: 5000, grantId: 'g-9',
    askedOf: { id: 'u-ben', role: 'credential-owner' },
    approve: (input) => {
      seen.push(input);
      return seen.length === 1 ? { approved: true, by: 'u-cal', role: 'pod-member', decisionCardId: 'card-1' } : ownerAnswer;
    },
  });
  const pending = decide({ toolCall: { toolCallId: 'tc-1', title: 'fetch it', kind: 'fetch' }, options: OPTIONS });
  // Bounded: a policy that lets the pod member decide never asks again.
  for (let i = 0; i < 200 && seen.length < 2; i += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.equal(seen.length, 2, 'the owner is asked again after the pod member\'s answer');
  assert.deepEqual(events.map((e) => e.type), ['permission.requested'], 'no permission.decided for the pod member\'s answer');
  assert.deepEqual(seen[1].refused, { by: 'u-cal', role: 'pod-member', reason: 'not_owner' }, 'the card is told why');
  assert.equal(seen[0].refused, undefined);
  ownerAnswers({ approved: true, by: 'u-ben', role: 'credential-owner', decisionCardId: 'card-1' });
  assert.deepEqual(await pending, { outcome: 'selected', optionId: 'allow' });
  const decided = events.filter((e) => e.type === 'permission.decided');
  assert.equal(decided.length, 1);
  assert.equal(decided[0].data.decidedBy, 'u-ben');
  assert.equal(decided[0].data.decidedByRole, 'credential-owner');
});

test('an approver that only ever answers as a pod member fails the ask, and the policy default decides', async () => {
  const events = [];
  let calls = 0;
  const decide = createPermissionPolicy({ tools: { ask: ['fetch'] } }, {
    trace: { emit: (type, data) => events.push({ type, data }) }, approveTimeoutMs: 5000, grantId: 'g-9',
    approve: () => { calls += 1; return { approved: true, by: 'u-cal', role: 'pod-member' }; },
  });
  const result = await decide({ toolCall: { toolCallId: 'tc-1', title: 'fetch it', kind: 'fetch' }, options: OPTIONS });
  assert.deepEqual(result, { outcome: 'selected', optionId: 'reject' });
  assert.equal(calls, MAX_REFUSED_ANSWERS + 1);
  const [decided] = events.filter((e) => e.type === 'permission.decided');
  assert.deepEqual([decided.data.decidedBy, decided.data.decidedByRole], ['policy', 'policy']);
});

test('a valet policy with a trace says it records permissions itself; without one it does not', () => {
  const recording = createPermissionPolicy({ tools: { ask: ['fetch'] } }, { trace: { emit: () => {} } });
  assert.equal(recording.recordsPermissions, true);
  assert.equal(Object.keys(recording).includes('recordsPermissions'), false, 'non-enumerable');
  assert.equal(createPermissionPolicy({ tools: { ask: ['fetch'] } }).recordsPermissions, undefined);
});

test('no answer in time is decided by policy', async () => {
  const events = [];
  const decide = createPermissionPolicy({ tools: { ask: ['fetch'] } }, {
    trace: { emit: (type, data) => events.push({ type, data }) }, approve: () => new Promise(() => {}), approveTimeoutMs: 10,
  });
  await decide({ toolCall: { toolCallId: 'tc-1', title: 'x', kind: 'fetch' }, options: OPTIONS });
  assert.equal(events[0].data.approval, 'timed_out');
  assert.equal(events[0].data.decidedBy, 'policy');
  assert.equal(events[0].data.decidedByRole, 'policy');
});

test('the question is redacted: a credential value in the ask never reaches disk', () => withRoot(async (root) => {
  const store = createTraceStore({ root: join(root, 'trace') });
  const run = store.startRun({ runId: 'run-va-0003', actor: { type: 'agent', id: 'u-agent-1', owner: 'u-ana' } });
  const grant = { credentials: [{ name: 'BROKER_TOKEN', from: 'resolver' }], tools: { ask: ['fetch'] } };
  const env = await prepareRunEnv({ grant, resolveSecret: async () => FROM_RESOLVER, root, trace: run });
  await env.cleanup();
  const decide = createPermissionPolicy(grant, {
    trace: run, grantId: 'g-3', askedOf: { id: 'u-ben', role: 'credential-owner' }, approve: async () => ({ approved: true, ...BEN }),
  });
  await decide({ toolCall: { toolCallId: 'tc-1', title: `Call the API with token ${FROM_RESOLVER}?`, kind: 'fetch' }, options: OPTIONS });
  const raw = readFileSync(join(root, 'trace', 'runs', 'run-va-0003.jsonl'), 'utf8');
  const asked = store.readRun('run-va-0003').find((e) => e.kind === 'permission.requested');
  assert.equal(asked.data.question, 'Call the API with token [redacted]?', 'positive control: the question was written, scrubbed');
  assert.ok(!raw.includes(FROM_RESOLVER));
  assert.equal(store.verifyRun('run-va-0003').ok, true);
}));

const asks = async (askedOf, toolCall = { toolCallId: 'tc-1', title: 'fetch it', kind: 'fetch' }, tools = { ask: ['fetch'] }) => {
  const events = [];
  const decide = createPermissionPolicy({ tools }, {
    trace: { emit: (type, data) => events.push({ type, data }) }, grantId: 'g-5', askedOf,
    approve: async (input) => { events.push({ type: 'approver-saw', data: input }); return { approved: true, by: 'u-ben', role: 'credential-owner', decisionCardId: input.decisionCardId }; },
  });
  await decide({ toolCall, options: OPTIONS });
  return events;
};

test('permission.requested is written first, asked of the host\'s choice for an ask and of the policy for a rule', async () => {
  const events = await asks(() => ({ id: 'u-ben', role: 'credential-owner', decisionCardId: 'card-9' }));
  assert.deepEqual(events.map((e) => e.type), ['permission.requested', 'approver-saw', 'permission.decided']);
  assert.deepEqual(events[0].data, {
    toolCallId: 'tc-1', options: OPTIONS.map(({ optionId, kind }) => ({ optionId, kind })), question: 'fetch it',
    askedOf: { id: 'u-ben', role: 'credential-owner' }, grantId: 'g-5', decisionCardId: 'card-9',
  });
  assert.equal(events[1].data.decisionCardId, 'card-9', 'the approver gets the card the ask rides on');
  assert.equal(events[2].data.decisionCardId, 'card-9');
  const byRule = await asks({ id: 'u-ben', role: 'credential-owner' }, { toolCallId: 'tc-2', title: 'cat file', kind: 'read' }, { allow: ['read'] });
  assert.deepEqual(byRule[0].data.askedOf, { id: 'grant:g-5', role: 'policy' });
  assert.equal(byRule.some((e) => e.type === 'approver-saw'), false);
  for (const bad of [() => ({ id: 'Ben Smith', role: 'credential-owner' }), () => ({ id: 'u-ben' }), () => { throw new Error('x'); }]) {
    assert.deepEqual((await asks(bad))[0].data.askedOf, { id: 'grant:g-5', role: 'policy' }, 'a malformed answer names nobody');
  }
  assert.throws(() => createPermissionPolicy({ tools: {} }, { askedOf: { id: 'Ben Smith', role: 'policy' } }), /askedOf/);
  const untitled = await asks({ id: 'u-ben', role: 'agent-owner' }, { toolCallId: 'tc-3', kind: 'fetch' });
  assert.equal(untitled[0].data.question, 'fetch call');
});

test('the permission path writes the digest of the call\'s arguments, never the arguments', async () => {
  const rawInput = { url: 'https://example.test/issues/88', body: { status: 'resolved' } };
  const events = await asks({ id: 'u-ben', role: 'credential-owner' }, { toolCallId: 'tc-1', title: 'fetch it', kind: 'fetch', rawInput });
  const digest = argsDigestOf(rawInput);
  assert.match(digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(events[0].data.argsDigest, digest);
  assert.equal(events[2].data.argsDigest, digest);
  assert.ok(!JSON.stringify([events[0].data, events[2].data]).includes('example.test'));
  const none = await asks(undefined, { toolCallId: 'tc-1', title: 'fetch it', kind: 'fetch' });
  assert.equal('argsDigest' in none[1].data, false, 'no rawInput, no digest');
  assert.deepEqual(none.map((e) => e.type), ['approver-saw', 'permission.decided'], 'without askedOf, nothing new is emitted');
});
