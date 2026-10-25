import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseRun, SUPERVISOR_DEFAULTS, DEFAULT_RETRY_ON } from '../src/supervisor.js';
import * as seats from '../src/index.js';
import { createTraceStore } from '../src/trace/store.js';
import { RunFailure, runFailure } from '../src/failures.js';
import { observeSpawn } from '../src/runtime-observation.js';

// Small windows instead of a fake clock: every timer here is real, so the
// supervisor is exercised exactly as it runs, just in milliseconds.
const FAST = { stallMs: 60, cancelGraceMs: 60, timeoutMs: 0 };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withStore = async (fn) => {
  const root = mkdtempSync(join(tmpdir(), 'seats-sup-'));
  try { return await fn(createTraceStore({ root })); } finally { rmSync(root, { recursive: true, force: true }); }
};
const typesOf = (store, runId) => store.readRun(runId).map((e) => (
  e.type === 'liveness.recovery' ? `recovery:${e.data.action}` : e.type));
const settledOf = (store, runId) => store.readRun(runId).filter((e) => e.type === 'run.settled');

/** Hangs until aborted, then rejects with the signal's reason, as the seam asks. */
const hangsHonouringAbort = (calls = []) => ({
  name: 'hang-honour',
  spawn(prompt, ctx) {
    calls.push(ctx);
    return new Promise((_, reject) => {
      ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
    });
  },
});

/** A fake child: an EventEmitter with stdout/stderr and a kill that records. */
const fakeChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    child.signalCode = signal;
    setImmediate(() => child.emit('exit', null, signal));
    return true;
  };
  return child;
};

test('defaults are the documented windows and retry is off', () => {
  assert.deepEqual({ ...SUPERVISOR_DEFAULTS }, { stallMs: 120000, cancelGraceMs: 10000, timeoutMs: 900000 });
  assert.deepEqual([...DEFAULT_RETRY_ON], ['stuck', 'exited', 'timeout']);
  assert.equal(seats.superviseRun, superviseRun);
});

test('a successful run: started, the adapter\'s events, settled ok — in that order', () => withStore(async (store) => {
  const adapter = {
    name: 'ok',
    async spawn(prompt, ctx) {
      ctx.trace.emit('turn.prompt_sent', { chars: prompt.length });
      ctx.trace.emit('agent.message_chunk', { text: 'PONG' });
      return { text: 'PONG', newSessionId: 's-1' };
    },
  };
  const out = await superviseRun({ adapter, prompt: 'ping', store, policy: FAST });
  assert.equal(out.outcome, 'ok');
  assert.deepEqual(out.result, { text: 'PONG', newSessionId: 's-1' });
  assert.equal(out.failure, undefined);
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'turn.prompt_sent', 'agent.message_chunk', 'run.settled']);
  const [settled] = settledOf(store, out.runId);
  assert.equal(settled.data.outcome, 'ok');
  assert.equal(settled.data.attempts, 1);
  assert.equal(typeof settled.data.durationMs, 'number');
  assert.equal(store.listRuns()[0].outcome, 'ok');
}));

test('a hung adapter that honours abort settles stuck, with the reason on its signal', () => withStore(async (store) => {
  const calls = [];
  const stalled = [];
  const out = await superviseRun({
    adapter: hangsHonouringAbort(calls), prompt: 'p', store,
    policy: { ...FAST, cancelGraceMs: 2000, onStalled: (info) => stalled.push(info) },
  });
  assert.equal(out.outcome, 'stuck');
  assert.ok(out.failure instanceof RunFailure);
  assert.equal(out.failure.kind, 'stuck');
  assert.equal(out.failure.adapterIgnoredCancel, undefined);
  assert.equal(calls[0].signal.reason.kind, 'stuck', 'the adapter sees a RunFailure as the abort reason');
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'liveness.stalled', 'recovery:cancel', 'run.settled']);
  const events = store.readRun(out.runId);
  const stall = events.find((e) => e.type === 'liveness.stalled').data;
  assert.equal(stall.windowMs, 60);
  assert.ok(stall.idleMs >= 60, `idleMs ${stall.idleMs} is at least the window`);
  assert.deepEqual(events.find((e) => e.type === 'liveness.recovery').data, { action: 'cancel', attempt: 1 });
  assert.equal(settledOf(store, out.runId)[0].data.failure.kind, 'stuck');
  assert.equal(stalled.length, 1);
  assert.equal(stalled[0].runId, out.runId);
  assert.equal(stalled[0].attempt, 1);
}));

