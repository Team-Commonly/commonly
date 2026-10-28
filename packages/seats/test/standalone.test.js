import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTraceStore } from '../src/trace/store.js';
import { RunFailure } from '../src/failures.js';
import { verifyRecord } from '../src/record/format.js';
import {
  runStandaloneTurn, standaloneAdapter, defaultTraceDir, traceDirRefusal, cwdRefusal, workTreeOf,
} from '../src/standalone.js';
import { createFakeCliAdapter } from '../test-support/fake-cli-adapter.js';
import { adapterFailure } from '../src/upstream-refusal.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const recordOf = (root, runId) => readFileSync(join(root, 'traces', 'runs', `${runId}.jsonl`), 'utf8');

const withDirs = async (fn) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'seats-standalone-')));
  const cwd = join(root, 'work');
  mkdirSync(cwd);
  try {
    return await fn({ root, cwd, store: createTraceStore({ root: join(root, 'traces') }) });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
};

const adapterOf = (spawn, { found = { path: '/bin/x', version: '1' }, name = 'inproc' } = {}) => ({
  name, detect: async () => found, spawn,
});

test('ok: exit 0, the reply text, and a settle read back from the trace', () => withDirs(async ({ cwd, store }) => {
  const seen = [];
  const run = await runStandaloneTurn({
    adapter: adapterOf(async (prompt, ctx) => { seen.push({ prompt, ctx }); return { text: 'hi', newSessionId: 's1' }; }),
    prompt: 'say hi', store, cwd, timeoutMs: 5000, stallMs: 0,
  });
  assert.equal(run.outcome, 'ok');
  assert.equal(run.exitCode, 0);
  assert.equal(run.kind, null);
  assert.equal(run.text, 'hi');
  assert.equal(run.sessionId, 's1');
  assert.equal(run.settle.outcome, 'ok');
  assert.equal(run.failureLine, undefined);
  assert.equal(seen[0].prompt, 'say hi');
  assert.equal(seen[0].ctx.cwd, cwd);
  // The adapter's own timer sits past the supervisor's, so the supervisor names a timeout.
  assert.ok(seen[0].ctx.timeoutMs > 5000);
}));

test('a CLI that detect() cannot find settles not_installed (22) without spawning', () => withDirs(async ({ root, cwd, store }) => {
  let spawned = false;
  const run = await runStandaloneTurn({
    adapter: adapterOf(async () => { spawned = true; return { text: '' }; }, { found: null, name: 'codex' }),
    prompt: 'x', store, cwd, timeoutMs: 5000, stallMs: 0,
  });
  assert.equal(spawned, false);
  assert.equal(run.outcome, 'failed');
  assert.equal(run.kind, 'not_installed');
  assert.equal(run.exitCode, 22);
  assert.equal(run.settle.failure.kind, 'not_installed');
  assert.equal(run.failureLine, 'jellymoon: not_installed: the agent CLI is not installed, or is not on PATH');
  // The failed run is still a whole, verifiable record.
  const verified = verifyRecord(recordOf(root, run.runId));
  assert.equal(verified.ok, true, JSON.stringify(verified.errors));
}));

test('a bare auth Error is named not_authenticated (23), with the key scrubbed from the detail', () => withDirs(async ({ cwd, store }) => {
  const key = ['sk', 'test', '0123456789abcdef'].join('-'); // a fake key, assembled so no key-shaped literal is committed
  const adapter = {
    ...adapterOf(async () => { throw Object.assign(new Error(`401 Unauthorized for key ${key}`), { status: 401 }); }),
    providerKeyEnv: 'INPROC_KEY',
  };
  const run = await runStandaloneTurn({
    adapter, prompt: 'x', store, cwd, timeoutMs: 5000, stallMs: 0, ctx: { env: { INPROC_KEY: key } },
  });
  assert.equal(run.kind, 'not_authenticated');
  assert.equal(run.exitCode, 23);
  assert.doesNotMatch(JSON.stringify(store.readRun(run.runId)), new RegExp(key));
}));

test('a bare Error that names nothing stays unnamed: exit 1, never a guessed kind', () => withDirs(async ({ cwd, store }) => {
  const run = await runStandaloneTurn({
    adapter: adapterOf(async () => { throw new Error('claude exited with code 1'); }),
    prompt: 'x', store, cwd, timeoutMs: 5000, stallMs: 0,
  });
  assert.equal(run.outcome, 'failed');
  assert.equal(run.kind, null);
  assert.equal(run.exitCode, 1);
  assert.equal(run.failureLine, 'jellymoon: failed: the run failed and its adapter named no failure kind');
}));

test('a RunFailure passes through with its own kind', () => withDirs(async ({ cwd, store }) => {
  const run = await runStandaloneTurn({
    adapter: adapterOf(async () => { throw new RunFailure('provider_unavailable', '503 from upstream'); }),
    prompt: 'x', store, cwd, timeoutMs: 5000, stallMs: 0,
  });
  assert.equal(run.kind, 'provider_unavailable');
  assert.equal(run.exitCode, 17);
}));

test('a turn with no progress is stuck (10); one past its budget is timeout (11)', () => withDirs(async ({ cwd, store }) => {
  const hangs = adapterOf((prompt, ctx) => new Promise((_, reject) => {
    ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
  }));
  const stuck = await runStandaloneTurn({ adapter: hangs, prompt: 'x', store, cwd, timeoutMs: 0, stallMs: 80, cancelGraceMs: 50 });
  assert.equal(stuck.kind, 'stuck');
  assert.equal(stuck.exitCode, 10);
  const late = await runStandaloneTurn({ adapter: hangs, prompt: 'x', store, cwd, timeoutMs: 80, stallMs: 0, cancelGraceMs: 50 });
  assert.equal(late.kind, 'timeout');
  assert.equal(late.exitCode, 11);
}));

