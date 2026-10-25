/**
 * docs/examples is generated from test-support/record-sample.js. This test
 * fails when the files drift from what the code writes; regenerate them with
 *   SEATS_WRITE_EXAMPLES=1 node --test test/record-example.test.js
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSample, SAMPLE_RUN_IDS, SAMPLE_SECRETS } from '../test-support/record-sample.js';
import { verifyRecord } from '../src/record/format.js';

const EXAMPLES = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'examples');

const built = async () => {
  const root = mkdtempSync(join(tmpdir(), 'seats-record-example-'));
  try {
    const { files, store } = await buildSample(root);
    return { files, verified: SAMPLE_RUN_IDS.map((runId) => store.verifyRun(runId)) };
  } finally { rmSync(root, { recursive: true, force: true }); }
};

test('docs/examples matches what the code writes', async () => {
  const { files, verified } = await built();
  for (const result of verified) assert.deepEqual(result.errors, []);
  if (process.env.SEATS_WRITE_EXAMPLES === '1') {
    mkdirSync(EXAMPLES, { recursive: true });
    for (const [name, body] of Object.entries(files)) writeFileSync(join(EXAMPLES, name), body);
  }
  for (const [name, body] of Object.entries(files)) {
    const path = join(EXAMPLES, name);
    assert.ok(existsSync(path), `${name} is missing; run with SEATS_WRITE_EXAMPLES=1`);
    assert.equal(readFileSync(path, 'utf8'), body, `${name} drifted; run with SEATS_WRITE_EXAMPLES=1`);
  }
});

test('the committed examples verify on their own and hold no secret value', () => {
  for (const runId of SAMPLE_RUN_IDS) {
    const text = readFileSync(join(EXAMPLES, `${runId}.jsonl`), 'utf8');
    const result = verifyRecord(text);
    assert.deepEqual(result.errors, []);
    assert.equal(result.settled, true);
  }
  const all = SAMPLE_RUN_IDS.map((id) => `${id}.jsonl`).concat('TASK-101.otlp.json')
    .map((name) => readFileSync(join(EXAMPLES, name), 'utf8')).join('\n');
  for (const secret of SAMPLE_SECRETS) assert.ok(!all.includes(secret));
});

test('the headline case: Ana\'s agent asks, Ben approves as the credential owner', () => {
  const entries = readFileSync(join(EXAMPLES, 'run-ana-0001.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const asked = entries.find((e) => e.kind === 'permission.decided' && e.data.approval === 'approved');
  const agent = entries.find((e) => e.kind === 'attempt.started').actor;
  assert.equal(agent.owner, 'u-ana');
  assert.equal(asked.data.decidedBy, 'u-ben');
  assert.notEqual(asked.data.decidedBy, agent.owner, 'the approver is not the agent\'s owner');
  assert.equal(asked.data.decidedByRole, 'credential-owner');
  assert.equal(asked.data.decisionCardId, 'card-7f3');
  assert.deepEqual(asked.actor, { type: 'human', id: 'u-ben' });
  const issued = entries.find((e) => e.kind === 'grant.issued');
  assert.equal(asked.data.grantId, issued.data.grantId);
  assert.equal(issued.data.scope.connectionId, 'conn-ben-sentry');
  assert.equal(issued.data.parentGrantId, 'grant-ben-sentry-root');
  const denied = entries.find((e) => e.kind === 'permission.decided' && e.data.rule.list === 'deny');
  assert.deepEqual([denied.data.decidedBy, denied.data.decidedByRole], ['policy', 'policy']);
  const ben = readFileSync(join(EXAMPLES, 'run-ben-0001.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const revoked = ben.find((e) => e.kind === 'grant.revoked');
  assert.deepEqual(revoked.data, { grantIds: ['grant-ben-review-1'], reason: 'task.done' });
  assert.equal(ben[ben.indexOf(revoked) - 1].kind, 'task.done');
});
