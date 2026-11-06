// D215 helper-word and scroll measurements.
//
//   node measure_after.js            measure the artboard (../index.html) and write ../targets.json
//   node measure_after.js prod       measure the live routes and check them against ../targets.json
//
// Both modes need `require('playwright')` to resolve. Outside a checkout that has it installed, point
// NODE_PATH at any node_modules that holds it, and PLAYWRIGHT_CHROMIUM at a matching chromium, e.g.
//   NODE_PATH=<dir>/node_modules PLAYWRIGHT_CHROMIUM=<chrome-headless-shell> node cap/measure_after.js
//
// Every frame in index.html without a data-state must be named in SURFACES (scored) or in SKIPPED
// (deliberately not scored, with a reason). Any other frame stops the run and names the frame.
//
// prod mode signs in through lib.js (COMMONLY_TOKEN, COMMONLY_URL) and needs:
//   D215_POD          id of a pod with a long chat history and a busy board
//   D215_AGENT        agent route segment, e.g. "<name>/default"
//   D215_SIDEBAR_POD  optional; pod opened for the 1440 sidebar shot (defaults to D215_POD)
//   D215_FIXTURES     optional; serves account data as the frame draws it (see lib.js)
//   --only a,b        optional; limit to these surfaces (chat, board, settings, ...)
// It exits 1 when any surface misses its target. It prints counts only, never page text.
//
// Helper words = grey text (saturation < 50, mean channel 60-200) outside controls and the
// nav rail. Scroll = the main scroller's height / viewport height.
const path = require('path');
const fs = require('fs');

const HERE = __dirname;
const TARGETS = path.join(HERE, '..', 'targets.json');

const SURFACES = [
  'settings', 'agent-settings', 'agent-memory', 'board', 'connectors', 'chat', 'sidebar', 'byo', 'byo-handoff',
  'firstrun-welcome', 'firstrun-waiting', 'firstrun-connected', 'firstrun-error', 'connect', 'team',
  'chat-agents-away', 'chat-trace', 'run-trace-after', 'profile', 'firstrun-welcome-nohost',
  // Activity and Artifacts: the frames Sam approved 11-03 ("Build as drawn"), built in
  // V2ActivityPage and V2ArtifactsPage.
  'activity-busy', 'activity-dayzero', 'artifacts-busy', 'artifacts-dayzero',
];
// Base frames (no data-state) that are drawn but deliberately not scored. Each needs a reason.
const SKIPPED = {
  // Drawings of the old page beside their "after" frames (390 only). They are what the fix moves
  // away from, so they are never a target.
  'chat-trace-before': 'before shot, not a target',
  'run-trace-before': 'before shot, not a target',
};
// Surfaces with a route in prod() below. byo-handoff can't be captured on prod: reaching it issues
// a real key. The first-run dialog is a latch-gated overlay, and the Scout welcome only exists in a
// brand-new pod. chat-agents-away and chat-trace need a pod in that exact state, run-trace-after a
// run id and profile a person id, none of which prod() takes yet, so they are artboard-only for now.
// activity-dayzero needs an account with no asks and no agents, and artifacts-dayzero one with no
// shared file, so only the two busy pages are checked on prod.
const PROD_SURFACES = ['settings', 'agent-settings', 'agent-memory', 'board', 'connectors', 'chat', 'sidebar', 'byo', 'connect', 'team', 'activity-busy', 'artifacts-busy'];
const VIEWPORTS = ['1440', '390'];
const EXPECTED = SURFACES.flatMap(s => VIEWPORTS.map(v => `${s}-${v}`));

// Accepts no arguments (artboard) or `prod [--only a,b]`; anything else throws before a browser opens.
function parseArgs(argv) {
  const args = argv.slice(2);
  if (args.length === 0) return { mode: 'artboard', only: null };
  if (args[0] !== 'prod') throw new Error(`unknown mode "${args[0]}"; use no argument or "prod"`);
  if (args.length === 1) return { mode: 'prod', only: null };
  if (args[1] !== '--only' || args.length !== 3) throw new Error('prod accepts only "--only a,b"');
  const only = args[2].split(',').map(x => x.trim()).filter(Boolean);
  const bad = only.filter(x => !PROD_SURFACES.includes(x));
  if (!only.length) throw new Error('--only names no surface');
  if (bad.length) throw new Error(`unknown surface: ${bad.join(', ')}; known: ${PROD_SURFACES.join(', ')}`);
  return { mode: 'prod', only };
}

// Every expected surface-viewport key must carry two finite numbers before targets.json is replaced.
// The surface name of a `<surface>-<vp>` key.
const surfaceOf = key => key.replace(/-(?:1440|390)$/, '');

