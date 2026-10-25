import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS, runCheck } from '../compat/checks.js';
import { createHarness, watchArgv } from '../compat/harness.js';
import {
  isLimitRow, limitOf, loadTargets, runMatrix, runTarget, totalsOf, writeOutputs, RESULTS_SCHEMA,
} from '../compat/run.js';
import { installDirOf, PACKAGE_ROOT } from '../compat/targets.js';
import { runFailure } from '../src/failures.js';
import { startFakeProvider } from '../test-support/fake-provider.js';

const FAST = { turnMs: 5000, stallMs: 600, graceMs: 1500, checkMs: 8000 };
const fakeCli = (extra = {}) => ({ cli: 'fake-cli', version: '1.0.0', adapter: 'test-support/fake-cli-adapter.js#default', enabled: true, ...extra });
const variant = (fault, extra = {}) => fakeCli({
  cli: `fake-cli-${fault}`, adapter: 'test-support/fake-cli-adapter.js#createFakeCliAdapter', options: { fault }, ...extra,
});
const failing = (rows, label) => rows.filter((r) => r.target === label && r.status === 'fail').map((r) => r.check).sort();
const withTmp = async (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'seats-compat-test-'));
  try { return await fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('stub and fake-cli produce a schema-versioned results.json with every check accounted for', () => withTmp(async (out) => {
  const targets = [
    { cli: 'stub', version: '0.0.0', adapter: 'src/adapters/stub.js#default', enabled: true },
    fakeCli(),
  ];
  const results = await runMatrix(targets, { timeouts: FAST });
  const { json, html } = writeOutputs(results, out);
  const written = JSON.parse(readFileSync(json, 'utf8'));
  assert.equal(written.schema, RESULTS_SCHEMA);
  assert.ok(Date.parse(written.generatedAt));
  assert.deepEqual(Object.keys(written.host).sort(), ['arch', 'node', 'os', 'platform']);
  assert.equal(written.rows.length, targets.length * CHECKS.length);
  for (const target of ['stub@0.0.0', 'fake-cli@1.0.0']) {
    assert.deepEqual(written.rows.filter((r) => r.target === target).map((r) => r.check), CHECKS.map((c) => c.id));
  }
  for (const row of written.rows) assert.ok(['pass', 'fail', 'skip'].includes(row.status), `${row.target} ${row.check}`);
  assert.deepEqual(failing(written.rows, 'fake-cli@1.0.0'), [], JSON.stringify(written.rows.filter((r) => r.status !== 'pass' && r.target === 'fake-cli@1.0.0')));
  // fake-cli declares no probeOptions, so only the agent-level probes skip.
  const skipped = written.rows.filter((r) => r.target === 'fake-cli@1.0.0' && r.status === 'skip');
  assert.deepEqual(skipped.map((r) => r.check), ['retry-status', 'retry-status-surfaced']);
  assert.ok(skipped.every((r) => /declares no probeOptions/.test(r.detail)), JSON.stringify(skipped));
  assert.deepEqual(written.totals, { pass: written.rows.filter((r) => r.status === 'pass').length, fail: 5, skip: written.rows.filter((r) => r.status === 'skip').length, limit: 0 });
  // The stub never calls a provider, so the suite must say so rather than pass it.
  assert.deepEqual(failing(written.rows, 'stub@0.0.0'), ['exact-reply', 'fresh-turn', 'provider-5xx', 'refusal', 'stall']);
  assert.match(readFileSync(html, 'utf8'), /fake-cli@1\.0\.0/);
  assert.equal(results.provider, undefined, 'the results document carries no provider key');
  assert.doesNotMatch(readFileSync(json, 'utf8'), /sk-compat-/);
}));

test('each broken fake-cli variant fails exactly the checks it breaks, without crashing the run', async () => {
  const expected = {
    'key-in-argv': ['key-not-in-argv'],
    'echo-key': ['exact-reply', 'key-not-in-output'],
    'error-echo-key': ['key-not-in-output'],
    'extra-text': ['exact-reply'],
    'new-session': ['resume-session'],
    'retry-refusal': ['refusal'],
    'plain-error': ['provider-5xx', 'refusal', 'stall'],
    'no-timeout': ['stall'],
    'bad-trace': ['trace-order'],
    // Two calls per ordinary turn: a refusal that also makes two is not a retry.
    'double-call': [],
    'retry-5xx-forever': ['provider-5xx'],
  };
  const targets = [
    ...Object.keys(expected).map((fault) => variant(fault, fault === 'retry-5xx-forever' ? { timeouts: { turnMs: 3000 } } : {})),
    variant('none', { cli: 'fake-cli-wrong-version', options: { version: '9.9.9' } }),
  ];
  const results = await runMatrix(targets, { timeouts: FAST });
  assert.equal(results.rows.length, targets.length * CHECKS.length);
  for (const [fault, checks] of Object.entries(expected)) {
    assert.deepEqual(failing(results.rows, `fake-cli-${fault}@1.0.0`), checks, fault);
  }
  assert.deepEqual(failing(results.rows, 'fake-cli-wrong-version@1.0.0'), ['version-pin']);
  const leakDetail = (fault) => results.rows.find((r) => r.target === `fake-cli-${fault}@1.0.0` && r.check === 'key-not-in-output').detail;
  assert.match(leakDetail('error-echo-key'), /\berror of turn \d/, 'the error text itself is scanned, not only the trace');
  assert.match(leakDetail('echo-key'), /\breply of turn 1\b/);
  const retried = results.rows.find((r) => r.target === 'fake-cli-retry-refusal@1.0.0' && r.check === 'refusal');
  assert.match(retried.detail, /asked 2 times against 1/);
  assert.match(results.rows.find((r) => r.target === 'fake-cli-retry-5xx-forever@1.0.0' && r.check === 'provider-5xx').detail, /not surfaced; the turn ran until RunFailure timeout/);
  assert.match(results.rows.find((r) => r.target === 'fake-cli-double-call@1.0.0' && r.check === 'refusal').detail, /after 2 provider request/);
  const hung = results.rows.find((r) => r.target === 'fake-cli-no-timeout@1.0.0' && r.check === 'stall');
  assert.match(hung.detail, /timed out|cancelled/);
  assert.ok(hung.ms < FAST.stallMs + FAST.graceMs * 2 + 1000, `stall check ran ${hung.ms}ms`);
});

test('a hanging check is cut off by its own timeout and its open turn is cancelled', async () => {
  const fake = await startFakeProvider();
  let aborted = null;
  const adapter = {
    name: 'hangs',
    async detect() { return { path: '(test)', version: '1' }; },
    spawn: (_prompt, ctx) => new Promise((_resolve, reject) => {
      ctx.signal.addEventListener('abort', () => { aborted = ctx.signal.reason; reject(ctx.signal.reason); });
    }),
  };
  const harness = createHarness({ adapter, provider: { ...fake, apiKey: 'sk-compat-test-key-000' }, timeouts: FAST });
  // If runCheck's deadline broke, this test must fail, not hang the suite.
  const guard = (promise) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('runCheck outlived its deadline')), 3000).unref())]);
  try {
    const neverSettles = { id: 'hang', title: 'never settles', run: () => new Promise(() => {}) };
    const started = Date.now();
    const cut = await guard(runCheck(neverSettles, {}, harness, { timeoutMs: 150 }));
    assert.equal(cut.status, 'fail');
    assert.match(cut.detail, /timed out after 150ms/);
    assert.ok(Date.now() - started < 1000);

    const fresh = CHECKS.find((c) => c.id === 'fresh-turn');
    const waited = await guard(runCheck(fresh, {}, harness, { timeoutMs: 200 }));
    assert.equal(waited.status, 'fail');
    assert.match(waited.detail, /timed out after 200ms/);
    assert.equal(aborted?.kind, 'cancelled', 'the adapter was told to stop');
  } finally {
    harness.dispose();
    await fake.close();
  }
});

