import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, readRetryProbe, runCheck } from '../compat/checks.js';
import { tapSpawn } from '../compat/harness.js';

const KEY = ['sk', 'compat', 'probe', 'key', '0001'].join('-');
const check = (id) => CHECKS.find((c) => c.id === id);
const TIMEOUTS = { turnMs: 2000, stallMs: 500, graceMs: 200, checkMs: 3000, retryWindowMs: 500 };

// `requests` is the harness stamp: provider requests made by that instant.
const update = (requests, sessionUpdate, extra = {}) => ({
  dir: 'in', ms: requests * 100, requests, msg: { jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'ses_1', update: { sessionUpdate, ...extra } } },
});
const prompt = { dir: 'out', ms: 10, requests: 0, msg: { jsonrpc: '2.0', id: 3, method: 'session/prompt', params: { sessionId: 'ses_1', prompt: [] } } };
const retryMeta = { 'opencode/retry': { attempt: 1, nextRetryAt: 1761390000000, error: { type: 'api', message: 'fake provider failure', status: 503 } } };
const fails = (n) => Array.from({ length: n }, () => ({ directive: 'fail' }));

// 1.19.4 as measured in a container run: available_commands_update can land
// just after session/prompt is written, but before any provider request.
const silentTurn = () => ({
  ok: false, ms: 500, tapped: true, requests: fails(4),
  error: Object.assign(new Error('timeout'), { name: 'RunFailure', kind: 'timeout' }),
  events: [{ type: 'session.opened', requests: 0 }, { type: 'turn.prompt_sent', requests: 0 }, { type: 'process.exited', requests: 4 }],
  wire: [prompt, update(0, 'available_commands_update')],
});
// The shape PR #50752 describes: a session_info_update carrying only _meta.
const reportingTurn = ({ surfaced = [] } = {}) => ({
  ...silentTurn(),
  events: [{ type: 'session.opened', requests: 0 }, { type: 'turn.prompt_sent', requests: 0 },
    ...surfaced.map(([type, requests]) => ({ type, requests })), { type: 'process.exited', requests: 4 }],
  wire: [prompt, update(0, 'available_commands_update'),
    update(2, 'session_info_update', { _meta: retryMeta }),
    update(3, 'session_info_update', { _meta: { 'opencode/retry': null } }),
    // After the last request: what an agent says once it has given up.
    update(4, 'agent_message_chunk', { content: { type: 'text', text: 'Ran into this error' } }),
    { dir: 'in', ms: 3000, requests: 4, msg: { jsonrpc: '2.0', id: 3, result: { stopReason: 'cancelled', _meta: retryMeta } } }],
});

const envWith = (turn) => ({
  timeouts: TIMEOUTS,
  provider: { apiKey: KEY },
  detect: async () => ({ found: { path: '/bin/x', version: '1' } }),
  probeTurn: turn === undefined ? undefined : () => Promise.resolve(turn),
});

test('readRetryProbe counts only updates between the first and the last provider request', () => {
  const silent = readRetryProbe(silentTurn());
  assert.equal(silent.updates, 0, 'an update before any provider request is not retry progress');
  assert.deepEqual(silent.otherKinds, { available_commands_update: 1 });
  assert.equal(silent.failedRequests, 4);
  const reporting = readRetryProbe(reportingTurn(), { key: KEY });
  assert.equal(reporting.updates, 2);
  assert.deepEqual(reporting.kinds, { session_info_update: 2 });
  assert.deepEqual(reporting.otherKinds, { available_commands_update: 1, agent_message_chunk: 1 }, 'the give-up text is not progress');
  assert.deepEqual(reporting.metaKeys, ['opencode/retry']);
  assert.deepEqual(reporting.answerMetaKeys, ['opencode/retry']);
  assert.deepEqual(reporting.surfaced, []);
  assert.match(reporting.sample, /"sessionUpdate":"session_info_update"/);
});

test('readRetryProbe scrubs the key from the sample it quotes', () => {
  const turn = reportingTurn();
  turn.wire[2] = update(2, 'session_info_update', { _meta: { echo: KEY } });
  const probe = readRetryProbe(turn, { key: KEY });
  assert.doesNotMatch(probe.sample, new RegExp(KEY));
  assert.match(probe.sample, /<key>/);
});

test('retry-status fails a silent retry and passes one the agent reports', async () => {
  const silent = await runCheck(check('retry-status'), {}, envWith(silentTurn()));
  assert.equal(silent.status, 'fail');
  assert.match(silent.detail, /4 provider requests in 500ms and no session\/update between the first and the last; outside the retries: available_commands_update×1/);
  const reporting = await runCheck(check('retry-status'), {}, envWith(reportingTurn()));
  assert.equal(reporting.status, 'pass', reporting.detail);
  assert.match(reporting.detail, /2 session\/update\(s\) between the first and the last of 4 provider requests in 500ms: session_info_update×2; _meta keys opencode\/retry; outside the retries: available_commands_update×1, agent_message_chunk×1; the prompt answer carries _meta opencode\/retry/);
});

