/**
 * Real-binary ACP turns against the local fake provider. Each test runs only
 * when its binary exists; nothing here reaches a hosted model or uses a real
 * key. Override the paths with SEATS_GOOSE_BIN / SEATS_OPENCODE_BIN.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acpGoose, acpOpencode, createAcpGooseAdapter, createAcpOpencodeAdapter,
} from '../src/adapters/acp-launch.js';
import { RunFailure } from '../src/failures.js';
import { startFakeProvider } from '../test-support/fake-provider.js';
import { recordTrace } from '../test-support/record-trace.js';
import { after } from 'node:test';

const GOOSE = process.env.SEATS_GOOSE_BIN || join(homedir(), '.commonly', 'goose-1.54.0', 'goose');
const OPENCODE = process.env.SEATS_OPENCODE_BIN
  || join(homedir(), '.commonly', 'opencode-1.19.0', 'node_modules', 'opencode-darwin-arm64', 'bin', 'opencode');
const KEY = 'sk-fake-not-a-real-key-0001';

/**
 * A pass-through in front of the fake provider that remembers how many
 * messages each chat request carried, which is how a resumed turn shows it
 * brought the earlier turn along.
 */
const startRecorder = async (upstream) => {
  const bodies = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      try { bodies.push(JSON.parse(raw || '{}')); } catch { bodies.push({}); }
      try {
        const answer = await fetch(`${upstream.baseURL}${req.url.replace(/^\/v1/, '')}`, {
          method: req.method,
          headers: {
            'content-type': 'application/json',
            ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          },
          body: req.method === 'POST' ? raw : undefined,
        });
        res.writeHead(answer.status, { 'content-type': answer.headers.get('content-type') || 'application/json' });
        res.end(Buffer.from(await answer.arrayBuffer()));
      } catch {
        res.destroy(); // a held [[stall]] request ends when the fake provider closes
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    baseURL: `http://127.0.0.1:${server.address().port}/v1`,
    bodies,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
};

const withProvider = async (fn) => {
  const fake = await startFakeProvider();
  const recorder = await startRecorder(fake);
  const root = mkdtempSync(join(tmpdir(), 'seats-acp-real-'));
  const home = join(root, 'home');
  const cwd = join(root, 'ws');
  mkdirSync(home);
  mkdirSync(cwd);
  try {
    await fn({ fake, recorder, home, cwd });
  } finally {
    await recorder.close();
    await fake.close();
    rmSync(root, { recursive: true, force: true });
  }
};

// Every run writes a real record-v1 store, so a real agent's stream meets the
// strict writer: an entry the record would refuse fails the test.
const STORE_ROOT = mkdtempSync(join(tmpdir(), 'seats-acp-real-store-'));
const records = [];

const runCtx = ({ binary, recorder, home, cwd, events, ...extra }) => {
  const record = recordTrace({ root: STORE_ROOT, secrets: [KEY] });
  records.push(record);
  return {
  _binaryPath: binary,
  cwd,
  env: { PATH: '/usr/bin:/bin', HOME: home },
  provider: { baseURL: recorder.baseURL, apiKey: KEY, model: 'fake-model' },
  trace: { emit: (type, data) => { record.trace.emit(type, data); events.push({ type, data }); } },
  timeoutMs: 120000,
  ...extra,
  };
};

after(() => {
  try {
    for (const record of records) assert.equal(record.verify()?.ok, true, 'every real run left a verifiable record');
  } finally { rmSync(STORE_ROOT, { recursive: true, force: true }); }
});

const chatRequests = (recorder) => recorder.bodies.filter((body) => Array.isArray(body.messages));
const userMessages = (body) => body.messages.filter((m) => m.role === 'user').length;

test('goose acp: one real turn against the fake provider', { skip: !existsSync(GOOSE) && `no goose at ${GOOSE}` }, async () => {
  await withProvider(async ({ fake, recorder, home, cwd }) => {
    const events = [];
    const result = await acpGoose.spawn('Reply with exactly PONG.', runCtx({ binary: GOOSE, recorder, home, cwd, events }));
    assert.equal(result.text, 'PONG');
    assert.ok(result.newSessionId);
    const types = events.map((e) => e.type);
    for (const type of ['session.opened', 'turn.prompt_sent', 'agent.message_chunk', 'usage', 'process.exited']) {
      assert.ok(types.includes(type), `trace has ${type}: ${types}`);
    }
    assert.equal(types.at(-1), 'process.exited');
    assert.ok(fake.requests.length >= 1, 'the fake provider saw the turn');
    assert.ok(fake.requests.every((r) => r.model === 'fake-model' && r.authorization === 'present'));

    // goose keeps sessions under HOME, so a second spawn can reopen it.
    const again = [];
    const second = await acpGoose.spawn('Reply with exactly PONG.', runCtx({
      binary: GOOSE, recorder, home, cwd, events: again, sessionId: result.newSessionId,
    }));
    assert.equal(second.text, 'PONG', 'the history goose replays on load is not part of the reply');
    assert.deepEqual(again[0].data, { method: 'load', sessionId: result.newSessionId });
    assert.equal(userMessages(chatRequests(recorder).at(-1)), 2, 'the loaded turn carried the first turn');
  });
});

test('opencode acp: one real turn, then a resumed second turn', { skip: !existsSync(OPENCODE) && `no opencode at ${OPENCODE}` }, async () => {
  await withProvider(async ({ fake, recorder, home, cwd }) => {
    const events = [];
    const result = await acpOpencode.spawn('Reply with exactly PONG.', runCtx({ binary: OPENCODE, recorder, home, cwd, events }));
    assert.equal(result.text, 'PONG');
    assert.match(result.newSessionId, /^ses_/);
    const types = events.map((e) => e.type);
    for (const type of ['session.opened', 'turn.prompt_sent', 'agent.message_chunk', 'usage', 'process.exited']) {
      assert.ok(types.includes(type), `trace has ${type}: ${types}`);
    }
    assert.ok(fake.requests.length >= 1, 'the fake provider saw the turn');
    assert.ok(fake.requests.every((r) => r.model === 'fake-model' && r.authorization === 'present'),
      'every request went to the fake model, none to the hosted default');

    const again = [];
    const second = await acpOpencode.spawn('Reply with exactly PONG again.', runCtx({
      binary: OPENCODE, recorder, home, cwd, events: again, sessionId: result.newSessionId,
    }));
    assert.equal(second.text, 'PONG');
    assert.equal(second.newSessionId, result.newSessionId);
    assert.deepEqual(again[0].data, { method: 'resume', sessionId: result.newSessionId });
    const turn = chatRequests(recorder).filter((body) => body.messages.some((m) => JSON.stringify(m.content).includes('PONG again')));
    assert.ok(turn.length >= 1);
    assert.equal(userMessages(turn.at(-1)), 2, 'the resumed turn carried the first turn');
  });
});

/**
 * Measured 2026-10-25 with no watch: goose 1.54.0 sends a refused request 8
 * times over ~8.6 s and a 503 8 times over ~10.8 s before it says anything;
 * opencode 1.19.0 retries a 503 with backoff until the run's own timeout. The
 * provider watch ends each at the first failing answer. Time is measured from
 * the provider's first request, so CLI start-up on a loaded host stays out of
 * the "fast" claim.
 */
const wireFailure = async ({ adapter, binary, prompt }) => {
  let outcome;
  await withProvider(async ({ fake, recorder, home, cwd }) => {
    const events = [];
    let firstAt = null;
    const poll = setInterval(() => { if (firstAt === null && fake.requests.length) firstAt = Date.now(); }, 5);
    const error = await adapter.spawn(prompt, runCtx({ binary, recorder, home, cwd, events }))
      .then(() => null, (failure) => failure);
    clearInterval(poll);
    outcome = {
      error, events, afterFirstMs: Date.now() - (firstAt ?? Date.now()), requests: fake.requests.map((r) => r.directive),
    };
  });
  return outcome;
};

const assertStoppedAtFirst = ({ error, events, afterFirstMs, requests }, kind, directive) => {
  assert.ok(error instanceof RunFailure, `expected a RunFailure, got ${error}`);
  assert.equal(error.kind, kind, error.message);
  assert.ok(!error.message.includes(KEY));
  // Up to two failing requests: both CLIs open the turn with two concurrent
  // calls, so the second can already be on the wire when the first answers.
  const failing = requests.filter((r) => r === directive).length;
  assert.ok(failing >= 1 && failing <= 2, `the provider saw ${failing} ${directive} requests`);
  assert.ok(afterFirstMs < 5000, `settled ${afterFirstMs}ms after the first provider request`);
  assert.equal(events.at(-1).type, 'process.exited');
};

test('goose acp: the first provider refusal ends the run as refusal_retry_loop', { skip: !existsSync(GOOSE) && `no goose at ${GOOSE}` }, async () => {
  const outcome = await wireFailure({ adapter: acpGoose, binary: GOOSE, prompt: '[[refuse]]' });
  assertStoppedAtFirst(outcome, 'refusal_retry_loop', 'refuse');
  assert.match(outcome.error.message, /content policy/);
});

test('goose acp: the first provider 503 ends the run as provider_unavailable', { skip: !existsSync(GOOSE) && `no goose at ${GOOSE}` }, async () => {
  assertStoppedAtFirst(await wireFailure({ adapter: acpGoose, binary: GOOSE, prompt: '[[fail:503]]' }), 'provider_unavailable', 'fail');
});

test('opencode acp: the first provider refusal ends the run as refusal_retry_loop', { skip: !existsSync(OPENCODE) && `no opencode at ${OPENCODE}` }, async () => {
  assertStoppedAtFirst(await wireFailure({ adapter: acpOpencode, binary: OPENCODE, prompt: '[[refuse]]' }), 'refusal_retry_loop', 'refuse');
});

test('opencode acp: the first provider 503 ends the run as provider_unavailable, not at a timeout', { skip: !existsSync(OPENCODE) && `no opencode at ${OPENCODE}` }, async () => {
  assertStoppedAtFirst(await wireFailure({ adapter: acpOpencode, binary: OPENCODE, prompt: '[[fail:503]]' }), 'provider_unavailable', 'fail');
});

// With the watch off, what each CLI itself reports is still read correctly.
test('goose acp, watch off: the refusal goose ends its turn with is a refusal, not a reply', { skip: !existsSync(GOOSE) && `no goose at ${GOOSE}` }, async () => {
  await withProvider(async ({ recorder, home, cwd }) => {
    const error = await createAcpGooseAdapter({ watchProvider: false })
      .spawn('[[refuse]]', runCtx({ binary: GOOSE, recorder, home, cwd, events: [] }))
      .then(() => null, (failure) => failure);
    assert.ok(error instanceof RunFailure);
    assert.equal(error.kind, 'refusal');
    assert.match(error.message, /content policy/);
  });
});

test('opencode acp, watch off: its -32603 content-policy error is a refusal', { skip: !existsSync(OPENCODE) && `no opencode at ${OPENCODE}` }, async () => {
  await withProvider(async ({ recorder, home, cwd }) => {
    const error = await createAcpOpencodeAdapter({ watchProvider: false })
      .spawn('[[refuse]]', runCtx({ binary: OPENCODE, recorder, home, cwd, events: [] }))
      .then(() => null, (failure) => failure);
    assert.ok(error instanceof RunFailure);
    assert.equal(error.kind, 'refusal');
  });
});

// Measured 2026-10-25: opencode 1.19.0 answers session/cancel with
// stopReason cancelled at once; goose 1.54.0 does not answer it while its
// provider request is held, so the cancel grace runs out and it is killed.
const abortAfterStall = async ({ adapter, binary }) => {
  let outcome;
  await withProvider(async ({ fake, recorder, home, cwd }) => {
    const events = [];
    const controller = new AbortController();
    const run = adapter.spawn('[[stall]]', runCtx({ binary, recorder, home, cwd, events, signal: controller.signal }));
    const deadline = Date.now() + 60000;
    while (!fake.requests.some((r) => r.directive === 'stall') && Date.now() < deadline) {
      await new Promise((resolve) => { setTimeout(resolve, 50); });
    }
    const abortedAt = Date.now();
    controller.abort();
    const error = await run.then(() => null, (failure) => failure);
    outcome = { error, events, settleMs: Date.now() - abortedAt };
  });
  return outcome;
};

test('opencode acp: abort mid-turn is answered by the agent within the cancel grace', { skip: !existsSync(OPENCODE) && `no opencode at ${OPENCODE}` }, async () => {
  const { error, events, settleMs } = await abortAfterStall({ adapter: acpOpencode, binary: OPENCODE });
  assert.equal(error?.kind, 'cancelled');
  // Ignoring the cancel would cost the full 3000 ms grace before the kill even starts.
  assert.ok(settleMs < 3000, `settled ${settleMs}ms after abort, inside the 3000ms cancel grace`);
  assert.equal(events.at(-1).type, 'process.exited');
});

test('goose acp: abort mid-turn still ends the run when the agent never answers the cancel', { skip: !existsSync(GOOSE) && `no goose at ${GOOSE}` }, async () => {
  const { error, events } = await abortAfterStall({ adapter: acpGoose, binary: GOOSE });
  assert.equal(error?.kind, 'cancelled');
  assert.deepEqual(events.at(-1), { type: 'process.exited', data: { code: null, signal: 'SIGTERM' } });
});