test('a check that throws or returns a bad status is a fail row, not a crash', async () => {
  const env = { timeouts: FAST };
  const threw = await runCheck({ id: 'x', run: () => { throw runFailure('protocol', 'boom'); } }, {}, env);
  assert.equal(threw.status, 'fail');
  assert.match(threw.detail, /check threw: RunFailure protocol/);
  const bad = await runCheck({ id: 'y', run: async () => ({ status: 'maybe' }) }, {}, env);
  assert.equal(bad.status, 'fail');
});

test('a target whose adapter module is absent skips every check cleanly', async () => {
  const fake = await startFakeProvider();
  const provider = { ...fake, apiKey: 'sk-compat-test-key-001' };
  try {
    const rows = await runTarget({
      cli: 'future', version: '1.0.0', adapter: 'src/adapters/not-landed-yet.js#acpFuture', requires: 'acp', enabled: true,
    }, { provider, timeouts: FAST });
    assert.equal(rows.length, CHECKS.length);
    for (const row of rows) {
      assert.equal(row.status, 'skip');
      assert.match(row.detail, /src\/adapters\/not-landed-yet\.js is not present \(requires: acp\)/);
    }
    const disabled = await runTarget(fakeCli({ enabled: false }), { provider, timeouts: FAST });
    assert.ok(disabled.every((r) => r.status === 'skip' && r.detail === 'target disabled'));
    // A module that IS present but lacks the export is a real error, not a skip.
    const noExport = await runTarget(fakeCli({ adapter: 'src/adapters/stub.js#missing' }), { provider, timeouts: FAST });
    assert.ok(noExport.every((r) => r.status === 'fail' && /has no export missing/.test(r.detail)));
    // A pinned binary that was never installed fails detect and skips the rest.
    const notInstalled = await runTarget(fakeCli({ binary: { path: '/nonexistent/fake-cli' } }), { provider, timeouts: FAST });
    assert.deepEqual(notInstalled.map((r) => r.status), ['fail', ...Array(CHECKS.length - 1).fill('skip')]);
  } finally {
    await fake.close();
  }
});

