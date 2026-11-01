// Run: node --test cap/measure_after.test.js   (no browser, no network)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { parseArgs, validateTargets, checkSurface, EXPECTED, SIDEBAR_390 } = require('./measure_after');
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
  // Drawn, but prod can't reach it without issuing a key: refused rather than a silent zero-check pass.
  assert.throws(() => parseArgs(argv('prod', '--only', 'byo-handoff')), /unknown surface: byo-handoff/);
  assert.deepStrictEqual(parseArgs(argv('prod', '--only', 'byo')), { mode: 'prod', only: ['byo'] });
  assert.throws(() => parseArgs(argv('prod', '--only')), /accepts only/);
  assert.deepStrictEqual(parseArgs(argv('prod', '--only', 'chat,board')), { mode: 'prod', only: ['chat', 'board'] });
});

test('the committed targets.json passes its own validation', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.strictEqual(Object.keys(t).length, 32);
  validateTargets(t);
});

test('an empty or partial measurement is refused', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.throws(() => validateTargets({}), /missing/);
  const partial = { ...t }; delete partial['board-390'];
  assert.throws(() => validateTargets(partial), /missing board-390/);
  assert.throws(() => validateTargets({ ...t, 'chat-1440': { helperWords: NaN, innerRatio: 2 } }), /invalid chat-1440/);
  assert.strictEqual(EXPECTED.length, 32);
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

// A phone page for the sidebar check. `landsOn` is where goto('/v2') ends (a pod, on a first
// visit); `backTo` is where the back control's click lands, or null for no control; `listShown`
// is whether the pods list is on screen; `failed` shows the error message the sidebar renders
// when the pods request fails. `measured` counts metric runs, so a test can prove the refusal
// came before any measuring.
const fakePhone = ({ landsOn, backTo, listShown = true, failed = false }) => {
  let url = 'about:blank';
  const page = {
    measured: 0,
    goto: async () => { url = BASE + landsOn; return { ok: () => true, status: () => 200 }; },
    waitForTimeout: async () => {},
    url: () => url,
    evaluate: async () => { page.measured++; return { helperWords: 0, innerRatio: 1 }; },
    locator: sel => {
      const back = sel === SIDEBAR_390.back, list = sel === SIDEBAR_390.list, err = sel === SIDEBAR_390.failed;
      if (!back && !list && !err) throw new Error(`unexpected locator ${sel}`);
      const n = back ? (backTo === null ? 0 : 1) : 1;
      const onList = () => new URL(url).pathname === '/v2';
      const el = { click: async () => { url = BASE + backTo; }, isVisible: async () => onList() && (list ? listShown : err && failed) };
      return { count: async () => n, first: () => el };
    },
  };
  return page;
};
const sidebar = ['sidebar', vp => (vp === '1440' ? '/v2/pods/abc' : '/v2'), { list390: SIDEBAR_390 }];

test('a back control that lands on sign-in is refused before any metric runs', async () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  // goto lands on the auto-selected pod, which assertLanded allows for /v2; only the click redirects.
  const p = fakePhone({ landsOn: '/v2/pods/abc', backTo: '/v2/login' });
  await assert.rejects(checkSurface(p, sidebar, '390', t), /ended signed out on \/v2\/login/);
  assert.strictEqual(p.measured, 0);
});

test('the phone sidebar never scores a pod', async () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  const noBack = fakePhone({ landsOn: '/v2/pods/abc', backTo: null });
  await assert.rejects(checkSurface(noBack, sidebar, '390', t), /has no \.v2-thread__back control/);
  const stays = fakePhone({ landsOn: '/v2/pods/abc', backTo: '/v2/pods/abc' });
  await assert.rejects(checkSurface(stays, sidebar, '390', t), /left the page on \/v2\/pods\/abc, not \/v2/);
  const hidden = fakePhone({ landsOn: '/v2', backTo: null, listShown: false });
  await assert.rejects(checkSurface(hidden, sidebar, '390', t), /pods list .* is not visible/);
  assert.strictEqual(noBack.measured + stays.measured + hidden.measured, 0);
  // Positive controls: an auto-selected pod whose back control reaches the list, and /v2 shown directly.
  const back = fakePhone({ landsOn: '/v2/pods/abc', backTo: '/v2' });
  assert.strictEqual((await checkSurface(back, sidebar, '390', t)).ok, true);
  assert.strictEqual(back.measured, 1);
  assert.strictEqual((await checkSurface(fakePhone({ landsOn: '/v2', backTo: null }), sidebar, '390', t)).ok, true);
});

test('a failed pods request is refused before any metric runs', async () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  // The error state keeps `.v2-pods` on screen but renders no list, reached directly or via back.
  const direct = fakePhone({ landsOn: '/v2', backTo: null, listShown: false, failed: true });
  await assert.rejects(checkSurface(direct, sidebar, '390', t), /pods did not load/);
  const viaBack = fakePhone({ landsOn: '/v2/pods/abc', backTo: '/v2', listShown: false, failed: true });
  await assert.rejects(checkSurface(viaBack, sidebar, '390', t), /pods did not load/);
  assert.strictEqual(direct.measured + viaBack.measured, 0);
  // The check reads the loaded list, never the `.v2-pods` container the error state keeps.
  assert.match(SIDEBAR_390.list, /\.v2-pods__list$/);
  assert.match(SIDEBAR_390.failed, /:not\(\.v2-pods__list /);
});

test('only the /v2 pod auto-select counts as landing', () => {
  assertLanded('/v2/settings', BASE + '/v2/settings/');
  assertLanded('/v2', BASE + '/v2/pods/abc123');
  assert.throws(() => assertLanded('/v2/agents/a/default', BASE + '/v2'), /redirected to \/v2$/);
  assert.throws(() => assertLanded('/v2/settings', BASE + '/v2/pods/abc123'), /redirected/);
});
