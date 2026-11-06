// Run: node --test cap/measure_after.test.js   (no browser, no network)
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { METRICS, BUSY, parseArgs, validateTargets, unknownFrameError, keyFrames, checkSurface, EXPECTED, SURFACES, SKIPPED, PROD_SURFACES, SIDEBAR_390 } = require('./measure_after');
const { assertLanded, BASE } = require('./lib');

const argv = (...a) => ['node', 'measure_after.js', ...a];

test('the prod count skips text nobody can see', () => {
  const src = String(METRICS);
  assert.match(src, /details:not\(\[open\]\)/, 'a closed fold still reports a box');
  assert.match(src, /box\.width <= 1/, 'a screen-reader label is a 1px box');
  assert.match(src, /if \(hidden\(el\)\) continue/);
});

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
  assert.strictEqual(Object.keys(t).length, 48);
  validateTargets(t);
});

test('an empty or partial measurement is refused', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  assert.throws(() => validateTargets({}), /missing/);
  const partial = { ...t }; delete partial['board-390'];
  assert.throws(() => validateTargets(partial), /missing board-390/);
  assert.throws(() => validateTargets({ ...t, 'chat-1440': { helperWords: NaN, innerRatio: 2 } }), /invalid chat-1440/);
  assert.strictEqual(EXPECTED.length, 48);
});

test('a frame the scorer does not know is named, with the way to fix it', () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  const extra = { ...t, 'new-thing-1440': { helperWords: 3, innerRatio: 1 }, 'new-thing-390': { helperWords: 2, innerRatio: 1 } };
  let msg = '';
  try { validateTargets(extra); } catch (e) { msg = e.message; }
  assert.match(msg, /frames the scorer doesn't know: new-thing-1440, new-thing-390/);
  assert.match(msg, /add "new-thing" to SURFACES/);
  assert.match(msg, /SKIPPED/);
  assert.match(msg, /data-state/);
  assert.match(msg, /targets\.json left unchanged$/);
  assert.match(unknownFrameError(['a-b-390']), /add "a-b" to SURFACES/);
});

// keyFrames is the Node half of artboard(): the page reports every frame raw, and only this
// decides which count. These run without a browser.
const frame = (surface, vp, extra = {}) => ({ surface, vp, hasState: false, helperWords: 4, innerRatio: 1, ...extra });

test('keyFrames keys a normal frame by surface and viewport', () => {
  assert.deepStrictEqual(keyFrames([frame('board', '390', { helperWords: 14, innerRatio: 1.2 })], {}),
    { res: { 'board-390': { helperWords: 14, innerRatio: 1.2 } }, dupes: [] });
});

test('keyFrames ignores a skipped surface', () => {
  const { res, dupes } = keyFrames([frame('activity-busy', '1440'), frame('board', '1440')], { 'activity-busy': 'redesign' });
  assert.deepStrictEqual(Object.keys(res), ['board-1440']);
  assert.deepStrictEqual(dupes, []);
});

test('keyFrames ignores a state frame, even one sharing a scored key', () => {
  const { res, dupes } = keyFrames([frame('settings', '1440', { helperWords: 10 }), frame('settings', '1440', { hasState: true, helperWords: 99 })], {});
  assert.deepStrictEqual(res, { 'settings-1440': { helperWords: 10, innerRatio: 1 } });
  assert.deepStrictEqual(dupes, []);
});

test('keyFrames reports two scored frames with one key as dupes', () => {
  const { res, dupes } = keyFrames([frame('chat', '390', { helperWords: 9 }), frame('chat', '390', { helperWords: 50 })], {});
  assert.deepStrictEqual(dupes, ['chat-390']);
  assert.strictEqual(res['chat-390'].helperWords, 9);
});

