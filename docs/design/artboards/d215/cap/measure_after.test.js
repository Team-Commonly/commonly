// Run: node --test cap/measure_after.test.js   (no browser, no network)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseArgs, validateTargets, checkSurface, EXPECTED } = require('./measure_after');
const { assertLanded, BASE } = require('./lib');

const argv = (...a) => ['node', 'measure_after.js', ...a];

test('no argument measures the artboard', () => {
  assert.deepStrictEqual(parseArgs(argv()), { mode: 'artboard', only: null });
});

test('a mistyped mode throws instead of rewriting targets', () => {
  assert.throws(() => parseArgs(argv('prodd')), /unknown mode "prodd"/);
});

test('--only with an unknown surface throws', () => {
  assert.throws(() => parseArgs(argv('prod', '--only', 'unknown')), /unknown surface: unknown/);
  assert.throws(() => parseArgs(argv('prod', '--only', 'chat,nope')), /unknown surface: nope/);
  assert.throws(() => parseArgs(argv('prod', '--only', ',')), /names no surface/);
  assert.throws(() => parseArgs(argv('prod', '--only')), /accepts only/);
  assert.deepStrictEqual(parseArgs(argv('prod', '--only', 'chat,board')), { mode: 'prod', only: ['chat', 'board'] });
});

test('the committed targets.json passes its own validation', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.strictEqual(Object.keys(t).length, 14);
  validateTargets(t);
});

test('an empty or partial measurement is refused', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.throws(() => validateTargets({}), /missing/);
  const partial = { ...t }; delete partial['board-390'];
  assert.throws(() => validateTargets(partial), /missing board-390/);
  assert.throws(() => validateTargets({ ...t, 'chat-1440': { helperWords: NaN, innerRatio: 2 } }), /invalid chat-1440/);
  assert.strictEqual(EXPECTED.length, 14);
});

// A page whose SPA shell answers 200 and then redirects to `landsOn`. Its metrics would score
// a HIT on any surface, so only the landing check stands between it and a false HIT.
const fakePage = landsOn => {
  let url = 'about:blank';
  return {
    goto: async u => { url = BASE + landsOn; return { ok: () => true, status: () => 200 }; },
    waitForTimeout: async () => {},
    url: () => url,
    evaluate: async () => ({ helperWords: 0, innerRatio: 1 }),
  };
};

test('a client-side redirect to sign-in cannot produce a HIT', async () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  const settings = ['settings', () => '/v2/settings'];
  await assert.rejects(checkSurface(fakePage('/v2/login'), settings, '1440', t), /ended signed out on \/v2\/login/);
  await assert.rejects(checkSurface(fakePage('/'), ['sidebar', () => '/v2'], '390', t), /ended signed out on \//);
  // Positive control: the same page left on its route does score, so the refusal above is the check.
  const hit = await checkSurface(fakePage('/v2/settings'), settings, '1440', t);
  assert.strictEqual(hit.ok, true);
});

test('only the /v2 pod auto-select counts as landing', () => {
  assertLanded('/v2/settings', BASE + '/v2/settings/');
  assertLanded('/v2', BASE + '/v2/pods/abc123');
  assert.throws(() => assertLanded('/v2/agents/a/default', BASE + '/v2'), /redirected to \/v2$/);
  assert.throws(() => assertLanded('/v2/settings', BASE + '/v2/pods/abc123'), /redirected/);
});
