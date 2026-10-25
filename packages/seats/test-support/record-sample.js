/**
 * Builds docs/examples: one task, two people, two agents on different CLIs.
 *
 * Ana's opencode agent fixes TASK-101 under a grant that attenuates Ben's
 * Sentry connection grant. Its first attempt hangs, and Ana rules on a card
 * to retry it; a `git push` is denied by the grant; a Sentry write is asked
 * of Ben on a decision card, and he approves it as the credential's owner. Ben's goose agent
 * then reviews the PR, and the board marks the task done, which ends the
 * review grant bound to it.
 *
 * Everything runs through the real store and valet, with a fixed clock and
 * fake credential values, so the files are reproducible byte for byte.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { prepareRunEnv } from '../src/valet/env.js';
import { createPermissionPolicy } from '../src/valet/permissions.js';
import { toOtlpJson } from '../src/record/otel.js';
import { argsDigestOf } from '../src/record/format.js';

export const SAMPLE_SECRETS = Object.freeze(['sk-or-sample-0000aaaa1111bbbb', 'sntry-proxy-sample-2222cccc3333', 'sk-sample-openai-4444dddd5555']);
export const SAMPLE_RUN_IDS = Object.freeze(['run-ana-0001', 'run-ben-0001']);
const POD = 'pod-checkout';
const TASK = 'TASK-101';
const OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

/**
 * A tool call the way an ACP adapter would record it (with the digest of its
 * arguments, never the arguments), then decided by the run's policy, which
 * records the request and the decision.
 */
const toolCall = async (run, decide, { rawInput, ...call }, finalStatus) => {
  run.emit('tool.call', { ...call, status: 'pending', argsDigest: argsDigestOf(rawInput) });
  const answer = await decide({
    sessionId: 'ses', toolCall: { toolCallId: call.toolCallId, title: call.title, kind: call.kind, rawInput }, options: OPTIONS,
  });
  const allowed = answer.outcome === 'selected' && answer.optionId === 'allow';
  run.emit('tool.update', { toolCallId: call.toolCallId, status: allowed ? finalStatus : 'failed' });
};

