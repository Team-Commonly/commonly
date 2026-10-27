// Real processes against the fake provider: the hang is a genuine HTTP call
// that never answers, in a genuine child, so liveness has to fire on silence
// it did not stage, and the child has to actually die.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { superviseRun } from '../src/supervisor.js';
import { createTraceStore } from '../src/trace/store.js';
import { runFailure } from '../src/failures.js';
import { observeSpawn } from '../src/runtime-observation.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

// Says it is starting (a byte of progress), then waits on a completion the
// fake provider holds open forever.
const CHILD = `
process.stdout.write('requesting\\n');
fetch(process.argv[1] + '/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'fake-model', messages: [{ role: 'user', content: '[[stall]]' }] }),
}).then((r) => r.text()).then((t) => process.stdout.write(t));
`;

const nodeFetchAdapter = ({ honourAbort, children }) => ({
  name: 'node-fetch',
  spawn(prompt, ctx) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['-e', CHILD, ctx.baseURL], { cwd: ctx.cwd, env: ctx.env, stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      observeSpawn(child, ctx.onSpawn, {});
      let out = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      if (honourAbort) ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true });
      child.on('close', (code, signal) => {
        ctx.trace.emit('process.exited', { code, signal });
        if (ctx.signal.aborted) reject(ctx.signal.reason);
        else if (code === 0) resolve({ text: out });
        else reject(runFailure('exited', `node exited ${code ?? signal}`));
      });
    });
  },
});

const isRunning = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
};

const withProvider = async (fn) => {
  const home = mkdtempSync(join(tmpdir(), 'seats-sup-proc-'));
  const fake = await startFakeProvider();
  try {
    return await fn({ fake, home, store: createTraceStore({ root: join(home, 'trace') }) });
  } finally {
    await fake.close();
    rmSync(home, { recursive: true, force: true });
  }
};

const settleChild = async (child) => {
  if (child.exitCode === null && child.signalCode === null) {
    let timer;
    await Promise.race([once(child, 'exit'), new Promise((r) => { timer = setTimeout(r, 3000); })]);
    clearTimeout(timer);
  }
};

for (const honourAbort of [false, true]) {
  test(`a real child hung on a stalled HTTP call is caught and killed (adapter ${honourAbort ? 'honours' : 'ignores'} abort)`, () => withProvider(async ({ fake, home, store }) => {
    const children = [];
    const ctx = { baseURL: fake.baseURL, cwd: home, env: { PATH: process.env.PATH, HOME: home } };
    const started = Date.now();
    const out = await superviseRun({
      adapter: nodeFetchAdapter({ honourAbort, children }), prompt: 'p', ctx, store,
      policy: { stallMs: 400, cancelGraceMs: 400, timeoutMs: 10000 },
    });
    const elapsed = Date.now() - started;

    assert.equal(out.outcome, 'stuck');
    assert.equal(out.failure.kind, 'stuck');
    assert.ok(elapsed < 3000, `settled in ${elapsed}ms`);
    assert.deepEqual(fake.requests.map((r) => r.directive), ['stall'], 'the child really made the call that hung');

    assert.equal(children.length, 1);
    const [child] = children;
    await settleChild(child);
    assert.ok(child.signalCode, `the child was killed by a signal (exit ${child.exitCode}, signal ${child.signalCode})`);
    assert.equal(isRunning(child.pid), false, `pid ${child.pid} is gone`);

    const types = store.readRun(out.runId).map((e) => (e.type === 'liveness.recovery' ? `recovery:${e.data.action}` : e.type));
    if (honourAbort) {
      assert.equal(child.signalCode, 'SIGTERM');
      assert.equal(out.failure.adapterIgnoredCancel, undefined);
      assert.deepEqual(types, ['run.started', 'liveness.stalled', 'recovery:cancel', 'process.exited', 'run.settled']);
    } else {
      // Nobody but the supervisor stopped it: the kill came from the handle onSpawn gave it.
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(out.failure.adapterIgnoredCancel, true);
      assert.deepEqual(types, ['run.started', 'liveness.stalled', 'recovery:cancel', 'recovery:kill', 'run.settled']);
    }
  }));
}