// Explains a frame the scorer doesn't know, by its surface-viewport key.
function unknownFrameError(keys) {
  const names = [...new Set(keys.map(surfaceOf))];
  return `index.html draws frames the scorer doesn't know: ${keys.join(', ')}. For each, add "${names.join('", "')}" `
    + 'to SURFACES in cap/measure_after.js to score it, add it to SKIPPED there with a reason, '
    + 'or give the frame a data-state if it is a state of an existing surface';
}

function validateTargets(res) {
  const missing = EXPECTED.filter(k => !res[k]);
  const extra = Object.keys(res).filter(k => !EXPECTED.includes(k));
  const invalid = EXPECTED.filter(k => res[k] && !(Number.isFinite(res[k].helperWords) && Number.isFinite(res[k].innerRatio) && res[k].innerRatio >= 1));
  const problems = [];
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (extra.length) problems.push(unknownFrameError(extra));
  if (invalid.length) problems.push(`invalid ${invalid.join(', ')}`);
  if (problems.length) throw new Error(`artboard measurement incomplete (${problems.join('; ')}); targets.json left unchanged`);
}

// Turns the page's raw per-frame measurements into `<surface>-<vp>` targets. State frames and
// SKIPPED surfaces are dropped; a second scored frame with a key already taken is reported in
// `dupes` (and not measured over the first) so artboard() can refuse to write.
function keyFrames(frames, skipped) {
  const res = {}, dupes = [];
  for (const f of frames) {
    if (f.hasState) continue;
    if (Object.prototype.hasOwnProperty.call(skipped, f.surface)) continue;
    const key = `${f.surface}-${f.vp}`;
    if (res[key]) { dupes.push(key); continue; }
    res[key] = { helperWords: f.helperWords, innerRatio: f.innerRatio };
  }
  return { res, dupes };
}

async function artboard() {
  const { chromium } = require('playwright');
  const launch = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const b = await chromium.launch(launch);
  const p = await b.newPage({ viewport: { width: 1600, height: 1000 }, colorScheme: 'light' });
  await p.route(/^https?:\/\/(?!fonts\.)/, r => r.abort());
  await p.goto('file://' + path.join(HERE, '..', 'index.html'));
  await p.waitForTimeout(800);
  // The page reports every frame as drawn; which ones count is decided in Node, by keyFrames.
  const frames = await p.evaluate(() => [...document.querySelectorAll('.frame')].map(f => {
      const base = { surface: f.dataset.surface, vp: f.dataset.vp, hasState: f.hasAttribute('data-state') };
      const app = f.querySelector('.app'); f.style.setProperty('--s', 1); f.style.overflow = 'visible'; f.style.aspectRatio = 'auto'; f.style.height = app.offsetHeight + 'px'; f.style.width = app.offsetWidth + 'px'; f.style.maxWidth = 'none';
      let words = 0;
      const w = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode, txt = t.nodeValue.trim(); if (!txt) continue;
        const el = t.parentElement; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden') continue;
        if (el.closest('button,a,input,.rail,.mtab,.mbody,.tip,.pop,.seg,.sel,.mnote .sn')) continue;
        if (el.closest('details:not([open])') && !el.closest('summary')) continue;
        const [R, G, B] = cs.color.match(/\d+/g).map(Number); const sat = Math.max(R, G, B) - Math.min(R, G, B), avg = (R + G + B) / 3;
        if (sat < 50 && avg > 60 && avg < 200) words += txt.split(/\s+/).filter(x => /[A-Za-z一-鿿]/.test(x)).length;
      }
      let ratio = 1; app.querySelectorAll('.pbody,.mbody2').forEach(s => { ratio = Math.max(ratio, (s.scrollHeight + (app.offsetHeight - s.clientHeight)) / app.offsetHeight); });
      return { ...base, helperWords: words, innerRatio: +ratio.toFixed(2) };
    }));
  const { res, dupes } = keyFrames(frames, SKIPPED);
  // The chat mock is a short excerpt, so its scroll target was measured on prod history with
  // the six-line fold and claim-row collapse applied to the live DOM.
  if (res['chat-1440']) res['chat-1440'].innerRatio = 5.32;
  if (res['chat-390']) res['chat-390'].innerRatio = 6.28;
  await b.close();
  // Two scored frames with one key would silently overwrite each other's numbers.
  if (dupes.length) throw new Error(`index.html draws more than one scored frame for ${dupes.join(', ')}; give the extra ones a data-state; targets.json left unchanged`);
  validateTargets(res);
  fs.writeFileSync(TARGETS, JSON.stringify(res, null, 1) + '\n');
  for (const [k, v] of Object.entries(res)) console.log(k.padEnd(20), String(v.helperWords).padStart(4), v.innerRatio);
}

