/**
 * The gaps the security gate on #2701 found in the store's redaction, each
 * closed with a test that fails on the code it replaced:
 *
 *  1. a value split across streamed deltas matched none of them;
 *  2. a value under eight characters was granted and then not scrubbed;
 *  3. the runtime token and a RunFailure's detail never met the scrub.
 *
 * "Stored text" below is every chunk text the record holds for one stream,
 * joined in order: what a reader reconstructs the agent's output from.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { superviseRun } from '../src/supervisor.js';
import { prepareRunEnv } from '../src/valet/env.js';
import { RunFailure } from '../src/failures.js';

const CANARY = 'sk-test-CANARY-7f3a91c2d4e5b6a8';
const AGENT = { type: 'agent', id: 'u-agent-stream', owner: 'u-owner-stream' };
const OTHER = { type: 'agent', id: 'u-agent-other', owner: 'u-owner-stream' };
const FAST = { stallMs: 0, timeoutMs: 0, cancelGraceMs: 40 };

const withStore = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-redact-stream-'));
  try { return await fn(createTraceStore({ root }), root); } finally { rmSync(root, { recursive: true, force: true }); }
};
const allBytes = (root) => readdirSync(root, { recursive: true, withFileTypes: true })
  .filter((d) => d.isFile())
  .map((d) => readFileSync(join(d.parentPath ?? d.path, d.name), 'utf8'))
  .join('\n');
const storedText = (store, runId, kind, actorId) => store.readRun(runId)
  .filter((e) => e.kind === kind && (actorId === undefined || e.actor?.id === actorId))
  .map((e) => e.data.text)
  .join('');

/** The checks every split case shares: not in the bytes, not in the joined text, and the marker present. */
const assertScrubbed = (store, root, runId, streams) => {
  assert.equal(allBytes(root).includes(CANARY), false, 'the value is in the record bytes');
  for (const { kind, actorId, expected } of streams) {
    const text = storedText(store, runId, kind, actorId);
    assert.equal(text.includes(CANARY), false, `the joined ${kind} text reconstructs the value: ${text}`);
    assert.equal(text, expected, `the ${kind} stream lost or changed text`);
    assert.ok(text.includes('[redacted]'), 'positive control: the scrub replaced the value');
  }
  assert.equal(store.verifyRun(runId).ok, true, 'held text is written through the chain like any other line');
};

const splits = (n) => Array.from({ length: n - 1 }, (_, i) => i + 1);

test('a value split across two message deltas is scrubbed', () => withStore(async (store, root) => {
  const run = store.startRun({ runId: 'run-split-rhea' });
  run.redact([CANARY]);
  run.emit('agent.message_chunk', { text: 'the key is sk-test-CANA' });
  run.emit('agent.message_chunk', { text: 'RY-7f3a91c2d4e5b6a8 end' });
  const texts = store.readRun('run-split-rhea').map((e) => e.data.text);
  assert.deepEqual(texts, ['the key is ', '[redacted] end']);
  assert.equal(allBytes(root).includes(CANARY), false);
}));

for (const kind of ['agent.message_chunk', 'agent.thought_chunk']) {
  test(`${kind}: a value split in two, at every split point, never reaches the record`, () => withStore(async (store, root) => {
    for (const at of splits(CANARY.length)) {
      const runId = `run-two-${kind.length}-${at}`;
      const run = store.startRun({ runId, actor: AGENT });
      run.redact([CANARY]);
      run.emit('run.started', { adapter: 'fake', attempt: 1 });
      run.emit(kind, { text: `the key is ${CANARY.slice(0, at)}` });
      run.emit(kind, { text: `${CANARY.slice(at)} end` });
      run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
      assertScrubbed(store, root, runId, [{ kind, expected: 'the key is [redacted] end' }]);
    }
  }));
}

test('a value split three ways, at every pair of split points, never reaches the record', () => withStore(async (store, root) => {
  for (const a of splits(CANARY.length)) {
    for (let b = a + 1; b < CANARY.length; b += 1) {
      const runId = `run-three-${a}-${b}`;
      const run = store.startRun({ runId });
      run.redact([CANARY]);
      run.emit('agent.message_chunk', { text: `key ${CANARY.slice(0, a)}` });
      run.emit('agent.message_chunk', { text: CANARY.slice(a, b) });
      run.emit('agent.message_chunk', { text: `${CANARY.slice(b)}!` });
      run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
      assertScrubbed(store, root, runId, [{ kind: 'agent.message_chunk', expected: 'key [redacted]!' }]);
    }
  }
}));