test('a hung adapter that IGNORES abort still settles stuck, records kill, and kills its child', () => withStore(async (store) => {
  const child = fakeChild();
  const adapter = {
    name: 'hang-ignore',
    spawn(prompt, ctx) {
      ctx.onSpawn({ model: null, effort: null, at: 'x' }, child);
      return new Promise(() => {}); // never settles, never looks at the signal
    },
  };
  const started = Date.now();
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: FAST });
  const elapsed = Date.now() - started;
  assert.equal(out.outcome, 'stuck');
  assert.equal(out.failure.kind, 'stuck');
  assert.equal(out.failure.adapterIgnoredCancel, true);
  assert.match(out.failure.detail, /did not settle within 60ms of cancellation/);
  assert.deepEqual(child.kills, ['SIGKILL']);
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'liveness.stalled', 'recovery:cancel', 'recovery:kill', 'run.settled']);
  assert.ok(elapsed < 1000, `settled in ${elapsed}ms, not left running`);
}));

test('an ignored cancellation is not retried even when the kind is listed', () => withStore(async (store) => {
  let calls = 0;
  const adapter = { name: 'hang-ignore', spawn() { calls += 1; return new Promise(() => {}); } };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { ...FAST, retry: { max: 2 } } });
  assert.equal(out.outcome, 'stuck');
  assert.equal(calls, 1, 'a second attempt could race the first, which may still be running');
}));

test('steady trace progress is never called stuck', () => withStore(async (store) => {
  const adapter = {
    name: 'steady',
    async spawn(prompt, ctx) {
      for (let i = 0; i < 15; i += 1) { // 300ms of work against a 60ms window
        await delay(20);
        ctx.trace.emit('agent.thought_chunk', { chars: 1 });
      }
      return { text: 'done' };
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: FAST });
  assert.equal(out.outcome, 'ok');
  assert.ok(!typesOf(store, out.runId).some((t) => t.startsWith('liveness') || t.startsWith('recovery')));
}));

test('child stdout/stderr bytes count as progress, and the caller\'s onSpawn still receives every argument', () => withStore(async (store) => {
  const seen = [];
  const adapter = {
    name: 'bytes',
    async spawn(prompt, ctx) {
      const child = fakeChild();
      observeSpawn(child, ctx.onSpawn, { model: 'm' });
      child.emit('spawn');
      for (let i = 0; i < 15; i += 1) {
        await delay(20);
        (i % 2 ? child.stdout : child.stderr).emit('data', Buffer.from('.'));
      }
      return { text: 'done' };
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, ctx: { onSpawn: (...args) => seen.push(args) }, policy: FAST });
  assert.equal(out.outcome, 'ok');
  assert.equal(seen.length, 1);
  assert.equal(seen[0][0].model, 'm');
  assert.equal(typeof seen[0][1].kill, 'function', 'observeSpawn passes the child as the second argument');
  assert.ok(!typesOf(store, out.runId).includes('liveness.stalled'));
}));

test('progress that stops part-way is caught, and idleMs is measured from the last signal', () => withStore(async (store) => {
  const adapter = {
    name: 'stops',
    spawn(prompt, ctx) {
      return new Promise((_, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        (async () => { for (let i = 0; i < 5; i += 1) { await delay(20); ctx.trace.emit('agent.thought_chunk', { chars: 1 }); } })();
      });
    },
  };
  const started = Date.now();
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: FAST });
  assert.equal(out.outcome, 'stuck');
  const stall = store.readRun(out.runId).find((e) => e.type === 'liveness.stalled').data;
  assert.ok(stall.idleMs >= 60 && stall.idleMs < 200, `idleMs ${stall.idleMs}`);
  assert.ok(Date.now() - started >= 160, 'the window restarted on each signal');
}));

test('a refusal is never retried, even when listed in retry.on', () => withStore(async (store) => {
  let calls = 0;
  const adapter = { name: 'refuses', async spawn() { calls += 1; throw runFailure('refusal', 'content policy'); } };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { ...FAST, retry: { max: 3, on: ['refusal', 'stuck'] } } });
  assert.equal(calls, 1);
  assert.equal(out.outcome, 'failed');
  assert.equal(out.attempts, 1);
  assert.equal(out.failure.kind, 'refusal');
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'run.settled']);
  assert.deepEqual(settledOf(store, out.runId)[0].data.failure, { kind: 'refusal', detail: 'content policy' });
}));

