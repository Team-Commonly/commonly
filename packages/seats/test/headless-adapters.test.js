import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS } from '../compat/checks.js';
import { loadTargets, runTarget } from '../compat/run.js';
import { PACKAGE_ROOT, loadAdapter } from '../compat/targets.js';
import { settleAider } from '../src/adapters/aider.js';
import { createClineAdapter, readClineEvent, settleCline } from '../src/adapters/cline.js';
import { createCopilotAdapter, readCopilotEvent } from '../src/adapters/copilot.js';
import { createHeadlessAdapter, failureFromText } from '../src/adapters/headless.js';
import { createAiderAdapter } from '../src/adapters/aider.js';
import { createQwenAdapter, readQwenEvent } from '../src/adapters/qwen.js';
import { FAILURE_KINDS, RunFailure } from '../src/failures.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const FAST = { turnMs: 5000, stallMs: 600, graceMs: 1500, checkMs: 8000 };
const KEY = ['sk', 'compat', 'headless', 'key', '0123456789'].join('-');
const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-headless-test-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};
const lines = (state, events) => { for (const e of events) state.read(typeof e === 'string' ? e : JSON.stringify(e)); return state; };
const reader = (read) => { const state = { chunks: [] }; state.read = (line) => read(line, state); return state; };

test('provider_unsupported is a named, final failure kind', () => {
  assert.equal(FAILURE_KINDS.provider_unsupported.retryable, false);
});

test('the shared headless runner passes the compat suite driving fake-cli as a real child', async () => {
  const fake = await startFakeProvider();
  try {
    const rows = await runTarget(
      { cli: 'headless-fake', version: '1.0.0', adapter: 'test-support/headless-fake-adapter.js#createHeadlessFakeAdapter', enabled: true },
      { provider: { ...fake, apiKey: KEY }, timeouts: FAST },
    );
    const notPass = rows.filter((r) => r.status !== 'pass');
    assert.deepEqual(notPass.map((r) => `${r.check}:${r.status}`), ['retry-status:skip', 'retry-status-surfaced:skip'], JSON.stringify(notPass));
    assert.match(rows.find((r) => r.check === 'refusal').detail, /^refusal named after 1 provider request/);
    assert.match(rows.find((r) => r.check === 'stall').detail, /RunFailure timeout/);
  } finally {
    await fake.close();
  }
});