test('two streams interleaved, each splitting the value, are scrubbed apart', () => withStore(async (store, root) => {
  for (const at of splits(CANARY.length)) {
    // Message vs thought, and the same kind from two actors: four streams, one line each in turn.
    const runId = `run-mix-${at}`;
    const run = store.startRun({ runId, actor: AGENT });
    run.redact([CANARY]);
    const head = `a ${CANARY.slice(0, at)}`;
    const tail = `${CANARY.slice(at)} z`;
    run.emit('agent.message_chunk', { text: head });
    run.emit('agent.thought_chunk', { text: head });
    run.emit('agent.message_chunk', { text: head }, { actor: OTHER });
    run.emit('usage', { inputTokens: 1 }); // a non-stream line between the halves releases nothing
    run.emit('agent.thought_chunk', { text: tail });
    run.emit('agent.message_chunk', { text: tail }, { actor: OTHER });
    run.emit('agent.message_chunk', { text: tail });
    run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
    assertScrubbed(store, root, runId, [
      { kind: 'agent.message_chunk', actorId: AGENT.id, expected: 'a [redacted] z' },
      { kind: 'agent.message_chunk', actorId: OTHER.id, expected: 'a [redacted] z' },
      { kind: 'agent.thought_chunk', actorId: AGENT.id, expected: 'a [redacted] z' },
    ]);
  }
}));

test('a stream that ends mid-value writes the marker before settle, never the prefix', () => withStore(async (store, root) => {
  const run = store.startRun({ runId: 'run-held-settle' });
  run.redact([CANARY]);
  run.emit('agent.message_chunk', { text: `cut off at ${CANARY.slice(0, 12)}` });
  run.emit('run.settled', { outcome: 'failed', failure: { kind: 'exited', detail: 'gone' }, durationMs: 1, attempts: 1 });
  const events = store.readRun('run-held-settle');
  assert.deepEqual(events.map((e) => [e.kind, e.data.text]), [
    ['agent.message_chunk', 'cut off at '],
    ['agent.message_chunk', '[redacted]'],
    ['run.settled', undefined],
  ]);
  assert.equal(allBytes(root).includes(CANARY.slice(0, 12)), false);
}));

// The security gate's probe: all but the last character, then the run ends.
test('a value cut one character short never reaches the record', () => withStore(async (store, root) => {
  const run = store.startRun({ runId: 'run-held-short' });
  run.redact([CANARY]);
  run.emit('agent.message_chunk', { text: `key: ${CANARY.slice(0, -1)}` });
  run.emit('liveness.recovery', { action: 'kill', attempt: 1 });
  run.emit('run.settled', { outcome: 'failed', failure: { kind: 'exited', detail: 'killed' }, durationMs: 1, attempts: 1 });
  assert.deepEqual(storedText(store, 'run-held-short', 'agent.message_chunk', undefined), 'key: [redacted]');
  assert.equal(allBytes(root).includes(CANARY.slice(0, -1)), false);
  assert.equal(allBytes(root).includes(CANARY.slice(0, 8)), false);
}));

// The value is registered as the run's runtime token, the one the supervisor itself hands the store.
test('a supervised run killed mid-value writes the marker for its held tail, before the settle and the retry', () => withStore(async (store, root) => {
  let spawns = 0;
  const adapter = {
    name: 'split-then-hang',
    spawn(prompt, ctx) {
      spawns += 1;
      ctx.trace.emit('agent.message_chunk', { text: `try ${spawns}: ${CANARY.slice(0, 10)}` });
      // Ignores the abort, so the supervisor's grace timer kills it.
      return new Promise(() => {});
    },
  };
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), 30);
  const out = await superviseRun({
    adapter, prompt: 'p', store, ctx: { signal: ctrl.signal, runtimeToken: CANARY }, policy: FAST,
  });
  assert.equal(out.outcome, 'cancelled');
  const events = store.readRun(out.runId);
  const settledAt = events.findIndex((e) => e.kind === 'run.settled');
  const chunks = events.filter((e) => e.kind === 'agent.message_chunk');
  assert.deepEqual(chunks.map((e) => e.data.text), ['try 1: ', '[redacted]']);
  assert.ok(chunks.every((e) => e.seq < events[settledAt].seq), 'the marker landed before run.settled');
  assert.equal(allBytes(root).includes(CANARY.slice(0, 10)), false, 'no prefix of the value on disk');

  // On retry, the first attempt's tail lands before the second attempt starts,
  // not glued to the second's text. (After the retry line: an adapter may still
  // stream during a cancel's grace window, so recovery lines do not release.)
  let tries = 0;
  const retrying = {
    name: 'split-then-exit',
    async spawn(prompt, ctx) {
      tries += 1;
      ctx.trace.emit('agent.message_chunk', { text: `try ${tries}: ${CANARY.slice(0, 10)}` });
      if (tries === 1) throw new RunFailure('exited', 'the CLI died');
      return {};
    },
  };
  const again = await superviseRun({
    adapter: retrying, prompt: 'p', store, ctx: { runtimeToken: CANARY }, policy: { ...FAST, retry: { max: 1 } },
  });
  assert.equal(again.outcome, 'ok');
  assert.deepEqual(store.readRun(again.runId).map((e) => e.kind === 'agent.message_chunk' ? e.data.text : e.kind), [
    'attempt.started', 'try 1: ', 'liveness.recovery', '[redacted]',
    'attempt.started', 'try 2: ', '[redacted]', 'run.settled',
  ]);
  assert.equal(allBytes(root).includes(CANARY.slice(0, 10)), false);
}));