// The counter that produced the before numbers on prod, minus memory note text.
const METRICS = () => {
  const clipped = el => { const box = el.getBoundingClientRect(), cs = getComputedStyle(el); return (box.width <= 1 || box.height <= 1) && (cs.overflow === 'hidden' || cs.clipPath !== 'none' || cs.clip !== 'auto'); };
  const hidden = el => clipped(el) || (!!el.closest('details:not([open])') && !el.closest('summary'));
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && cs.display !== 'none' && +cs.opacity !== 0; };
  let best = null, bestH = 0;
  for (const el of document.querySelectorAll('*')) { const cs = getComputedStyle(el); if (!/(auto|scroll)/.test(cs.overflowY)) continue; if (el.clientHeight < 250) continue; const ex = el.scrollHeight - el.clientHeight; if (ex > bestH) { bestH = ex; best = el; } }
  const docRatio = document.scrollingElement.scrollHeight / innerHeight;
  const innerRatio = best ? best.scrollHeight / innerHeight : docRatio;
  let words = 0;
  const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walk.nextNode()) {
    const t = walk.currentNode; const txt = t.nodeValue.trim(); if (!txt) continue;
    const el = t.parentElement; if (!el || !vis(el)) continue;
    // A closed fold and a screen-reader label are text nobody sees. Both still report a box here.
    if (hidden(el)) continue;
    if (el.closest('button,a,input,textarea,select,[role=button],[role=tab],nav,label,[class*=rail],[class*=Rail],[class*=message-body],[class*=MessageBody],[class*=bubble],.v2-msg__body,.v2m-mnote .snip,.v2m-jday > span:not(.mo):not(.v2m-mu)')) continue;
    const r = el.getBoundingClientRect(); if (r.left < 70 && innerWidth > 600) continue;
    const [R, G, B] = getComputedStyle(el).color.match(/\d+/g).map(Number);
    const sat = Math.max(R, G, B) - Math.min(R, G, B), avg = (R + G + B) / 3;
    if (sat < 50 && avg > 60 && avg < 200) words += txt.split(/\s+/).filter(x => /[A-Za-z一-鿿]/.test(x)).length;
  }
  return { helperWords: words, innerRatio: +Math.max(innerRatio, docRatio).toFixed(2) };
};

// The byo frame draws the machine start with a machine picked. Opened with no machine, the page shows
// an empty picker and drops a mode card, so it reads fewer words than the frame and could print a HIT.
const BYO_ROUTE = '/v2/agents/byo?mode=machine';
const BYO_NEEDS = { sel: '[data-testid=byo-machine-select] option', why: 'no machine on this account or in D215_FIXTURES, so this is not the state the frame draws' };

// Navigates, opens the panel a surface needs, and measures it. The URL is checked again
// just before measuring, so a redirect that lands after a click cannot be scored either.
async function checkSurface(p, [name, route, opt = {}], vp, targets) {
  const { go, assertLanded, pathOf } = require('./lib');
  const url = route(vp);
  await go(p, url);
  if (opt.list390 && vp === '390') {
    // /v2 may auto-select a pod on a first phone visit. The back control is found by class, not
    // by its translated name, and the pods list itself must be on screen before anything counts.
    if (pathOf(p.url()) !== '/v2') {
      const back = p.locator(opt.list390.back);
      if (!(await back.count())) throw new Error(`${name}-${vp}: /v2 opened a pod and has no ${opt.list390.back} control`);
      await back.first().click(); await p.waitForTimeout(1500);
    }
    assertLanded(url, p.url());
    if (pathOf(p.url()) !== '/v2') throw new Error(`${name}-${vp}: back control left the page on ${pathOf(p.url())}, not /v2`);
    // A failed or still-loading pods request leaves `.v2-pods` up with a message in place of the
    // list, so that state is refused by name before the loaded list is required.
    if (await p.locator(opt.list390.failed).first().isVisible()) throw new Error(`${name}-${vp}: pods did not load (error or spinner in place of ${opt.list390.list})`);
    if (!(await p.locator(opt.list390.list).first().isVisible())) throw new Error(`${name}-${vp}: pods list ${opt.list390.list} is not visible`);
  }
  assertLanded(url, p.url());
  if (opt.needs && !(await p.locator(opt.needs.sel).count())) throw new Error(`${name}-${vp}: ${opt.needs.why}`);
  const B = BUSY[name];
  if (B) {
    if (await p.locator(B.refuse).first().isVisible()) throw new Error(`${name}-${vp}: the page did not load (${B.refuse} on screen in place of rows)`);
    for (const T of B.trim) {
      const n = await p.locator(T.rows).count();
      if (n < T.keep) throw new Error(`${name}-${vp}: ${n} ${T.rows} rows on the page; the busy frame draws ${T.keep}, so this is not the busy state`);
    }
    await p.evaluate(trim => {
      for (const { rows, group, keep } of trim) {
        document.querySelectorAll(rows).forEach((el, i) => { if (i >= keep) el.remove(); });
        if (group) document.querySelectorAll(group).forEach(g => { if (!g.querySelector(rows)) g.remove(); });
      }
    }, B.trim);
  }

  const m = await p.evaluate(METRICS);
  const key = `${name}-${vp}`, t = targets[key];
  return { key, m, t, ok: m.helperWords <= t.helperWords && m.innerRatio <= t.innerRatio };
}