test('stuck is retried once on the same runId, carrying the session, then succeeds', () => withStore(async (store) => {
  const calls = [];
  const adapter = {
    name: 'flaky',
    spawn(prompt, ctx) {
      calls.push({ sessionId: ctx.sessionId });
      if (calls.length === 2) return Promise.resolve({ text: 'second time', newSessionId: 'sess-1' });
      return new Promise((_, reject) => {
        ctx.signal.addEventListener('abort', () => {
          const failure = ctx.signal.reason;
          failure.sessionId = 'sess-1'; // the adapter knew its session when it failed
          reject(failure);
        });
      });
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { ...FAST, retry: { max: 1 } } });
  assert.equal(out.outcome, 'ok');
  assert.equal(out.attempts, 2);
  assert.equal(out.result.text, 'second time');
  assert.deepEqual(calls, [{ sessionId: undefined }, { sessionId: 'sess-1' }]);
  assert.deepEqual(typesOf(store, out.runId), [
    'run.started', 'liveness.stalled', 'recovery:cancel', 'recovery:retry', 'run.started', 'run.settled']);
  const starts = store.readRun(out.runId).filter((e) => e.type === 'run.started').map((e) => e.data);
  assert.deepEqual(starts, [{ adapter: 'flaky', attempt: 1 }, { adapter: 'flaky', sessionId: 'sess-1', attempt: 2 }]);
  assert.equal(settledOf(store, out.runId)[0].data.attempts, 2);
  assert.equal(store.listRuns().length, 1, 'a retry is the same run, not a new one');
}));

test('retry is off by default: a stuck run is attempted once', () => withStore(async (store) => {
  const calls = [];
  const out = await superviseRun({ adapter: hangsHonouringAbort(calls), prompt: 'p', store, policy: { ...FAST, cancelGraceMs: 1000 } });
  assert.equal(out.outcome, 'stuck');
  assert.equal(calls.length, 1);
}));

test('retry stops at max and settles with the last failure', () => withStore(async (store) => {
  const calls = [];
  const out = await superviseRun({ adapter: hangsHonouringAbort(calls), prompt: 'p', store, policy: { ...FAST, cancelGraceMs: 1000, retry: { max: 2 } } });
  assert.equal(calls.length, 3);
  assert.equal(out.attempts, 3);
  assert.equal(out.outcome, 'stuck');
  assert.equal(settledOf(store, out.runId).length, 1);
}));

test('a kind left out of retry.on is not retried', () => withStore(async (store) => {
  let calls = 0;
  const adapter = { name: 'exits', async spawn() { calls += 1; throw runFailure('exited', 'code 1'); } };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { ...FAST, retry: { max: 2, on: ['stuck'] } } });
  assert.equal(calls, 1);
  assert.equal(out.outcome, 'failed');
}));

test('the wall-clock timeout cancels a busy run with kind timeout, not stuck', () => withStore(async (store) => {
  const adapter = {
    name: 'busy',
    spawn(prompt, ctx) {
      return new Promise((_, reject) => {
        const tick = setInterval(() => ctx.trace.emit('agent.thought_chunk', { chars: 1 }), 10);
        ctx.signal.addEventListener('abort', () => { clearInterval(tick); reject(ctx.signal.reason); });
      });
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { stallMs: 1000, cancelGraceMs: 1000, timeoutMs: 120 } });
  assert.equal(out.outcome, 'failed');
  assert.equal(out.failure.kind, 'timeout');
  const types = typesOf(store, out.runId);
  assert.ok(!types.includes('liveness.stalled'));
  assert.deepEqual(types.filter((t) => !t.startsWith('agent.')), ['run.started', 'recovery:cancel', 'run.settled']);
  assert.equal(settledOf(store, out.runId)[0].data.failure.kind, 'timeout');
}));

test('a timeout the adapter ignores still settles as timeout', () => withStore(async (store) => {
  const adapter = { name: 'deaf', spawn: () => new Promise(() => {}) };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { stallMs: 0, cancelGraceMs: 40, timeoutMs: 60 } });
  assert.equal(out.failure.kind, 'timeout');
  assert.equal(out.failure.adapterIgnoredCancel, true);
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'recovery:cancel', 'recovery:kill', 'run.settled']);
}));

test('a caller\'s signal cancels the run as cancelled, and a pre-aborted signal never spawns', () => withStore(async (store) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 30);
  const out = await superviseRun({ adapter: hangsHonouringAbort(), prompt: 'p', store, ctx: { signal: controller.signal }, policy: { ...FAST, stallMs: 1000, retry: { max: 3 } } });
  assert.equal(out.outcome, 'cancelled');
  assert.equal(out.failure.kind, 'cancelled');
  assert.equal(out.attempts, 1);
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'run.settled']);

  let spawned = 0;
  const out2 = await superviseRun({ adapter: { name: 'x', spawn: () => { spawned += 1; return {}; } }, prompt: 'p', store, ctx: { signal: AbortSignal.abort() }, policy: FAST });
  assert.equal(out2.outcome, 'cancelled');
  assert.equal(spawned, 0);
}));