test('retry-status passes an agent that does not retry, and skips when it cannot see the agent', async () => {
  const once = { ...silentTurn(), requests: fails(1) };
  assert.equal((await runCheck(check('retry-status'), {}, envWith(once))).status, 'pass');
  const noProbe = await runCheck(check('retry-status'), {}, envWith(undefined));
  assert.equal(noProbe.status, 'skip');
  assert.match(noProbe.detail, /declares no probeOptions/);
  const untapped = await runCheck(check('retry-status'), {}, envWith({ ...silentTurn(), tapped: false, wire: [] }));
  assert.equal(untapped.status, 'skip');
  assert.match(untapped.detail, /took no spawn hook/);
  const noPrompt = await runCheck(check('retry-status'), {}, envWith({ ...silentTurn(), wire: [] }));
  assert.equal(noPrompt.status, 'skip');
});

test('retry-status-surfaced fails when the trace drops what the agent reported', async () => {
  const dropped = await runCheck(check('retry-status-surfaced'), {}, envWith(reportingTurn()));
  assert.equal(dropped.status, 'fail');
  assert.match(dropped.detail, /the agent sent session_info_update×2 \(_meta keys opencode\/retry\); the trace carries no event from them/);
  const carried = await runCheck(check('retry-status-surfaced'), {}, envWith(reportingTurn({ surfaced: [['agent.thought_chunk', 2], ['agent.thought_chunk', 3]] })));
  assert.equal(carried.status, 'pass', carried.detail);
  // An event from the give-up text does not stand in for a dropped retry report.
  const late = await runCheck(check('retry-status-surfaced'), {}, envWith(reportingTurn({ surfaced: [['agent.message_chunk', 4], ['usage', 4]] })));
  assert.equal(late.status, 'fail', late.detail);
  const nothing = await runCheck(check('retry-status-surfaced'), {}, envWith(silentTurn()));
  assert.equal(nothing.status, 'skip');
});

test('tapSpawn records JSON lines both ways, split across chunks, and drops the rest', async () => {
  const wire = [];
  const script = [
    "process.stdin.on('data', (d) => {",
    "  process.stdout.write('{\"jsonrpc\":\"2.0\",\"id\":1,');",
    "  setTimeout(() => { process.stdout.write('\"result\":{}}\\nnot json\\n'); process.exit(0); }, 20);",
    '});',
  ].join('\n');
  let n = 0;
  const child = tapSpawn(wire, undefined, { stamp: () => ({ requests: n++ }) })(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stdout.on('data', () => {}); // the adapter's own reader
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' })}\n`);
  await new Promise((resolve) => child.once('close', resolve));
  assert.deepEqual(wire.map((w) => [w.dir, w.msg.method ?? 'answer']), [['out', 'initialize'], ['in', 'answer']]);
  assert.ok(wire.every((w) => Number.isFinite(w.ms)));
  assert.deepEqual(wire.map((w) => w.requests), [0, 1], 'each record carries the stamp');
});

// goose 1.56.0 as measured: a run marker before any request, two session-state
// updates beside the first, then nothing until its error text after the last.
test('start-of-turn bookkeeping and session state are not retry progress', async () => {
  const turn = {
    ...silentTurn(),
    requests: fails(8),
    events: [{ type: 'turn.prompt_sent', requests: 0 }, { type: 'usage', requests: 1 }, { type: 'usage', requests: 3 }, { type: 'agent.message_chunk', requests: 8 }],
    wire: [prompt,
      update(0, 'session_info_update', { _meta: { goose: { activeRunId: 'run_1' } } }),
      update(1, 'usage_update', { used: 0, size: 128000 }),
      update(1, 'available_commands_update', { availableCommands: [] }),
      update(3, 'usage_update', { used: 0, size: 128000 }),
      update(8, 'agent_message_chunk', { content: { type: 'text', text: 'Ran into this error: 503' } }),
      update(8, 'session_info_update', { _meta: { goose: { activeRunId: null } } })],
  };
  const probe = readRetryProbe(turn);
  assert.equal(probe.updates, 0, JSON.stringify(probe));
  assert.deepEqual(probe.surfaced, [], 'a usage event is session state, not a surfaced retry report');
  const result = await runCheck(check('retry-status'), {}, envWith(turn));
  assert.equal(result.status, 'fail');
  assert.match(result.detail, /8 provider requests .* no session\/update between the first and the last; outside the retries: session_info_update×2, usage_update×2, available_commands_update×1, agent_message_chunk×1/);
});

// While only the first request is out nothing has been retried yet, so what
// the agent streams then (a thought, a run marker) is not a retry report.
test('an update while only the first request is out is not retry progress', () => {
  const turn = {
    ...silentTurn(),
    wire: [prompt,
      update(1, 'agent_thought_chunk', { content: { type: 'text', text: 'thinking' } }),
      update(1, 'session_info_update', { _meta: { goose: { activeRunId: 'run_1' } } })],
  };
  const probe = readRetryProbe(turn);
  assert.equal(probe.updates, 0, JSON.stringify(probe));
  assert.deepEqual(probe.otherKinds, { agent_thought_chunk: 1, session_info_update: 1 });
});
