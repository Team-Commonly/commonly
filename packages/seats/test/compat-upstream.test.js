import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKS, runCheck } from '../compat/checks.js';
import { renderMatrix, upstreamItem } from '../compat/render.js';
import { runMatrix } from '../compat/run.js';
import { PACKAGE_ROOT } from '../compat/targets.js';
import {
  loadUpstream, normaliseUpstream, observedOf, upstreamForResults, upstreamStatusOf,
} from '../compat/upstream.js';

const SHA = 'a'.repeat(40);
const SEEDED = join(PACKAGE_ROOT, 'compat', 'upstream.json');
const row = (extra = {}) => ({
  id: 'x', cli: 'x', bug: 'b', status: 'worked around',
  workaround: { name: 'w', ref: SHA, where: 'src/x.js', tests: ['test/x.test.js: proves it'] },
  references: [], ...extra,
});

test('a row is worked around only with a commit and a test; a link proves nothing', () => {
  assert.equal(upstreamStatusOf(row()), 'worked around');
  assert.equal(upstreamStatusOf(row({ workaround: { name: 'w', ref: '', tests: ['t'] } })), 'open', 'no commit');
  assert.equal(upstreamStatusOf(row({ workaround: { name: 'w', ref: 'feat/x', tests: ['t'] } })), 'open', 'a branch name moves; only a sha pins the proof');
  assert.equal(upstreamStatusOf(row({ workaround: { name: 'w', ref: SHA, tests: [] } })), 'open', 'no test');
  assert.equal(upstreamStatusOf(row({ workaround: { name: 'w', ref: SHA, tests: ['  '] } })), 'open', 'a blank test');
  assert.equal(upstreamStatusOf(row({ workaround: { name: 'w', ref: SHA }, references: ['https://github.com/o/r/issues/1'] })), 'open', 'an upstream link is not the fix');
  assert.equal(upstreamStatusOf(row({ status: 'open' })), 'open', 'a row listed open stays open');
});

test('an unproven "worked around" is downgraded to open and says why', () => {
  const [downgraded, proven, open] = normaliseUpstream([
    row({ workaround: { name: 'w', ref: SHA, tests: [] } }), row(), row({ status: 'open', workaround: { name: 'w' } }),
  ]);
  assert.equal(downgraded.status, 'open');
  assert.match(downgraded.downgraded, /names no commit or no test/);
  assert.equal(proven.status, 'worked around');
  assert.equal(proven.downgraded, undefined);
  assert.equal(open.downgraded, undefined, 'a row listed open is not a downgrade');
});