// The phone sidebar is the pods list page (V2Layout `.v2-shell--list`); V2Thread's back arrow leads there.
// V2PodsSidebar renders `.v2-pods__list` only once the pods request succeeds; the spinner and the
// error message are `.v2-pods__empty` outside it (an empty list's own message sits inside it).
const SIDEBAR_390 = {
  back: '.v2-thread__back',
  list: '.v2-shell--list .v2-pods__list',
  failed: '.v2-shell--list .v2-pods__empty:not(.v2-pods__list .v2-pods__empty)',
};

// A busy frame draws a handful of rows; prod draws the account's whole history (Artifacts pages
// 50 files, Activity's Needs you pages itself through every open item: 429 on lily-shen, 11-04).
// For these surfaces the scorer refuses the error line and the spinner, refuses a list shorter
// than the frame (an empty account or the day-zero page), and then measures the frame's row
// count only, the way chat's scroll target is measured with its fold applied. A group left with
// no rows goes too. Keyed by surface name, so a prod surface list cannot drop it.
const BUSY = {
  'artifacts-busy': {
    refuse: '.v2a-state, .v2a-loading',
    trim: [{ rows: '.v2a-file', group: '.v2a-group', keep: 6 }],
  },
  'activity-busy': {
    refuse: '.v2-activity__error, .v2-activity__loading',
    trim: [
      { rows: '.v2-activity__queue > .v2-activity__queue-row', keep: 4 },
      { rows: '.v2-activity__moved-line', group: '.v2-activity__moved-group', keep: 5 },
    ],
  },
};

async function prod(only) {
  const { open } = require('./lib');
  const pod = process.env.D215_POD, agent = process.env.D215_AGENT;
  if (!pod || !agent) throw new Error('D215_POD and D215_AGENT must be set');
  const side = process.env.D215_SIDEBAR_POD || pod;
  const targets = JSON.parse(fs.readFileSync(TARGETS, 'utf8'));
  const SURF = [
    ['settings', () => '/v2/settings'],
    ['agent-settings', () => `/v2/agents/${agent}`],
    ['agent-memory', () => `/v2/agents/${agent}/memory`],
    ['board', () => `/v2/pods/${pod}/board`],
    ['connectors', () => '/v2/connectors'],
    ['byo', () => BYO_ROUTE, { needs: BYO_NEEDS }],
    ['connect', () => '/v2/connect'],
    ['team', () => '/v2/agents'],
    ['activity-busy', () => '/v2/activity'],
    ['artifacts-busy', () => '/v2/artifacts'],
    ['chat', () => `/v2/pods/${pod}`],
    ['sidebar', vp => (vp === '1440' ? `/v2/pods/${side}` : '/v2'), { list390: SIDEBAR_390 }],
  ];
  let miss = 0, checked = 0;
  for (const [vw, vh, mob, vp] of [[1440, 900, false, '1440'], [390, 844, true, '390']]) {
    const { b, p } = await open(vw, vh, mob);
    for (const surface of SURF) {
      if (only && !only.includes(surface[0])) continue;
      const { key, m, t, ok } = await checkSurface(p, surface, vp, targets);
      checked++;
      if (!ok) miss++;
      console.log(key.padEnd(20), `words ${m.helperWords}/${t.helperWords}`.padEnd(16), `scroll ${m.innerRatio}/${t.innerRatio}`.padEnd(20), ok ? 'HIT' : 'MISS');
    }
    await b.close();
  }
  if (!checked) { console.error('no surface was measured'); process.exit(2); }
  const { fixtureUse } = require('./lib');
  for (const [fixture, served] of fixtureUse) console.log(`fixture ${fixture} served ${served}`);
  process.exit(miss ? 1 : 0);
}

module.exports = { BYO_ROUTE, BYO_NEEDS, METRICS, BUSY, parseArgs, validateTargets, unknownFrameError, keyFrames, checkSurface, EXPECTED, SURFACES, SKIPPED, PROD_SURFACES, SIDEBAR_390 };

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv); } catch (e) { console.error(e.message); process.exit(2); }
  (args.mode === 'prod' ? prod(args.only) : artboard()).catch(e => { console.error(e.message); process.exit(2); });
}
