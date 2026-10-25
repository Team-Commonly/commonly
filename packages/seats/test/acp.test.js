import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { createAcpAdapter, defaultPermissionDecision, readsAsRefusal } from '../src/adapters/acp.js';
import { createAcpClient } from '../src/acp/client.js';
import {
  launchGoose, launchOpencode, readGooseReplyFailure, acpGoose, acpOpencode,
} from '../src/adapters/acp-launch.js';
import { RunFailure, runFailure } from '../src/failures.js';
import { isEventType } from '../src/trace/events.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const AGENT = fileURLToPath(new URL('../test-support/fake-acp-agent.mjs', import.meta.url));
const KEY = 'sk-test-0123456789abcdef';
const FAST = { cancelGraceMs: 300, closeGraceMs: 300, killGraceMs: 300 };

const scratch = () => mkdtempSync(join(tmpdir(), 'seats-acp-'));

/** An adapter over the fake agent, plus what a test inspects afterwards. */
const harness = ({ env = {}, ...options } = {}) => {
  const dir = scratch();
  const logPath = join(dir, 'agent.log');
  const state = { launches: 0, cleanups: 0 };
  const adapter = createAcpAdapter({
    name: 'fake-acp',
    detect: async () => null,
    timings: FAST,
    launch: (ctx) => {
      state.launches += 1;
      return {
        command: process.execPath,
        args: [AGENT],
        env: {
          PATH: process.env.PATH, OPENAI_API_KEY: ctx.provider?.apiKey || '', FAKE_ACP_LOG: logPath,
          FAKE_ACP_PROVIDER_URL: ctx.provider?.baseURL || '', ...env,
        },
        cwd: dir,
        cleanup: () => { state.cleanups += 1; },
      };
    },
    ...options,
  });
  const events = [];
  const trace = {
    emit(type, data) {
      assert.ok(isEventType(type), `unknown trace type ${type}`);
      events.push({ type, data });
    },
  };
  const received = () => (existsSync(logPath)
    ? readFileSync(logPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : []);
  const methods = () => received().map((entry) => entry.method || entry.event || (entry.result !== undefined ? 'response' : 'error'));
  const ctx = (extra = {}) => ({ trace, provider: { baseURL: 'http://127.0.0.1:9/v1', apiKey: KEY, model: 'm' }, ...extra });
  const done = () => rmSync(dir, { recursive: true, force: true });
  return { adapter, events, received, methods, ctx, state, done };
};

const types = (events) => events.map((event) => event.type);
const rejectsKind = async (promise, kind) => {
  const error = await promise.then(() => null, (failure) => failure);
  assert.ok(error instanceof RunFailure, `expected a RunFailure, got ${error}`);
  assert.equal(error.kind, kind, error.message);
  return error;
};

test('happy path: initialize, new session, one prompt; the trace follows the update stream', async () => {
  const h = harness();
  try {
    const seen = [];
    const adapter = createAcpAdapter({
      name: 'fake-acp', detect: async () => null, timings: FAST,
      launch: () => ({ command: process.execPath, args: [AGENT], env: { PATH: process.env.PATH } }),
      memoryPreamble: (prompt, longTerm, opts) => { seen.push(opts); return `[memory]\n${prompt}`; },
    });
    const result = await h.adapter.spawn('hello', h.ctx());
    assert.deepEqual(result, { text: 'PONG', newSessionId: 'sess-new-1', contextTokens: 42 });
    assert.deepEqual(types(h.events), [
      'session.opened', 'turn.prompt_sent', 'agent.thought_chunk', 'tool.call', 'tool.update', 'plan',
      'usage', 'agent.message_chunk', 'agent.message_chunk', 'usage', 'process.exited',
    ]);
    const [opened, sent, thought, call, toolUpdate, plan, context, , , usage, exited] = h.events.map((e) => e.data);
    assert.deepEqual(opened, { method: 'new', sessionId: 'sess-new-1' });
    assert.deepEqual(sent, { chars: 5 });
    assert.deepEqual(thought, { chars: 13 }, 'thoughts are counted, never stored');
    assert.deepEqual(call, { toolCallId: 'tc-1', title: 'Read file', kind: 'read', status: 'pending' });
    assert.deepEqual(toolUpdate, { toolCallId: 'tc-1', status: 'completed', title: undefined });
    assert.deepEqual(plan, { entries: [{ content: 'answer', status: 'completed' }] });
    assert.deepEqual(context, { inputTokens: null, outputTokens: null, totalTokens: null, cost: null, contextTokens: 42, contextSize: 1000 });
    assert.deepEqual(usage, { inputTokens: 10, outputTokens: 2, totalTokens: 12, cost: null });
    assert.deepEqual(exited, { code: 0, signal: null }, 'a finished agent exits on stdin EOF, not by signal');
    assert.equal(h.state.cleanups, 1);

    const init = h.received().find((m) => m.method === 'initialize');
    assert.equal(init.params.protocolVersion, 1);
    assert.deepEqual(init.params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
    const promptSent = h.received().find((m) => m.method === 'session/prompt');
    assert.deepEqual(promptSent.params, { sessionId: 'sess-new-1', prompt: [{ type: 'text', text: 'hello' }] });

    const preambleRun = await adapter.spawn('hi', { trace: { emit() {} } });
    assert.equal(preambleRun.text, 'PONG');
    assert.deepEqual(seen, [{ freshSession: true }]);
  } finally { h.done(); }
});

test('a requested session prefers session/resume over session/load', async () => {
  const h = harness({ env: { FAKE_ACP_CAPS: 'resume,load' } });
  try {
    const result = await h.adapter.spawn('[[echo-session]]', h.ctx({ sessionId: 'sess-old' }));
    assert.deepEqual(result, { text: 'SESSION:sess-old', newSessionId: 'sess-old' });
    const sessionCalls = h.received().map((m) => m.method).filter((m) => m?.startsWith('session/') && m !== 'session/prompt');
    assert.deepEqual(sessionCalls, ['session/resume']);
    assert.deepEqual(h.events[0].data, { method: 'resume', sessionId: 'sess-old' });
  } finally { h.done(); }
});

test('session/load is used without resume, and its replayed history is not the reply', async () => {
  const h = harness({ env: { FAKE_ACP_CAPS: 'load' } });
  try {
    const result = await h.adapter.spawn('[[reply:fresh]]', h.ctx({ sessionId: 'sess-old' }));
    assert.equal(result.text, 'fresh');
    assert.ok(!h.events.some((e) => e.type === 'agent.message_chunk' && e.data.text === 'REPLAYED'));
    assert.deepEqual(h.events[0].data, { method: 'load', sessionId: 'sess-old' });
  } finally { h.done(); }
});

test('a session that cannot be reopened falls back to session/new and the trace says why', async () => {
  const none = harness();
  const failing = harness({ env: { FAKE_ACP_CAPS: 'resume,load', FAKE_ACP_FAIL: 'resume,load' } });
  try {
    const result = await none.adapter.spawn('[[echo-session]]', none.ctx({ sessionId: 'sess-old' }));
    assert.equal(result.newSessionId, 'sess-new-1');
    assert.deepEqual(none.events[0].data, {
      method: 'new', sessionId: 'sess-new-1', requestedSessionId: 'sess-old',
      fallback: 'agent supports neither session/resume nor session/load',
    });
    await failing.adapter.spawn('[[echo-session]]', failing.ctx({ sessionId: 'sess-old' }));
    const sessionCalls = failing.received().map((m) => m.method).filter((m) => /^session\/(resume|load|new)$/.test(m || ''));
    assert.deepEqual(sessionCalls, ['session/resume', 'session/load', 'session/new']);
    assert.equal(failing.events[0].data.fallback, 'session/load answered error -32002');
  } finally { none.done(); failing.done(); }
});

test('the memory preamble is told whether the session is fresh', async () => {
  const seen = [];
  const h = harness({ env: { FAKE_ACP_CAPS: 'resume' }, memoryPreamble: (prompt, longTerm, opts) => { seen.push([longTerm, opts.freshSession]); return `${longTerm}|${prompt}`; } });
  try {
    await h.adapter.spawn('[[reply:a]]', h.ctx({ sessionId: 'sess-old', memoryLongTerm: 'MEM' }));
    await h.adapter.spawn('[[reply:b]]', h.ctx({ memoryLongTerm: 'MEM' }));
    assert.deepEqual(seen, [['MEM', false], ['MEM', true]]);
    const prompts = h.received().filter((m) => m.method === 'session/prompt').map((m) => m.params.prompt[0].text);
    assert.deepEqual(prompts, ['MEM|[[reply:a]]', 'MEM|[[reply:b]]']);
  } finally { h.done(); }
});

test('any protocol version other than 1 is unsupported', async () => {
  const h = harness({ env: { FAKE_ACP_VERSION: '2' } });
  try {
    const error = await rejectsKind(h.adapter.spawn('hi', h.ctx()), 'unsupported');
    assert.match(error.message, /protocol 2/);
    assert.ok(!h.received().some((m) => m.method === 'session/new'), 'nothing past initialize');
    assert.equal(h.state.cleanups, 1);
  } finally { h.done(); }
});

test('stop reasons map to failure kinds', async () => {
  const h = harness();
  try {
    for (const reason of ['refusal', 'max_tokens', 'max_turn_requests', 'cancelled']) {
      await rejectsKind(h.adapter.spawn(`[[stop:${reason}]]`, h.ctx()), reason);
    }
    await rejectsKind(h.adapter.spawn('[[stop:made_up]]', h.ctx()), 'protocol');
  } finally { h.done(); }
});

test('a JSON-RPC error on the prompt is protocol, unless it reads as an upstream refusal', async () => {
  const h = harness();
  try {
    // The shape opencode 1.19.0 answers with for a 400 content-policy body.
    const refusal = await rejectsKind(h.adapter.spawn('[[rpc-error:-32603:Internal error: The request was rejected by the content policy.]]', h.ctx()), 'refusal');
    assert.match(refusal.message, /content policy/);
    await rejectsKind(h.adapter.spawn('[[rpc-error:-32603:Internal error: disk on fire]]', h.ctx()), 'protocol');
    const echoed = await rejectsKind(h.adapter.spawn(`[[rpc-error:-32603:bad key ${KEY}]]`, h.ctx()), 'protocol');
    assert.doesNotMatch(echoed.message, new RegExp(KEY));
  } finally { h.done(); }
});

test('permission without a hook: reject_once if offered, otherwise cancelled', async () => {
  const h = harness();
  try {
    const rejected = await h.adapter.spawn('[[permission]]', h.ctx());
    assert.equal(rejected.text, 'PERM:{"outcome":"selected","optionId":"reject"}');
    const requested = h.events.find((e) => e.type === 'permission.requested').data;
    assert.deepEqual(requested, { toolCallId: 'tc-1', options: [{ optionId: 'allow', kind: 'allow_once' }, { optionId: 'reject', kind: 'reject_once' }] });
    assert.deepEqual(h.events.find((e) => e.type === 'permission.decided').data, { outcome: 'selected', optionId: 'reject', kind: 'reject_once' });

    const cancelled = await h.adapter.spawn('[[permission-noreject]]', h.ctx());
    assert.equal(cancelled.text, 'PERM:{"outcome":"cancelled"}');
    assert.deepEqual(defaultPermissionDecision([]), { outcome: 'cancelled' });
  } finally { h.done(); }
});

test('permission with a hook: its answer is used only when it names an offered option', async () => {
  const h = harness();
  try {
    const asked = [];
    const allow = await h.adapter.spawn('[[permission]]', h.ctx({
      decidePermission: async (request) => { asked.push(request); return { outcome: 'selected', optionId: 'allow' }; },
    }));
    assert.equal(allow.text, 'PERM:{"outcome":"selected","optionId":"allow"}');
    assert.equal(asked[0].sessionId, 'sess-new-1');
    assert.deepEqual(asked[0].toolCall, { toolCallId: 'tc-1', title: 'Edit file', kind: 'edit' });
    assert.equal(asked[0].options.length, 2);

    const bogus = await h.adapter.spawn('[[permission]]', h.ctx({ decidePermission: async () => ({ outcome: 'selected', optionId: 'root' }) }));
    assert.equal(bogus.text, 'PERM:{"outcome":"selected","optionId":"reject"}');
    const thrown = await h.adapter.spawn('[[permission]]', h.ctx({ decidePermission: () => { throw new Error('hook broke'); } }));
    assert.equal(thrown.text, 'PERM:{"outcome":"selected","optionId":"reject"}');
    const declined = await h.adapter.spawn('[[permission]]', h.ctx({ decidePermission: async () => ({ outcome: 'cancelled' }) }));
    assert.equal(declined.text, 'PERM:{"outcome":"cancelled"}');
  } finally { h.done(); }
});

test('fs and terminal requests are refused with -32601', async () => {
  const h = harness();
  try {
    const result = await h.adapter.spawn('[[fs]]', h.ctx());
    assert.equal(result.text, 'FS:-32601 TERM:-32601');
  } finally { h.done(); }
});

test('a malformed line or an oversized line is a protocol failure', async () => {
  const h = harness({ maxLineChars: 1000 });
  try {
    const malformed = await rejectsKind(h.adapter.spawn('[[malformed]]', h.ctx()), 'protocol');
    assert.match(malformed.message, /not JSON/);
    const huge = await rejectsKind(h.adapter.spawn('[[huge:5000]]', h.ctx()), 'protocol');
    assert.match(huge.message, /exceeded 1000 chars/);
    assert.equal(h.events.filter((e) => e.type === 'process.exited').length, 2, 'the child is killed either way');
  } finally { h.done(); }
});

test('an agent that exits mid-turn is exited, with credentials scrubbed from the stderr tail', async () => {
  const h = harness();
  try {
    const error = await rejectsKind(h.adapter.spawn('[[exit]]', h.ctx()), 'exited');
    assert.match(error.message, /code 3/);
    assert.match(error.message, /fatal: provider rejected key \[redacted\]/);
    assert.doesNotMatch(error.message, new RegExp(KEY));
    assert.deepEqual(h.events.at(-1), { type: 'process.exited', data: { code: 3, signal: null } });
    assert.equal(h.state.cleanups, 1);
  } finally { h.done(); }
});

test('a command that cannot start is exited, and cleanup still runs', async () => {
  let cleaned = 0;
  const adapter = createAcpAdapter({
    name: 'missing', detect: async () => null, timings: FAST,
    launch: () => ({ command: '/nonexistent/acp-agent', args: [], env: {}, cleanup: () => { cleaned += 1; } }),
  });
  await rejectsKind(adapter.spawn('hi', {}), 'exited');
  assert.equal(cleaned, 1);
});

test('abort mid-turn sends session/cancel, waits for the cancelled response, and rejects cancelled', async () => {
  const h = harness();
  try {
    const controller = new AbortController();
    const run = h.adapter.spawn('[[hang]]', h.ctx({ signal: controller.signal }));
    await waitFor(() => h.events.some((e) => e.type === 'turn.prompt_sent'));
    controller.abort();
    await rejectsKind(run, 'cancelled');
    assert.ok(h.methods().includes('session/cancel'));
    assert.equal(h.state.cleanups, 1);
    assert.equal(h.events.at(-1).type, 'process.exited');
  } finally { h.done(); }
});

test('abort answers a pending permission request cancelled before the turn ends', async () => {
  const h = harness();
  try {
    const controller = new AbortController();
    const run = h.adapter.spawn('[[hang-permission]]', h.ctx({ signal: controller.signal, decidePermission: () => new Promise(() => {}) }));
    await waitFor(() => h.events.some((e) => e.type === 'permission.requested'));
    controller.abort();
    await rejectsKind(run, 'cancelled');
    const log = h.received();
    const answer = log.find((entry) => entry.event === 'permission-answer');
    assert.deepEqual(answer.outcome, { outcome: 'cancelled' });
    const order = h.methods();
    assert.ok(order.indexOf('response') < order.indexOf('session/cancel'), `permission answered before cancel: ${order}`);
    assert.deepEqual(h.events.find((e) => e.type === 'permission.decided').data, { outcome: 'cancelled', optionId: undefined, kind: undefined });
  } finally { h.done(); }
});

test('an abort whose reason is a RunFailure rejects with that failure', async () => {
  const h = harness();
  try {
    const controller = new AbortController();
    const run = h.adapter.spawn('[[hang]]', h.ctx({ signal: controller.signal }));
    await waitFor(() => h.events.some((e) => e.type === 'turn.prompt_sent'));
    const reason = runFailure('stuck', 'no progress');
    controller.abort(reason);
    assert.equal(await run.catch((error) => error), reason);
  } finally { h.done(); }
});

test('an agent deaf to cancel and SIGTERM is SIGKILLed after the grace periods', async () => {
  const h = harness();
  try {
    const controller = new AbortController();
    const run = h.adapter.spawn('[[hang-deaf]]', h.ctx({ signal: controller.signal }));
    await waitFor(() => h.events.some((e) => e.type === 'turn.prompt_sent'));
    const started = Date.now();
    controller.abort();
    await rejectsKind(run, 'cancelled');
    assert.ok(Date.now() - started >= FAST.cancelGraceMs + FAST.killGraceMs - 50);
    assert.deepEqual(h.events.at(-1).data, { code: null, signal: 'SIGKILL' });
  } finally { h.done(); }
});

test('an already-aborted signal never launches', async () => {
  const h = harness();
  try {
    const controller = new AbortController();
    controller.abort();
    await rejectsKind(h.adapter.spawn('hi', h.ctx({ signal: controller.signal })), 'cancelled');
    assert.equal(h.state.launches, 0);
  } finally { h.done(); }
});

test('timeoutMs takes the cancel path and rejects timeout', async () => {
  // The clock starts at spawn, so on a loaded host a short budget can run out
  // before the prompt is even sent; widen it until the prompt is in flight
  // when the timeout fires, which is the case under test.
  for (const timeoutMs of [300, 2000, 8000, 20000]) {
    const h = harness();
    try {
      const error = await rejectsKind(h.adapter.spawn('[[hang]]', h.ctx({ timeoutMs })), 'timeout');
      assert.match(error.message, new RegExp(`exceeded ${timeoutMs}ms`));
      if (!types(h.events).includes('turn.prompt_sent')) continue;
      assert.ok(h.methods().includes('session/cancel'));
      return;
    } finally { h.done(); }
  }
  assert.fail('the prompt was never in flight when the timeout fired');
});

test('public or sandbox-declared seats are refused before launch', async () => {
  const h = harness();
  try {
    await rejectsKind(h.adapter.spawn('hi', h.ctx({ environment: { sandbox: { trust: 'public' } } })), 'unsupported');
    await rejectsKind(h.adapter.spawn('hi', h.ctx({ environment: { sandbox: { mode: 'bwrap' } } })), 'unsupported');
    assert.equal(h.state.launches, 0);
  } finally { h.done(); }
});

test('client: an answer to an id never sent is a protocol failure that rejects pending requests', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const failures = [];
  const client = createAcpClient({ input, output, onProtocolError: (failure) => failures.push(failure) });
  const pending = client.request('initialize', {});
  input.write('{"jsonrpc":"2.0","id":999,"result":{}}\n');
  const error = await pending.catch((failure) => failure);
  assert.equal(error.kind, 'protocol');
  assert.equal(failures.length, 1);
  assert.match(output.read().toString(), /"method":"initialize"/);
});

test('refusal reading covers the measured agent shapes', () => {
  assert.ok(readsAsRefusal('Internal error: The request was rejected by the content policy.'));
  assert.ok(readsAsRefusal('Request failed: Bad request (400): nope'));
  assert.ok(readsAsRefusal('Rate limit exceeded: fake provider failure.'));
  assert.ok(!readsAsRefusal('Server error: Server error (500 Internal Server Error) at http://x'));
  assert.ok(!readsAsRefusal('Internal error: disk on fire'));
});

test('goose reply failures: the measured "Ran into this error" texts become named failures', () => {
  const refusal = readGooseReplyFailure('Ran into this error: Request failed: Bad request (400): The request was rejected by the content policy..\n\nPlease retry if you think this is a transient or recoverable error.');
  assert.equal(refusal.kind, 'refusal');
  assert.doesNotMatch(refusal.message, /Please retry/);
  assert.equal(readGooseReplyFailure('Ran into this error: Rate limit exceeded: fake provider failure.').kind, 'refusal');
  assert.equal(readGooseReplyFailure('Ran into this error: Server error: Server error (500 Internal Server Error) at http://127.0.0.1:1/v1').kind, 'protocol');
  assert.equal(readGooseReplyFailure(`Ran into this error: key ${KEY} bad`, { credentials: [KEY] }).message.includes(KEY), false);
  assert.equal(readGooseReplyFailure('PONG'), null);
  assert.equal(readGooseReplyFailure('I ran into this error yesterday'), null);
});

test('launchGoose: provider in env, never argv; caller HOME kept; throwaway HOME removed', async () => {
  const home = scratch();
  try {
    const provider = { baseURL: 'http://127.0.0.1:4321/v1', apiKey: KEY, model: 'fake-model' };
    const launched = await launchGoose({ provider, cwd: home, env: { PATH: '/usr/bin', HOME: home, OPENROUTER_API_KEY: 'sk-or-must-not-pass-123' } });
    assert.deepEqual([launched.command, launched.args], ['goose', ['acp']]);
    assert.equal(launched.env.HOME, home);
    assert.equal(launched.env.OPENAI_HOST, 'http://127.0.0.1:4321');
    assert.equal(launched.env.OPENAI_BASE_PATH, 'v1/chat/completions');
    assert.equal(launched.env.OPENAI_API_KEY, KEY);
    assert.equal(launched.env.GOOSE_PROVIDER, 'openai');
    assert.equal(launched.env.GOOSE_MODEL, 'fake-model');
    assert.equal(launched.env.OPENROUTER_API_KEY, undefined, 'only safe names cross from ctx.env');
    assert.ok(!launched.args.join(' ').includes(KEY));
    await launched.cleanup();
    assert.ok(existsSync(home), 'a caller HOME is never removed');

    const throwaway = await launchGoose({ provider });
    assert.notEqual(throwaway.env.HOME, process.env.HOME);
    assert.ok(existsSync(throwaway.env.HOME));
    await throwaway.cleanup();
    assert.ok(!existsSync(throwaway.env.HOME));
    await assert.rejects(launchGoose({ provider: { ...provider, baseURL: 'http://u:p@host/v1' } }), (e) => e.kind === 'unsupported');
    await assert.rejects(launchGoose({}), (e) => e.kind === 'unsupported');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('launchOpencode: the key lives in a 0600 file the config names, never in config, env or argv', async () => {
  const home = scratch();
  try {
    const launched = await launchOpencode({ provider: { baseURL: 'http://127.0.0.1:4321/v1', apiKey: KEY, model: 'fake-model' }, env: { HOME: home, PATH: '/usr/bin' } });
    assert.deepEqual([launched.command, launched.args], ['opencode', ['acp']]);
    const configText = readFileSync(launched.env.OPENCODE_CONFIG, 'utf8');
    const config = JSON.parse(configText);
    assert.equal(config.model, 'seats/fake-model');
    assert.deepEqual(config.enabled_providers, ['seats']);
    const { options } = config.provider.seats;
    assert.equal(options.baseURL, 'http://127.0.0.1:4321/v1');
    const keyFile = /^\{file:(.+)\}$/.exec(options.apiKey)[1];
    assert.equal(readFileSync(keyFile, 'utf8'), KEY);
    assert.equal(statSync(keyFile).mode & 0o777, 0o600);
    assert.ok(!configText.includes(KEY));
    assert.ok(!Object.values(launched.env).some((value) => String(value).includes(KEY)));
    assert.equal(launched.env.OPENCODE_DISABLE_PROJECT_CONFIG, '1');
    assert.equal(launched.env.XDG_DATA_HOME, join(home, '.local', 'share'), 'sessions live under the caller HOME');
    assert.notEqual(launched.env.XDG_CONFIG_HOME, join(home, '.config'), 'global config is isolated');
    await launched.cleanup();
    assert.ok(!existsSync(keyFile));
    assert.ok(existsSync(home));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('the shipped adapters satisfy the Adapter contract', () => {
  for (const adapter of [acpGoose, acpOpencode]) {
    assert.equal(typeof adapter.name, 'string');
    assert.equal(typeof adapter.detect, 'function');
    assert.equal(typeof adapter.spawn, 'function');
  }
  assert.deepEqual([acpGoose.name, acpOpencode.name], ['acp-goose', 'acp-opencode']);
});

/**
 * How long a run took to settle after the provider first saw a request. Timing
 * from that moment, not from spawn, keeps process start-up on a loaded host
 * out of a "fires fast" claim.
 */
const settleAfterFirstRequest = async (provider, settling) => {
  let firstAt = null;
  const poll = setInterval(() => { if (firstAt === null && provider.requests.length) firstAt = Date.now(); }, 5);
  try {
    const error = await settling;
    return { error, afterFirstMs: Date.now() - (firstAt ?? Date.now()) };
  } finally { clearInterval(poll); }
};

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Runs a turn whose agent leaves a SIGTERM-deaf grandchild; it must not survive. */
const grandchildOutlives = async (prompt, ctxExtra, settle) => {
  const h = harness();
  let pid;
  try {
    await settle(h.adapter.spawn(prompt, h.ctx(ctxExtra(h))), h);
    pid = h.received().find((entry) => entry.event === 'grandchild')?.pid;
    assert.ok(pid, 'the agent started a grandchild');
    // A killed orphan is reaped by init asynchronously; give it a moment.
    const deadline = Date.now() + 2000;
    while (alive(pid) && Date.now() < deadline) await new Promise((r) => { setTimeout(r, 20); });
    return alive(pid);
  } finally {
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    h.done();
  }
};

test('abort kills the whole process group: a SIGTERM-deaf grandchild does not outlive the run', async () => {
  const controller = new AbortController();
  const survived = await grandchildOutlives('[[grandchild:hang]]', () => ({ signal: controller.signal }), async (run, h) => {
    await waitFor(() => h.received().some((entry) => entry.event === 'grandchild'));
    controller.abort();
    await rejectsKind(run, 'cancelled');
  });
  assert.equal(survived, false);
});

test('a timeout kills the whole process group too', async () => {
  const survived = await grandchildOutlives('[[grandchild:hang]]', () => ({ timeoutMs: 1500 }), async (run) => {
    await rejectsKind(run, 'timeout');
  });
  assert.equal(survived, false);
});

test('an agent that exits mid-turn or ends normally leaves no descendant behind', async () => {
  assert.equal(await grandchildOutlives('[[grandchild:exit]]', () => ({}), (run) => rejectsKind(run, 'exited')), false);
  assert.equal(await grandchildOutlives('[[grandchild:reply]]', () => ({}), async (run) => {
    assert.equal((await run).text, 'SPAWNED');
  }), false);
});

const providerAttempts = (h) => h.received().filter((entry) => entry.event === 'provider-attempt').map((entry) => entry.status);

test('the first provider refusal on the wire ends the run as refusal_retry_loop, fast', async () => {
  const provider = await startFakeProvider();
  const h = harness();
  try {
    const { error, afterFirstMs } = await settleAfterFirstRequest(provider, rejectsKind(h.adapter.spawn('[[provider:30]] [[refuse]]',
      h.ctx({ provider: { baseURL: provider.baseURL, apiKey: KEY, model: 'm' } })), 'refusal_retry_loop'));
    // The agent's own loop would run 30 attempts 200 ms apart (6 s and more).
    assert.ok(afterFirstMs < 3000, `settled ${afterFirstMs}ms after the first provider call`);
    assert.equal(provider.requests.length, 1, 'the provider sees the refused request once, never a retry');
    assert.match(error.detail, /400/);
    assert.ok(!error.message.includes(KEY));
    // The CLI's retries after the trip are answered by the relay, not the provider.
    assert.equal(providerAttempts(h)[0], 400);
    assert.ok(providerAttempts(h).slice(1).every((status) => status === 503));
    assert.equal(h.events.at(-1).type, 'process.exited');
  } finally { await provider.close(); h.done(); }
});

test('the first provider 5xx on the wire ends the run as provider_unavailable, fast', async () => {
  const provider = await startFakeProvider();
  const h = harness();
  try {
    const { error, afterFirstMs } = await settleAfterFirstRequest(provider, rejectsKind(h.adapter.spawn('[[provider:30]] [[fail:503]]',
      h.ctx({ provider: { baseURL: provider.baseURL, apiKey: KEY, model: 'm' } })), 'provider_unavailable'));
    assert.ok(afterFirstMs < 3000, `settled ${afterFirstMs}ms after the first provider call`);
    assert.equal(error.retryable, true);
    assert.equal(provider.requests.length, 1);
  } finally { await provider.close(); h.done(); }
});

test('an unreachable provider ends the run as provider_unavailable', async () => {
  const h = harness();
  try {
    await rejectsKind(h.adapter.spawn('[[provider:8]]', h.ctx()), 'provider_unavailable');
  } finally { h.done(); }
});

test('a healthy provider passes through the relay untouched', async () => {
  const provider = await startFakeProvider();
  const h = harness();
  try {
    const result = await h.adapter.spawn('[[provider:3]] [[reply:HELLO]]',
      h.ctx({ provider: { baseURL: provider.baseURL, apiKey: KEY, model: 'm' } }));
    assert.equal(result.text, 'PROVIDER:HELLO');
    assert.equal(provider.requests.length, 1);
    assert.equal(provider.requests[0].authorization, 'present');
  } finally { await provider.close(); h.done(); }
});

test('with watchProvider off the CLI\'s retries reach the provider (the watch is what stops them)', async () => {
  const provider = await startFakeProvider();
  const h = harness({ watchProvider: false });
  try {
    const result = await h.adapter.spawn('[[provider:3]] [[refuse]]',
      h.ctx({ provider: { baseURL: provider.baseURL, apiKey: KEY, model: 'm' } }));
    assert.equal(result.text, 'PROVIDER:400,400,400');
    assert.equal(provider.requests.length, 3);
  } finally { await provider.close(); h.done(); }
});

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
}