test('a CLI that cannot reach the provider fails every turn check with provider_unsupported, never a skip or a pass', async () => {
  const fake = await startFakeProvider();
  try {
    const rows = await runTarget(
      { cli: 'unsupported-fake', version: '1.0.0', adapter: 'test-support/headless-fake-adapter.js#createUnsupportedFakeAdapter', enabled: true },
      { provider: { ...fake, apiKey: KEY }, timeouts: FAST },
    );
    assert.equal(rows.length, CHECKS.length);
    assert.deepEqual(rows.filter((r) => r.status === 'pass').map((r) => r.check), ['detect', 'version-pin']);
    for (const row of rows.filter((r) => !['detect', 'version-pin'].includes(r.check))) {
      assert.equal(row.status, 'fail', row.check);
      assert.match(row.detail, /RunFailure provider_unsupported: fake-cli: this CLI only talks to its vendor's own service/, row.check);
    }
    assert.equal(fake.requests.length, 0, 'no process started, so the provider was never asked');
  } finally {
    await fake.close();
  }
});

test('a timed-out turn takes the CLI and everything it started with it', () => withTmp(async (dir) => {
  const pidFile = join(dir, 'grandchild.pid');
  const adapter = createHeadlessAdapter({
    name: 'sleeper', cli: 'sleeper', command: '/bin/sh', versionPattern: /(x)/,
    launch: async (prompt, ctx, { env }) => ({ args: ['-c', `sleep 30 & echo $! > ${pidFile}; wait`], env }),
    read: () => {},
  })();
  const events = [];
  await assert.rejects(
    adapter.spawn('hi', {
      provider: { baseURL: 'http://127.0.0.1:9/v1', apiKey: KEY, model: 'm' },
      env: { PATH: process.env.PATH, HOME: dir }, cwd: dir, timeoutMs: 400,
      trace: { emit: (type, data) => events.push({ type, data }) },
    }),
    (error) => error instanceof RunFailure && error.kind === 'timeout',
  );
  const pid = Number(readFileSync(pidFile, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, 'the grandchild is gone');
  assert.deepEqual(events.map((e) => e.type), ['run.started', 'turn.prompt_sent', 'process.exited', 'run.settled']);
  assert.equal(events.at(-1).data.failure.kind, 'timeout');
}));

test('a CLI error text becomes refusal for a 4xx or refusal wording, exited otherwise, with the key scrubbed', () => {
  const refusal = failureFromText('x', '400 The request was rejected by the content policy.', { credentials: [KEY], exitCode: 1 });
  assert.equal(refusal.kind, 'refusal');
  assert.match(refusal.detail, /x \(exit 1\) upstream 400: /);
  assert.equal(failureFromText('x', '[API Error: 400 The request was rejected by the content policy.]').kind, 'refusal');
  const upstream = failureFromText('x', `503 fake provider failure for ${KEY}`, { credentials: [KEY] });
  assert.equal(upstream.kind, 'exited');
  assert.doesNotMatch(`${upstream.message} ${upstream.detail}`, new RegExp(KEY));
});

// Lines as each CLI printed them against the fake provider (2026-10-25,
// node:22-bookworm, --network none), trimmed to the fields the readers use.
test('copilot JSONL: deltas are chunks, the last assistant message is the reply, result carries the session id', () => {
  const ok = lines(reader(readCopilotEvent), [
    { type: 'session.mcp_servers_loaded', data: { servers: [] } },
    { type: 'assistant.message_delta', data: { deltaContent: 'PONG' } },
    { type: 'assistant.message', data: { content: 'PONG', toolRequests: [] } },
    { type: 'result', sessionId: '5525b154-8ef6-405b-8670-188b5505e8de', exitCode: 0 },
  ]);
  assert.deepEqual([ok.text, ok.sessionId, ok.chunks], ['PONG', '5525b154-8ef6-405b-8670-188b5505e8de', ['PONG']]);
  const refused = lines(reader(readCopilotEvent), [
    { type: 'session.error', data: { errorType: 'query', message: '400 The request was rejected by the content policy.', statusCode: 400 } },
    { type: 'result', sessionId: 's', exitCode: 1 },
  ]);
  assert.equal(refused.error, '400 The request was rejected by the content policy.');
});

test('qwen stream-json: the result event says the reply or the error', () => {
  const ok = lines(reader(readQwenEvent), [
    { type: 'system', subtype: 'init', session_id: 'q1' },
    { type: 'assistant', session_id: 'q1', message: { content: [{ type: 'text', text: 'PONG' }] } },
    { type: 'result', subtype: 'success', session_id: 'q1', is_error: false, result: 'PONG' },
  ]);
  assert.deepEqual([ok.text, ok.sessionId, ok.chunks], ['PONG', 'q1', ['PONG']]);
  const refused = lines(reader(readQwenEvent), [
    { type: 'result', subtype: 'error_during_execution', session_id: 'q2', is_error: true, error: { message: '[API Error: 400 The request was rejected by the content policy.]' } },
  ]);
  assert.match(refused.error, /content policy/);
  assert.equal(refused.text, undefined);
});

test('cline NDJSON: run_result closes the turn; the session id is the session directory the turn added', () => withTmp(async (dir) => {
  const ok = lines(reader(readClineEvent), [
    { type: 'hook_event', hookEventName: 'agent_start', taskId: 'conv_1792972564607_fdul1cd' },
    { type: 'agent_event', event: { type: 'content_start', contentType: 'text', text: 'PONG' } },
    { type: 'run_result', finishReason: 'completed', text: 'PONG' },
  ]);
  assert.deepEqual([ok.text, ok.sessionId, ok.chunks], ['PONG', undefined, ['PONG']], 'the taskId is not the id --id resumes');
  mkdirSync(join(dir, 'old_1'));
  mkdirSync(join(dir, '1792974520134_2h5tn'));
  const end = { code: 0, stderr: '', credentials: [] };
  assert.deepEqual(settleCline({ ...ok, sessionsDir: dir, sessionsBefore: ['old_1'] }, end), { text: 'PONG', newSessionId: '1792974520134_2h5tn' });
  assert.deepEqual(settleCline({ ...ok, sessionsDir: dir, sessionsBefore: [] }, end), { text: 'PONG' }, 'two new sessions: no guess');
  assert.deepEqual(settleCline({ ...ok, sessionsDir: dir, sessionsBefore: [], resumed: 'old_1' }, end), { text: 'PONG', newSessionId: 'old_1' });
  const failed = lines(reader(readClineEvent), [
    { type: 'agent_event', event: { type: 'error', error: { message: 'getaddrinfo ETIMEOUT api.openai.com' } } },
    { type: 'run_result', finishReason: 'error', text: '' },
  ]);
  assert.equal(failed.error, 'getaddrinfo ETIMEOUT api.openai.com');
}));

test('aider: the reply sits between the banner and the Tokens line; no Tokens line is a failure even on exit 0', () => {
  const banner = ['Aider v0.86.2', 'Model: openai/fake-model with whole edit format', 'Git repo: none', 'Repo-map: disabled', ''];
  assert.deepEqual(
    settleAider({ lines: [...banner, 'PONG', '', 'Tokens: 10 sent, 1 received.'], sessionId: 's1' }, { code: 0, stderr: '', credentials: [] }),
    { text: 'PONG', newSessionId: 's1' },
  );
  assert.equal(
    settleAider({ lines: [...banner, 'Restored previous conversation history.', '', 'PONG-2', 'Tokens: 632 sent, 4 received.'] }, { code: 0, stderr: '', credentials: [] }).text,
    'PONG-2',
  );
  const refusal = [...banner, 'litellm.BadRequestError: litellm.ContentPolicyViolationError: ', 'ContentPolicyViolationError: OpenAIException - The request was rejected by the ', 'content policy.'];
  assert.throws(() => settleAider({ lines: refusal }, { code: 0, stderr: '', credentials: [] }), (e) => e.kind === 'refusal');
  const unavailable = [...banner, 'litellm.ServiceUnavailableError: ServiceUnavailableError: OpenAIException - fake', 'provider failure', 'Retrying in 0.2 seconds...'];
  assert.throws(() => settleAider({ lines: unavailable }, { code: 0, stderr: '', credentials: [] }), (e) => e.kind === 'exited' && /ServiceUnavailableError/.test(e.detail));
});

// Each adapter's launch, captured at the spawn: the key is in env or a 0600
// file, never argv, and the provider route is the run's.
const captureLaunch = (factory) => withTmp(async (home) => {
  let seen;
  const adapter = factory({ binaryPath: '/opt/cli' });
  await adapter.spawn('Reply PONG', {
    provider: { baseURL: 'http://127.0.0.1:4010/v1/', apiKey: KEY, model: 'fake-model' },
    env: { PATH: process.env.PATH, HOME: home }, cwd: home, timeoutMs: 5000, sessionId: undefined,
    _spawnImpl: (command, args, options) => {
      seen = { command, args, env: options.env, detached: options.detached };
      return spawn(process.execPath, ['-e', ''], options);
    },
  }).catch(() => {});
  const files = {};
  const providers = join(home, '.cline', 'data', 'settings', 'providers.json');
  if (existsSync(providers)) files.providers = { mode: statSync(providers).mode & 0o777, body: JSON.parse(readFileSync(providers, 'utf8')) };
  return { ...seen, files };
});

test('copilot, qwen, cline and aider keep the key out of argv and point at the run\'s provider', async () => {
  const copilot = await captureLaunch(createCopilotAdapter);
  assert.equal(copilot.command, '/opt/cli');
  assert.equal(copilot.env.COPILOT_PROVIDER_BASE_URL, 'http://127.0.0.1:4010/v1');
  assert.equal(copilot.env.COPILOT_PROVIDER_API_KEY, KEY);
  assert.equal(copilot.env.COPILOT_OFFLINE, 'true');

  const qwen = await captureLaunch(createQwenAdapter);
  assert.deepEqual(qwen.args.slice(0, 4), ['--bare', '--safe-mode', '--auth-type', 'openai']);
  assert.equal(qwen.env.OPENAI_BASE_URL, 'http://127.0.0.1:4010/v1');
  assert.equal(qwen.env.OPENAI_API_KEY, KEY);

  const cline = await captureLaunch(createClineAdapter);
  assert.equal(cline.files.providers.mode, 0o600);
  assert.equal(cline.files.providers.body.providers['openai-compatible'].settings.baseUrl, 'http://127.0.0.1:4010/v1');
  assert.equal(cline.files.providers.body.providers['openai-compatible'].settings.apiKey, KEY);
  assert.ok(Date.parse(cline.files.providers.body.providers['openai-compatible'].updatedAt), 'cline skips an entry with no updatedAt');
  assert.equal(cline.args.at(-1), 'Reply PONG');

  const aider = await captureLaunch(createAiderAdapter);
  assert.equal(aider.args[aider.args.indexOf('--openai-api-base') + 1], 'http://127.0.0.1:4010/v1');
  assert.equal(aider.args[aider.args.indexOf('--model') + 1], 'openai/fake-model');
  assert.equal(aider.env.OPENAI_API_KEY, KEY);

  for (const [name, seen] of Object.entries({ copilot, qwen, cline, aider })) {
    assert.ok(seen.args.every((arg) => !arg.includes(KEY)), `${name} argv`);
    assert.equal(seen.env.HOME !== undefined, true, `${name} HOME`);
    assert.equal(Object.keys(seen.env).some((k) => /^(?:ANTHROPIC|GITHUB|GH|AWS)_/.test(k)), false, `${name} env carries nothing of the host's`);
  }
});

test('every new compat row loads its adapter, and the three that cannot reach the provider say so', async () => {
  const targets = loadTargets(join(PACKAGE_ROOT, 'compat', 'targets.json'));
  const added = ['copilot', 'gemini', 'qwen-code', 'cline', 'aider', 'amp', 'cursor'];
  for (const cli of added) {
    const target = targets.find((t) => t.cli === cli);
    assert.ok(target, cli);
    const { adapter, error, skip } = await loadAdapter(target, { binaryPath: '/nonexistent' });
    assert.ok(adapter, `${cli}: ${error || skip}`);
    assert.equal(await adapter.detect(), null, `${cli}: no binary, no version`);
    const pinned = target.binary.npm || target.binary.pip || Object.values(target.binary.release || {})[0]?.url;
    assert.ok(pinned.includes(target.version), `${cli} pins its own version`);
    if (target.binary.release) for (const asset of Object.values(target.binary.release)) assert.match(asset.sha256, /^[0-9a-f]{64}$/);
    if (['gemini', 'amp', 'cursor'].includes(cli)) {
      assert.equal(adapter.supportsProvider, false, cli);
      await assert.rejects(adapter.spawn('hi', {}), (e) => e.kind === 'provider_unsupported' && /OpenAI- or Anthropic-compatible/.test(e.detail), cli);
    }
  }
});