test('the seeded targets skip the ACP CLIs while their module is absent', async () => {
  const targets = loadTargets(join(PACKAGE_ROOT, 'compat', 'targets.json'));
  assert.deepEqual(targets.map((t) => t.cli), ['stub', 'fake-cli', 'goose', 'opencode', 'opencode-v2']);
  const acp = targets.filter((t) => t.requires === 'acp');
  assert.deepEqual(acp.map((t) => `${t.cli}@${t.version}`), ['goose@1.56.0', 'opencode@1.19.4', 'opencode-v2@2.1.4']);
  // Probes need a factory export, so probeOptions can build a second instance.
  for (const t of acp) {
    assert.match(t.adapter, /#createAcp(?:Goose|Opencode)Adapter$/, t.cli);
    assert.deepEqual(t.probeOptions, { watchProvider: false }, t.cli);
  }
  if (existsSync(join(PACKAGE_ROOT, 'src', 'adapters', 'acp-launch.js'))) return; // landed: covered by the nightly
  const fake = await startFakeProvider();
  try {
    for (const target of acp) {
      const rows = await runTarget(target, { provider: { ...fake, apiKey: 'sk-compat-test-key-002' }, prefix: '/nonexistent', timeouts: FAST });
      assert.ok(rows.every((r) => r.status === 'skip' && /acp-launch\.js is not present \(requires: acp\)/.test(r.detail)), JSON.stringify(rows[0]));
    }
  } finally {
    await fake.close();
  }
});

test('the argv watch sees a key in a child process argv and ignores its own ps', async () => {
  const key = 'sk-compat-argv-probe-123456';
  const leaky = watchArgv(key);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 400)', key], { stdio: 'ignore' });
  await new Promise((resolve) => child.once('spawn', resolve));
  leaky.snapshot();
  await new Promise((resolve) => child.once('close', resolve));
  leaky.stop();
  assert.equal(leaky.report.leaks, 1);
  assert.equal(leaky.report.processes, 1);

  const quiet = watchArgv(key);
  await new Promise((resolve) => setTimeout(resolve, 250));
  quiet.stop();
  assert.deepEqual(quiet.report, { available: true, processes: 0, leaks: 0 });
});

