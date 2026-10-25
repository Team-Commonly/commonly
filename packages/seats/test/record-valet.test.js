import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { prepareRunEnv } from '../src/valet/env.js';
import { createPermissionPolicy } from '../src/valet/permissions.js';

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

test('an approver approves only with true, or an object whose approved is exactly true', async () => {
  for (const answer of [true, { approved: true }, { approved: true, by: 'u-ben' }]) {
    assert.deepEqual((await ask(answer)).result, { outcome: 'selected', optionId: 'allow' }, JSON.stringify(answer));
  }
  for (const answer of [{ approved: 'yes' }, { approved: 1 }, { approved: 'true' }, { approved: {} }, { approved: [true] }, 'yes', 1, {}, [true], null, undefined, false]) {
    const { result, data } = await ask(answer);
    assert.deepEqual(result, { outcome: 'selected', optionId: 'reject' }, `${JSON.stringify(answer)} must not approve`);
    assert.equal(data.approval, 'rejected');
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
  assert.equal(refused.data.decidedBy, 'u-ben', 'a refusal is attributed too');
  // Malformed attribution is dropped rather than trusted.
  const odd = await ask({ approved: true, by: 'Ben Smith', role: 'boss', decisionCardId: '' });
  assert.equal(odd.data.decidedBy, null);
  assert.equal(odd.data.decidedByRole, null);
  assert.equal('decisionCardId' in odd.data, false);
  const bare = await ask(true);
  assert.equal(bare.data.decidedBy, null, 'a bare true names nobody');
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