export const buildSample = async (root) => {
  let tick = Date.UTC(2026, 9, 25, 16, 0, 0);
  const store = createTraceStore({ root: join(root, 'trace'), now: () => new Date((tick += 1000)) });
  const [secretOr, secretSentry, secretOpenai] = SAMPLE_SECRETS;

  // Ana's agent: opencode, retried once, one denied call, one approved by Ben.
  const ana = store.startRun({
    runId: SAMPLE_RUN_IDS[0], adapter: 'opencode', taskId: TASK, podId: POD,
    actor: { type: 'agent', id: 'u-agent-ana-opencode', owner: 'u-ana', name: "Ana's opencode" },
  });
  ana.emit('task.claimed', { leaseUntil: '2026-10-25T18:00:00Z' });
  const anaGrant = {
    credentials: [{ name: 'OPENROUTER_API_KEY', from: 'env' }, { name: 'SENTRY_PROXY_TOKEN', from: 'resolver' }],
    tools: { allow: ['read', 'search', 'other:commonly_*'], ask: ['fetch'], deny: ['execute:git push*'] },
  };
  const anaEnv = await prepareRunEnv({
    grant: anaGrant,
    baseEnv: { OPENROUTER_API_KEY: secretOr },
    resolveSecret: async () => secretSentry,
    root,
    ctx: { trace: ana },
    grantMeta: {
      grantId: 'grant-ana-sentry-1',
      parentGrantId: 'grant-ben-sentry-root',
      scope: {
        connectionId: 'conn-ben-sentry', tools: ['sentry.get_issue', 'sentry.resolve_issue'], writeMode: 'write-with-confirm',
        budget: { calls: 20, windowMs: 3600000 }, audience: ['u-ana', 'u-ben'],
      },
      target: { kind: 'seat', id: 'u-agent-ana-opencode' },
      issuedBy: 'u-ana',
      expiresAt: '2026-10-25T20:00:00.000Z',
      taskId: TASK,
      podId: POD,
    },
  });
  await anaEnv.cleanup();
  const anaDecide = createPermissionPolicy(anaGrant, {
    trace: ana,
    grantId: 'grant-ana-sentry-1',
    // An ask under this grant goes to Ben, who owns the Sentry connection, on a card.
    askedOf: () => ({ id: 'u-ben', role: 'credential-owner', decisionCardId: 'card-7f3' }),
    approve: async ({ decisionCardId }) => ({ approved: true, by: 'u-ben', role: 'credential-owner', decisionCardId }),
  });

  ana.emit('run.started', { adapter: 'opencode', cli: { name: 'opencode', version: '1.19.0' }, attempt: 1 });
  ana.emit('turn.prompt_sent', { chars: 412 });
  ana.emit('tool.call', { toolCallId: 'tc-1', title: 'Read src/checkout/total.js', kind: 'read', status: 'pending', surface: 'native' });
  ana.emit('tool.update', { toolCallId: 'tc-1', status: 'completed' });
  ana.emit('liveness.stalled', { idleMs: 90000, windowMs: 90000 });
  ana.emit('liveness.recovery', { action: 'cancel', attempt: 1 });
  ana.emit('attempt.settled', { attempt: 1, outcome: 'stuck', failure: { kind: 'stuck', detail: 'no progress signal for 90000ms (window 90000ms)' } });
  ana.emit('decision.ruled', { decisionCardId: 'card-2b9', value: 'retry', decidedBy: 'u-ana', decidedByRole: 'agent-owner' });
  ana.emit('liveness.recovery', { action: 'retry', attempt: 2 });

  ana.emit('run.started', { adapter: 'opencode', cli: { name: 'opencode', version: '1.19.0' }, sessionId: 'ses-ana-2', attempt: 2 });
  await toolCall(ana, anaDecide, {
    toolCallId: 'tc-2', title: 'git push origin fix/total-rounding', kind: 'execute', surface: 'native',
    rawInput: { command: 'git push origin fix/total-rounding' },
  }, 'completed');
  await toolCall(ana, anaDecide, {
    toolCallId: 'tc-3', title: 'Resolve Sentry issue CHECKOUT-88: the half-cent rounding is fixed in PR #212', kind: 'fetch',
    name: 'sentry.resolve_issue', surface: 'connector', rawInput: { issueId: 'CHECKOUT-88', status: 'resolved' },
  }, 'completed');
  await toolCall(ana, anaDecide, {
    toolCallId: 'tc-4', title: 'commonly_post_message: the fix summary, to the pod', kind: 'other', name: 'commonly_post_message', surface: 'commonly',
    rawInput: { podId: 'pod-checkout', content: 'Fixed in #212' },
  }, 'completed');
  ana.emit('agent.message_chunk', { text: 'Fixed the half-cent rounding in total.js and resolved CHECKOUT-88. PR #212 is open.' });
  ana.emit('usage', { inputTokens: 18234, outputTokens: 2210 });
  ana.emit('attempt.settled', { attempt: 2, outcome: 'ok' });
  ana.emit('result.reported', { status: 'done', refs: [{ type: 'pr', id: '#212' }] });
  ana.emit('run.settled', { outcome: 'ok', durationMs: 412000, attempts: 2 });

  // Ben's agent: goose, read-only review; the board then marks the task done.
  const ben = store.startRun({
    runId: SAMPLE_RUN_IDS[1], adapter: 'goose', taskId: TASK, podId: POD,
    actor: { type: 'agent', id: 'u-agent-ben-goose', owner: 'u-ben', name: "Ben's goose" },
  });
  const benGrant = { credentials: [{ name: 'OPENAI_API_KEY', from: 'env' }], tools: { allow: ['read', 'search'] } };
  const benEnv = await prepareRunEnv({
    grant: benGrant,
    baseEnv: { OPENAI_API_KEY: secretOpenai },
    root,
    ctx: { trace: ben },
    grantMeta: {
      grantId: 'grant-ben-review-1',
      scope: { connectionId: 'conn-ben-github', tools: ['github.get_pull_request'], writeMode: 'read', audience: ['u-ben'] },
      target: { kind: 'seat', id: 'u-agent-ben-goose' },
      issuedBy: 'u-ben',
      expiresAt: '2026-10-25T20:00:00.000Z',
      taskId: TASK,
      podId: POD,
    },
  });
  await benEnv.cleanup();
  const benDecide = createPermissionPolicy(benGrant, { trace: ben, grantId: 'grant-ben-review-1', askedOf: { id: 'u-ben', role: 'agent-owner' } });
  ben.emit('run.started', { adapter: 'goose', cli: { name: 'goose', version: '1.54.0' }, attempt: 1 });
  await toolCall(ben, benDecide, {
    toolCallId: 'tc-1', title: 'Read pull request #212', kind: 'read', name: 'github.get_pull_request', surface: 'connector',
    rawInput: { pullNumber: 212 },
  }, 'completed');
  ben.emit('agent.message_chunk', { text: 'Reviewed #212: the rounding fix is right and the half-cent case is tested.' });
  ben.emit('attempt.settled', { attempt: 1, outcome: 'ok' });
  ben.emit('task.done', { doneBy: 'u-ben' });
  ben.emit('run.settled', { outcome: 'ok', durationMs: 95000, attempts: 1 });

  const files = Object.fromEntries(SAMPLE_RUN_IDS.map((runId) => [`${runId}.jsonl`, readFileSync(join(root, 'trace', 'runs', `${runId}.jsonl`), 'utf8')]));
  const entries = SAMPLE_RUN_IDS.flatMap((runId) => store.readRun(runId));
  files[`${TASK}.otlp.json`] = `${JSON.stringify(toOtlpJson(entries, { serviceName: 'seats-sample' }), null, 2)}\n`;
  return { store, files, entries };
};