test('the two opencode lines are separate targets, and only 1.x carries the retry-status limit', () => {
  const targets = loadTargets(join(PACKAGE_ROOT, 'compat', 'targets.json'));
  const v1 = targets.find((t) => t.cli === 'opencode');
  const v2 = targets.find((t) => t.cli === 'opencode-v2');
  assert.equal(v1.binary.npm, 'opencode-ai@1.19.4');
  assert.equal(v2.binary.npm, '@opencode/cli@2.1.4');
  assert.equal(limitOf(v1, 'retry-status').fixedIn, '@opencode/cli ≥2.0.15');
  assert.match(limitOf(v1, 'retry-status').note, /no session\/update/);
  assert.equal(limitOf(v2, 'retry-status'), null);
  // goose is silent while it retries too, and no release fixes it yet.
  const goose = targets.find((t) => t.cli === 'goose');
  assert.match(limitOf(goose, 'retry-status').note, /no session\/update/);
  assert.equal(limitOf(goose, 'retry-status').fixedIn, undefined);
  // 2.x's .bin launcher is a stub that only its postinstall replaces, and
  // install runs with --ignore-scripts, so the pin is the platform binary.
  for (const bin of Object.values(v2.binary.bin)) assert.match(bin, /^node_modules\/@opencode\/cli-(?:linux|darwin)-(?:x64|arm64)\/bin\/opencode$/);
  assert.notEqual(installDirOf(v1, '/p'), installDirOf(v2, '/p'));
});

test('a declared limit rides on its row: a failure it explains counts as limit, not fail', async () => {
  const fake = await startFakeProvider();
  try {
    const stub = {
      cli: 'stub', version: '0.0.0', adapter: 'src/adapters/stub.js#default', enabled: true,
      limits: { 'fresh-turn': { note: 'never calls a provider', fixedIn: 'stub@never' }, detect: { note: 'not a failure here' } },
    };
    const rows = await runTarget(stub, { provider: { ...fake, apiKey: 'sk-compat-test-key-003' }, timeouts: FAST });
    const fresh = rows.find((r) => r.check === 'fresh-turn');
    assert.equal(fresh.status, 'fail', 'the real status is kept');
    assert.deepEqual(fresh.limit, { note: 'never calls a provider', fixedIn: 'stub@never' });
    assert.ok(isLimitRow(fresh));
    const detect = rows.find((r) => r.check === 'detect');
    assert.equal(detect.status, 'pass');
    assert.ok(!isLimitRow(detect), 'a passing row with a declared limit is not a limit');
    assert.deepEqual(totalsOf(rows), {
      pass: rows.filter((r) => r.status === 'pass').length,
      fail: rows.filter((r) => r.status === 'fail').length - 1,
      skip: rows.filter((r) => r.status === 'skip').length,
      limit: 1,
    });
  } finally {
    await fake.close();
  }
});

test('limitOf ignores a limit with no note and drops an empty fixedIn', () => {
  assert.equal(limitOf({ limits: { a: { fixedIn: 'x' } } }, 'a'), null);
  assert.equal(limitOf({ limits: { a: { note: '' } } }, 'a'), null);
  assert.deepEqual(limitOf({ limits: { a: { note: 'n', fixedIn: '' } } }, 'a'), { note: 'n' });
  assert.equal(limitOf({}, 'a'), null);
});