// Every base frame in index.html (no data-state) is either scored or skipped on purpose, so a new
// frame fails here, without a browser, before it can break a regeneration.
test('every base frame in index.html is in SURFACES or SKIPPED', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const tags = html.match(/<[a-z]+\b[^>]*\bclass="frame"[^>]*>/g) || [];
  const attr = (tag, name) => (tag.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1];
  const base = tags.filter(tag => attr(tag, 'data-state') === undefined);
  assert.ok(base.length > 0, 'no base frames found; the frame pattern no longer matches index.html');
  const seen = new Set(base.map(tag => attr(tag, 'data-surface')));
  const unknown = [...seen].filter(s => !SURFACES.includes(s) && !(s in SKIPPED));
  assert.deepStrictEqual(unknown, [], unknown.length ? unknownFrameError(unknown.map(s => `${s}-?`)) : '');
  // Every scored surface is drawn at both viewports, and no surface is both scored and skipped.
  for (const s of SURFACES) for (const vp of ['1440', '390']) {
    assert.ok(base.some(tag => attr(tag, 'data-surface') === s && attr(tag, 'data-vp') === vp), `${s}-${vp} is in SURFACES but not drawn`);
  }
  assert.deepStrictEqual(SURFACES.filter(s => s in SKIPPED), []);
  for (const [s, why] of Object.entries(SKIPPED)) assert.ok(why && seen.has(s), `SKIPPED entry ${s} needs a reason and a drawn frame`);
  assert.ok(PROD_SURFACES.every(s => SURFACES.includes(s)));
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

// A busy page on its route. `rows` maps each trim selector to its row count, and `refused` puts
// the error line or the spinner on screen. `trimmed` records the trim the scorer asked for.
const fakeBusy = (name, route, { rows, refused = false }) => {
  let url = 'about:blank';
  const B = BUSY[name];
  const page = {
    trimmed: null,
    measured: 0,
    goto: async () => { url = BASE + route; return { ok: () => true, status: () => 200 }; },
    waitForTimeout: async () => {},
    url: () => url,
    locator: sel => {
      if (sel === B.refuse) return { first: () => ({ isVisible: async () => refused }) };
      if (sel in rows) return { count: async () => rows[sel] };
      throw new Error(`unexpected locator ${sel}`);
    },
    evaluate: async (fn, arg) => {
      if (arg) { page.trimmed = arg; return undefined; }
      page.measured++;
      return { helperWords: 0, innerRatio: 1 };
    },
  };
  return page;
};

test('a busy surface scores only a loaded list as long as its frame, trimmed to the frame', async () => {
  const t = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'targets.json'), 'utf8'));
  // Keyed by name: the plain prod tuple gets the guard, with nothing for SURF to forget.
  const artifacts = ['artifacts-busy', () => '/v2/artifacts'];
  const failed = fakeBusy('artifacts-busy', '/v2/artifacts', { rows: { '.v2a-file': 0 }, refused: true });
  await assert.rejects(checkSurface(failed, artifacts, '1440', t), /did not load/);
  assert.strictEqual(failed.measured, 0);
  const short = fakeBusy('artifacts-busy', '/v2/artifacts', { rows: { '.v2a-file': 2 } });
  await assert.rejects(checkSurface(short, artifacts, '390', t), /2 \.v2a-file rows .* not the busy state/);
  assert.strictEqual(short.measured, 0);
  const busy = fakeBusy('artifacts-busy', '/v2/artifacts', { rows: { '.v2a-file': 50 } });
  assert.strictEqual((await checkSurface(busy, artifacts, '1440', t)).ok, true);
  assert.deepStrictEqual(busy.trimmed, [{ rows: '.v2a-file', group: '.v2a-group', keep: 6 }]);
  assert.strictEqual(busy.measured, 1);

  // Activity: Needs you pages itself through every open item, so both lists are trimmed to the frame.
  const activity = ['activity-busy', () => '/v2/activity'];
  const queue = '.v2-activity__queue > .v2-activity__queue-row', moved = '.v2-activity__moved-line';
  const thin = fakeBusy('activity-busy', '/v2/activity', { rows: { [queue]: 429, [moved]: 3 } });
  await assert.rejects(checkSurface(thin, activity, '390', t), /3 \.v2-activity__moved-line rows/);
  const full = fakeBusy('activity-busy', '/v2/activity', { rows: { [queue]: 429, [moved]: 5 } });
  assert.strictEqual((await checkSurface(full, activity, '1440', t)).ok, true);
  assert.deepStrictEqual(full.trimmed.map(x => [x.rows, x.keep]), [[queue, 4], [moved, 5]]);
  // Every other prod surface is measured as it stands.
  assert.deepStrictEqual(Object.keys(BUSY).sort(), ['activity-busy', 'artifacts-busy']);
  // The selectors are the pages' real classes: a renamed or mistyped class would leave the
  // refusal looking for nothing, so each one is pinned here and found in the page source.
  assert.strictEqual(BUSY['activity-busy'].refuse, '.v2-activity__error, .v2-activity__loading');
  assert.strictEqual(BUSY['artifacts-busy'].refuse, '.v2a-state, .v2a-loading');
  const src = {
    'activity-busy': fs.readFileSync(path.join(__dirname, '../../../../../frontend/src/v2/components/V2ActivityPage.tsx'), 'utf8'),
    'artifacts-busy': fs.readFileSync(path.join(__dirname, '../../../../../frontend/src/v2/components/V2ArtifactsPage.tsx'), 'utf8'),
  };
  for (const [name, B] of Object.entries(BUSY)) {
    const sels = [B.refuse, ...B.trim.flatMap(x => [x.rows, x.group].filter(Boolean))].join(' ');
    for (const cls of sels.match(/\.[\w-]+/g)) assert.ok(new RegExp(`className="[^"]*\\b${cls.slice(1)}\\b`).test(src[name]), `${name}: ${cls} is not a class in the page`);
  }
});