test('the caller\'s signal cancels the turn: exit 130', () => withDirs(async ({ cwd, store }) => {
  const controller = new AbortController();
  const hangs = adapterOf((prompt, ctx) => new Promise((_, reject) => {
    ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason), { once: true });
  }));
  setTimeout(() => controller.abort(new RunFailure('cancelled', 'interrupted by SIGINT')), 30);
  const run = await runStandaloneTurn({
    adapter: hangs, prompt: 'x', store, cwd, timeoutMs: 5000, stallMs: 0, cancelGraceMs: 50, signal: controller.signal,
  });
  assert.equal(run.outcome, 'cancelled');
  assert.equal(run.exitCode, 130);
}));

test('a real child process: the fake CLI against the fake provider (ok, refusal)', () => withDirs(async ({ cwd, store }) => {
  const provider = await startFakeProvider();
  try {
    const ctx = { provider: { baseURL: provider.baseURL, model: 'fake-model', apiKey: 'fake-key' } };
    const adapter = createFakeCliAdapter();
    const ok = await runStandaloneTurn({ adapter, prompt: '[[reply:PONG]]', store, cwd, timeoutMs: 20000, stallMs: 0, ctx });
    assert.equal(ok.exitCode, 0);
    assert.equal(ok.text, 'PONG');
    const refused = await runStandaloneTurn({ adapter, prompt: '[[refuse]]', store, cwd, timeoutMs: 20000, stallMs: 0, ctx });
    assert.equal(refused.kind, 'refusal');
    assert.equal(refused.exitCode, 14);
  } finally {
    await provider.close();
  }
}));

test('runStandaloneTurn refuses an adapter without detect()', async () => {
  await assert.rejects(runStandaloneTurn({ adapter: { spawn: async () => ({}) } }), /detect\(\) and spawn\(\)/);
});

test('standaloneAdapter keeps the adapter\'s name and provider key env', () => {
  const wrapped = standaloneAdapter({ name: 'goose', providerKeyEnv: 'K', detect: async () => null, spawn: async () => ({}) });
  assert.equal(wrapped.name, 'goose');
  assert.equal(wrapped.providerKeyEnv, 'K');
});

test('defaultTraceDir is the OS cache dir', () => {
  assert.equal(defaultTraceDir({ platform: 'darwin', home: '/Users/a', env: {} }), '/Users/a/Library/Caches/jellymoon/traces');
  assert.equal(defaultTraceDir({ platform: 'linux', home: '/home/a', env: {} }), '/home/a/.cache/jellymoon/traces');
  assert.equal(defaultTraceDir({ platform: 'linux', home: '/home/a', env: { XDG_CACHE_HOME: '/c' } }), '/c/jellymoon/traces');
  assert.equal(defaultTraceDir({ platform: 'linux', home: '/home/a', env: { XDG_CACHE_HOME: 'relative' } }), '/home/a/.cache/jellymoon/traces');
  assert.match(defaultTraceDir({ platform: 'win32', home: '/h', env: { LOCALAPPDATA: '/L' } }), /jellymoon[\\/]Cache[\\/]traces$/);
});

test('a trace dir inside the repository the agent works in is refused; outside it is not', () => withDirs(async ({ root }) => {
  const repo = join(root, 'repo');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(join(repo, 'src'));
  assert.equal(workTreeOf(join(repo, 'src')), repo);
  assert.match(traceDirRefusal(join(repo, 'traces'), join(repo, 'src')), /inside the repository/);
  assert.match(traceDirRefusal(join(repo, 'not', 'yet', 'made'), repo), /inside the repository/);
  assert.equal(traceDirRefusal(join(root, 'elsewhere'), join(repo, 'src')), null);
  // Outside any git work tree, nothing is refused.
  const plain = join(root, 'plain');
  mkdirSync(plain);
  assert.equal(traceDirRefusal(join(plain, 'traces'), plain), null);
}));

test('cwdRefusal names a missing or non-directory cwd', () => withDirs(async ({ root, cwd }) => {
  assert.equal(cwdRefusal(cwd), null);
  assert.match(cwdRefusal(join(root, 'nope')), /does not exist/);
  const file = join(root, 'file');
  writeFileSync(file, '');
  assert.match(cwdRefusal(file), /not a directory/);
}));

test('a provider status the adapter passed through names the failure, after refusal and auth wording', async () => {
  const cases = [
    ['503: {"error":"overloaded"}', 'provider_unavailable', 17],
    ['429: {"error":"slow down"}', 'provider_unavailable', 17],
    ['408: request timeout', 'provider_unavailable', 17],
    ['400: {"error":"bad tool schema"}', null, 1],
    ['503: this content was flagged for possible cybersecurity risk', 'refusal', 14],
    ['503: invalid api key', 'not_authenticated', 23],
  ];
  for (const [text, kind, exitCode] of cases) {
    await withDirs(async ({ cwd, store }) => {
      const run = await runStandaloneTurn({
        adapter: adapterOf(async () => { throw adapterFailure('opencode turn failed', text); }),
        prompt: 'x', store, cwd, timeoutMs: 5000, stallMs: 0,
      });
      assert.equal(run.kind, kind, text);
      assert.equal(run.exitCode, exitCode, text);
    });
  }
});