test('a bare Error settles failed with no kind, scrubbed, and does not throw', () => withStore(async (store) => {
  const key = 'sk-or-v1-abcdefabcdefabcdef';
  const adapter = { name: 'bare', providerKeyEnv: 'OPENROUTER_API_KEY', spawn() { throw new Error(`exploded with ${key}`); } };
  const out = await superviseRun({ adapter, prompt: 'p', store, ctx: { env: { OPENROUTER_API_KEY: key } }, policy: FAST });
  assert.equal(out.outcome, 'failed');
  const { failure } = settledOf(store, out.runId)[0].data;
  assert.equal(failure.kind, null);
  assert.doesNotMatch(failure.detail, /abcdefabcdef/);
  assert.match(failure.detail, /exploded with \[redacted\]/);
}));

test('an adapter cannot write the supervisor\'s run.* events', () => withStore(async (store) => {
  const adapter = {
    name: 'forger',
    async spawn(prompt, ctx) {
      assert.equal(ctx.trace.emit('run.settled', { outcome: 'ok', durationMs: 0, attempts: 1 }), null);
      assert.equal(ctx.trace.emit('run.started', { attempt: 9 }), null);
      throw runFailure('exited', 'code 2');
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: FAST });
  assert.equal(out.outcome, 'failed');
  assert.deepEqual(typesOf(store, out.runId), ['run.started', 'run.settled']);
}));

test('exactly one run.settled on every path, and a late adapter answer writes nothing', () => withStore(async (store) => {
  const lateHook = [];
  const late = {
    name: 'late',
    spawn(prompt, ctx) {
      // Ignores the abort, then answers after the supervisor gave up on it.
      return new Promise((resolve) => setTimeout(() => {
        lateHook.push(ctx.trace.emit('agent.message_chunk', { text: 'too late' }));
        resolve({ text: 'too late' });
      }, 250));
    },
  };
  const paths = [
    { adapter: { name: 'ok', spawn: async () => ({ text: 'x' }) }, outcome: 'ok' },
    { adapter: hangsHonouringAbort(), outcome: 'stuck' },
    { adapter: { name: 'deaf', spawn: () => new Promise(() => {}) }, outcome: 'stuck' },
    { adapter: late, outcome: 'stuck' },
    { adapter: { name: 'refuse', spawn: async () => { throw runFailure('refusal', 'no'); } }, outcome: 'failed', policy: { retry: { max: 2, on: ['refusal'] } } },
    { adapter: hangsHonouringAbort(), outcome: 'stuck', policy: { retry: { max: 1 } } },
    { adapter: { name: 'deaf', spawn: () => new Promise(() => {}) }, outcome: 'failed', policy: { stallMs: 0, timeoutMs: 50 } },
    { adapter: { name: 'bare', spawn: () => { throw new Error('boom'); } }, outcome: 'failed' },
  ];
  const runIds = [];
  for (const path of paths) {
    const out = await superviseRun({ adapter: path.adapter, prompt: 'p', store, policy: { ...FAST, ...path.policy } });
    assert.equal(out.outcome, path.outcome, path.adapter.name);
    runIds.push(out.runId);
  }
  await delay(300); // let the late adapter answer
  assert.deepEqual(lateHook, [null], 'the late trace write was dropped');
  for (const runId of runIds) {
    assert.equal(settledOf(store, runId).length, 1, runId);
    assert.equal(store.readRun(runId).at(-1).type, 'run.settled', 'nothing follows the settle');
  }
  assert.ok(store.listRuns({ limit: 100 }).every((row) => row.outcome !== 'running'));
}));

test('an adapter that answers after the supervisor aborted it still settles with the abort reason', () => withStore(async (store) => {
  const adapter = {
    name: 'answers-anyway',
    spawn(prompt, ctx) {
      return new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => resolve({ text: 'a reply nobody waited for' }));
      });
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { ...FAST, cancelGraceMs: 1000 } });
  assert.equal(out.outcome, 'stuck');
  assert.equal(out.result, undefined);
  assert.equal(settledOf(store, out.runId)[0].data.outcome, 'stuck');
}));

test('a cancelled attempt\'s late trace writes never reach the next attempt', () => withStore(async (store) => {
  let calls = 0;
  const adapter = {
    name: 'stray',
    spawn(prompt, ctx) {
      calls += 1;
      if (calls === 2) return delay(100).then(() => ({ text: 'ok' }));
      return new Promise((_, reject) => {
        ctx.signal.addEventListener('abort', () => {
          reject(ctx.signal.reason);
          setTimeout(() => ctx.trace.emit('agent.message_chunk', { text: 'stale' }), 30);
        });
      });
    },
  };
  const out = await superviseRun({ adapter, prompt: 'p', store, policy: { ...FAST, stallMs: 200, retry: { max: 1 } } });
  assert.equal(out.outcome, 'ok');
  assert.equal(out.attempts, 2);
  assert.ok(!store.readRun(out.runId).some((e) => e.data?.text === 'stale'));
}));