test('the seeded upstream rows load, and each status is the one the evidence supports', () => {
  const rows = normaliseUpstream(loadUpstream(SEEDED));
  const status = Object.fromEntries(rows.map((r) => [r.id, r.status]));
  assert.deepEqual(status, {
    'goose-refusal-retried': 'worked around',
    'goose-5xx-silent': 'worked around',
    'codex-refusal-exit-0': 'open',
    'opencode-5xx-silent': 'worked around',
    'opencode-v2-retry-status-unread': 'open',
    'pi-cowboy-explore-hang': 'fixed upstream',
  });
  for (const r of rows) {
    assert.ok(r.workaround.name, `${r.id} names its workaround, planned or done`);
    assert.equal(r.downgraded, undefined, `${r.id} claims no more than its evidence`);
    for (const ref of r.references) assert.match(ref, /^https:\/\/github\.com\//);
  }
  const codex = rows.find((r) => r.id === 'codex-refusal-exit-0');
  assert.deepEqual(codex.references, ['https://github.com/openai/codex/issues/56875']);
  const pi = rows.find((r) => r.id === 'pi-cowboy-explore-hang');
  assert.equal(pi.fixed.version, '0.22.2');
  assert.match(pi.fixed.verified, /6 of 6/);
});

test('a row is fixed upstream only with the fixing release, our check of it, and the issue link', () => {
  const fixed = (extra = {}) => row({
    status: 'fixed upstream',
    workaround: { name: 'w' },
    fixed: { version: '1.2.3', verified: 'ran the repro 6 times on 1.2.3' },
    references: ['https://github.com/o/r/issues/1'],
    ...extra,
  });
  assert.equal(upstreamStatusOf(fixed()), 'fixed upstream');
  assert.equal(upstreamStatusOf(fixed({ fixed: { version: '', verified: 'v' } })), 'open', 'no release');
  assert.equal(upstreamStatusOf(fixed({ fixed: { version: '1.2.3', verified: ' ' } })), 'open', 'their word is not our check');
  assert.equal(upstreamStatusOf(fixed({ fixed: undefined })), 'open', 'no fixed block');
  assert.equal(upstreamStatusOf(fixed({ references: [] })), 'open', 'no upstream link');
  assert.equal(upstreamStatusOf(fixed({ references: ['javascript:x'] })), 'open', 'only an https link counts');
  assert.equal(upstreamStatusOf(row({ status: 'open', fixed: { version: '1', verified: 'v' }, references: ['https://x.example/1'] })), 'open', 'a row listed open stays open');
  const [proven, downgraded] = normaliseUpstream([fixed(), fixed({ fixed: { version: '1.2.3' } })]);
  assert.deepEqual(proven.fixed, { version: '1.2.3', verified: 'ran the repro 6 times on 1.2.3' });
  assert.equal(downgraded.status, 'open');
  assert.equal(downgraded.fixed, undefined, 'an unproven fix is not carried to the page');
  assert.match(downgraded.downgraded, /no fixing release, no check of it, or no upstream link/);
  const html = upstreamItem(proven);
  assert.match(html, /<span class="badge fixed">fixed upstream<\/span>/);
  assert.match(html, /<strong>Fixed upstream in 1\.2\.3:<\/strong> ran the repro 6 times on 1\.2\.3/);
  assert.match(html, /<strong>Our workaround, for older versions:<\/strong> w/);
  assert.doesNotMatch(html, /No test proves it yet/);
});

test('loadUpstream rejects a status outside the three, and a row missing its workaround', () => {
  const dir = mkdtempSync(join(tmpdir(), 'compat-upstream-'));
  try {
    const write = (rows) => { const p = join(dir, 'u.json'); writeFileSync(p, JSON.stringify(rows)); return p; };
    assert.throws(() => loadUpstream(write([row({ status: 'waiting on upstream' })])), /use "worked around", "fixed upstream" or "open"/);
    assert.throws(() => loadUpstream(write([row({ workaround: {} })])), /workaround\.name/);
    assert.throws(() => loadUpstream(write({ rows: [] })), /must hold an array/);
    assert.deepEqual(loadUpstream(join(dir, 'absent.json')), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a row pointing at a matrix check carries what this run saw, a limit included', () => {
  const matrixRows = [
    { target: 'goose@1.56.0', check: 'refusal', status: 'pass' },
    { target: 'opencode@1.19.4', check: 'retry-status', status: 'fail', limit: { note: 'n' } },
  ];
  assert.equal(observedOf({ target: 'goose@1.56.0', check: 'refusal' }, matrixRows), 'pass');
  assert.equal(observedOf({ target: 'opencode@1.19.4', check: 'retry-status' }, matrixRows), 'limit');
  assert.equal(observedOf({ target: 'opencode@1.19.4', check: 'refusal' }, matrixRows), 'not run');
  assert.equal(observedOf(undefined, matrixRows), null);
  const [withMatrix, without] = upstreamForResults([row({ matrix: { target: 'goose@1.56.0', check: 'refusal' } }), row()], matrixRows);
  assert.deepEqual(withMatrix.matrix, { target: 'goose@1.56.0', check: 'refusal', observed: 'pass' });
  assert.equal(without.matrix, undefined);
});

test('runMatrix puts the upstream rows in the results document', async () => {
  const results = await runMatrix([], { checks: [], upstream: [row(), row({ id: 'y', status: 'open' })] });
  assert.deepEqual(results.upstream.map((r) => [r.id, r.status]), [['x', 'worked around'], ['y', 'open']]);
  assert.deepEqual((await runMatrix([], { checks: [] })).upstream, []);
});

test('an upstream item shows its status, where the workaround lives, its proof, and links as references', () => {
  const worked = upstreamItem(normaliseUpstream([row({ references: ['https://github.com/o/r/issues/1'] })])[0]);
  assert.match(worked, /<span class="badge worked">worked around<\/span>/);
  assert.match(worked, /<strong>Workaround:<\/strong> w \(<code>a{40}<\/code> · src\/x\.js\)/);
  assert.match(worked, /<li><code>test\/x\.test\.js: proves it<\/code><\/li>/);
  assert.match(worked, /Upstream \(reference, not the fix\):<\/strong> <a href="https:\/\/github\.com\/o\/r\/issues\/1"/);
  const open = upstreamItem(normaliseUpstream([row({ status: 'open', workaround: { name: 'plan', where: 'our plugin' } })])[0]);
  assert.match(open, /<span class="badge open">open<\/span>/);
  assert.match(open, /<strong>Planned workaround:<\/strong> plan \(our plugin\)/);
  assert.match(open, /No test proves it yet\./);
  const downgraded = upstreamItem(normaliseUpstream([row({ workaround: { name: 'w', ref: SHA } })])[0]);
  assert.match(downgraded, /badge open/);
  assert.match(downgraded, /listed as worked around, but names no commit or no test/);
});

test('an upstream item escapes its text and links only https', () => {
  const html = upstreamItem(normaliseUpstream([row({
    bug: '<img src=x onerror=1>', cli: '"><script>',
    references: ['javascript:alert(1)', 'https://ok.example/a"onmouseover="x'],
  })])[0]);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('<script>'), false);
  assert.doesNotMatch(html, /href="javascript:/);
  assert.doesNotMatch(html, /href="https:\/\/ok\.example\/a"/, 'a quote in a URL is not a link');
  assert.match(html, /javascript:alert\(1\)/, 'kept as text');
});

test('the page has an Upstream bugs section only when rows exist', () => {
  const base = { checks: [], rows: [], targets: [] };
  assert.doesNotMatch(renderMatrix(base), /Upstream bugs/);
  const html = renderMatrix({ ...base, upstream: normaliseUpstream([row(), row({ id: 'y', status: 'open' })]) });
  assert.match(html, /<h2>Upstream bugs<\/h2>\n<p class="meta">1 worked around · 0 fixed upstream · 1 open\./);
});

const refusalEnv = (error, refused = 1) => ({
  timeouts: { turnMs: 1000, stallMs: 500, graceMs: 100, checkMs: 2000 },
  detect: async () => ({ found: { path: '/bin/x', version: '1' } }),
  turn: async (name) => (name === 'refusal'
    ? { ok: false, error, requests: Array.from({ length: refused }, () => ({ directive: 'refuse' })), events: [] }
    : { ok: true, result: { text: 'ok' }, requests: [{ directive: 'ok' }], events: [] }),
});
const refusalCheck = CHECKS.find((c) => c.id === 'refusal');

test('the refusal check accepts refusal_retry_loop, the kind a provider watch names, and still rejects the rest', async () => {
  const named = (kind) => ({ name: 'RunFailure', kind, message: kind });
  const watched = await runCheck(refusalCheck, {}, refusalEnv(named('refusal_retry_loop')));
  assert.equal(watched.status, 'pass', watched.detail);
  assert.match(watched.detail, /^refusal_retry_loop named after 1 provider request/);
  assert.equal((await runCheck(refusalCheck, {}, refusalEnv(named('refusal')))).status, 'pass');
  const protocol = await runCheck(refusalCheck, {}, refusalEnv(named('protocol')));
  assert.equal(protocol.status, 'fail');
  assert.match(protocol.detail, /expected RunFailure refusal or refusal_retry_loop, got/);
  assert.equal((await runCheck(refusalCheck, {}, refusalEnv(named('refusal_retry_loop'), 3))).status, 'fail', 'a retried refusal still fails');
});