test('the store scrubs a registered value of any length', () => withStore(async (store, root) => {
  const run = store.startRun({ runId: 'run-short-1' });
  run.redact(['abc123']);
  run.emit('agent.message_chunk', { text: 'value abc123 here' });
  run.emit('tool.update', { toolCallId: 't', title: 'abc123' });
  run.emit('run.settled', { outcome: 'ok', durationMs: 1, attempts: 1 });
  const bytes = allBytes(root);
  assert.equal(bytes.includes('abc123'), false, 'a six-character value reached the record');
  assert.equal(storedText(store, 'run-short-1', 'agent.message_chunk'), 'value [redacted] here');
}));

test('the valet refuses a credential under eight characters as credential_denied, before any HOME', async () => {
  const root = mkdtempSync(join(tmpdir(), 'seats-redact-short-'));
  try {
    const events = [];
    const trace = { emit: (type, data) => events.push({ type, data }), redact: () => assert.fail('a refused value was registered') };
    await assert.rejects(prepareRunEnv({
      grant: { credentials: [{ name: 'SHORT_KEY', from: 'resolver' }] }, resolveSecret: async () => 'abc123', root, trace,
    }), (error) => {
      assert.ok(error instanceof RunFailure);
      assert.equal(error.kind, 'credential_denied');
      assert.match(error.message, /SHORT_KEY resolved to a value shorter than 8 characters/);
      assert.equal(error.message.includes('abc123'), false);
      return true;
    });
    assert.deepEqual(events, [{ type: 'credential.denied', data: { name: 'SHORT_KEY', reason: 'too_short' } }]);
    assert.deepEqual(readdirSync(root), [], 'the refused prepare removed its HOME');
    // Positive control: eight characters is enough.
    const ok = await prepareRunEnv({
      grant: { credentials: [{ name: 'SHORT_KEY', from: 'resolver' }] }, resolveSecret: async () => 'abcd1234', root, trace: { emit() {} },
    });
    assert.equal(ok.env.SHORT_KEY, 'abcd1234');
    await ok.cleanup();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const TOKEN = 'cm_agent_runtime-token-5e6f7a8b9c0d';

test('the run\'s runtime token is scrubbed from agent text', () => withStore(async (store, root) => {
  const adapter = {
    name: 'token-echo',
    async spawn(prompt, ctx) {
      ctx.trace.emit('agent.message_chunk', { text: `my token is ${ctx.runtimeToken}.` });
      return {};
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, ctx: { runtimeToken: TOKEN }, policy: FAST });
  assert.equal(out.outcome, 'ok');
  assert.equal(allBytes(root).includes(TOKEN), false, 'the runtime token reached the record');
  assert.equal(storedText(store, out.runId, 'agent.message_chunk'), 'my token is [redacted].');
}));

test('a RunFailure\'s detail is scrubbed of the spawn\'s credentials before settle', () => withStore(async (store) => {
  // A run with no redact hook: only failureData stands between the detail and the line.
  const bare = {
    startRun: (meta) => {
      const { redact, ...run } = store.startRun(meta);
      return run;
    },
  };
  const adapter = { name: 'leaky-failure', async spawn() { throw new RunFailure('exited', `auth failed for ${TOKEN}`); } };
  const out = await superviseRun({ adapter, prompt: 'p', store: bare, ctx: { runtimeToken: TOKEN }, policy: FAST });
  assert.equal(out.outcome, 'failed');
  const [settled] = store.readRun(out.runId).filter((e) => e.kind === 'run.settled');
  assert.deepEqual(settled.data.failure, { kind: 'exited', detail: 'auth failed for [redacted]' });
}));
