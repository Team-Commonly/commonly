// D215 helper-word and scroll measurements.
//
//   node measure_after.js            measure the artboard (../index.html) and write ../targets.json
//   node measure_after.js prod       measure the live routes and check them against ../targets.json
//
// prod mode signs in through lib.js (COMMONLY_TOKEN, COMMONLY_URL) and needs:
//   D215_POD          id of a pod with a long chat history and a busy board
//   D215_AGENT        agent route segment, e.g. "<name>/default"
//   D215_SIDEBAR_POD  optional; pod opened for the 1440 sidebar shot (defaults to D215_POD)
//   --only a,b        optional; limit to these surfaces (chat, board, settings, ...)
// It exits 1 when any surface misses its target. It prints counts only, never page text.
//
// Helper words = grey text (saturation < 50, mean channel 60-200) outside controls and the
// nav rail. Scroll = the main scroller's height / viewport height.
const path = require('path');
const fs = require('fs');

const HERE = __dirname;
const TARGETS = path.join(HERE, '..', 'targets.json');

const SURFACES = ['settings', 'agent-settings', 'agent-memory', 'board', 'connectors', 'chat', 'sidebar', 'byo', 'byo-handoff'];
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
  const bad = only.filter(x => !SURFACES.includes(x));
  if (!only.length) throw new Error('--only names no surface');
  if (bad.length) throw new Error(`unknown surface: ${bad.join(', ')}; known: ${SURFACES.join(', ')}`);
  return { mode: 'prod', only };
}

// Every expected surface-viewport key must carry two finite numbers before targets.json is replaced.
function validateTargets(res) {
  const missing = EXPECTED.filter(k => !res[k]);
  const extra = Object.keys(res).filter(k => !EXPECTED.includes(k));
  const invalid = EXPECTED.filter(k => res[k] && !(Number.isFinite(res[k].helperWords) && Number.isFinite(res[k].innerRatio) && res[k].innerRatio >= 1));
  const problems = [];
  if (missing.length) problems.push(`missing ${missing.join(', ')}`);
  if (extra.length) problems.push(`unexpected ${extra.join(', ')}`);
  if (invalid.length) problems.push(`invalid ${invalid.join(', ')}`);
  if (problems.length) throw new Error(`artboard measurement incomplete (${problems.join('; ')}); targets.json left unchanged`);
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
  const res = await p.evaluate(() => {
    const out = {};
    document.querySelectorAll('.frame').forEach(f => {
      const app = f.querySelector('.app'); f.style.setProperty('--s', 1); f.style.overflow = 'visible'; f.style.aspectRatio = 'auto'; f.style.height = app.offsetHeight + 'px'; f.style.width = app.offsetWidth + 'px'; f.style.maxWidth = 'none';
      let words = 0;
      const w = document.createTreeWalker(app, NodeFilter.SHOW_TEXT);
      while (w.nextNode()) {
        const t = w.currentNode, txt = t.nodeValue.trim(); if (!txt) continue;
        const el = t.parentElement; const r = el.getBoundingClientRect(); const cs = getComputedStyle(el);
        if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden') continue;
        if (el.closest('button,a,input,.rail,.mtab,.mbody,.tip,.seg,.sel')) continue;
        const ar = app.getBoundingClientRect(); if (r.top > ar.bottom || r.bottom < ar.top) continue;
        const [R, G, B] = cs.color.match(/\d+/g).map(Number); const sat = Math.max(R, G, B) - Math.min(R, G, B), avg = (R + G + B) / 3;
        if (sat < 50 && avg > 60 && avg < 200) words += txt.split(/\s+/).filter(x => /[A-Za-z一-鿿]/.test(x)).length;
      }
      let ratio = 1; app.querySelectorAll('.pbody,.mbody2').forEach(s => { ratio = Math.max(ratio, (s.scrollHeight + (app.offsetHeight - s.clientHeight)) / app.offsetHeight); });
      out[f.dataset.surface + '-' + f.dataset.vp] = { helperWords: words, innerRatio: +ratio.toFixed(2) };
    });
    return out;
  });
  // The chat mock is a short excerpt, so its scroll target was measured on prod history with
  // the six-line fold and claim-row collapse applied to the live DOM.
  if (res['chat-1440']) res['chat-1440'].innerRatio = 5.32;
  if (res['chat-390']) res['chat-390'].innerRatio = 6.28;
  await b.close();
  validateTargets(res);
  fs.writeFileSync(TARGETS, JSON.stringify(res, null, 1) + '\n');
  for (const [k, v] of Object.entries(res)) console.log(k.padEnd(20), String(v.helperWords).padStart(4), v.innerRatio);
}

// Same counter that produced the before numbers on prod.
const METRICS = () => {
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
    if (el.closest('button,a,input,textarea,select,[role=button],[role=tab],nav,label,[class*=rail],[class*=Rail],[class*=message-body],[class*=MessageBody],[class*=bubble],.v2-msg__body')) continue;
    const r = el.getBoundingClientRect(); if (r.left < 70 && innerWidth > 600) continue;
    const [R, G, B] = getComputedStyle(el).color.match(/\d+/g).map(Number);
    const sat = Math.max(R, G, B) - Math.min(R, G, B), avg = (R + G + B) / 3;
    if (sat < 50 && avg > 60 && avg < 200) words += txt.split(/\s+/).filter(x => /[A-Za-z一-鿿]/.test(x)).length;
  }
  return { helperWords: words, innerRatio: +Math.max(innerRatio, docRatio).toFixed(2) };
};

// Navigates, opens the tab or panel a surface needs, and measures it. The URL is checked again
// just before measuring, so a redirect that lands after a click cannot be scored either.
async function checkSurface(p, [name, route, opt = {}], vp, targets) {
  const { go, assertLanded, pathOf } = require('./lib');
  const url = route(vp);
  await go(p, url);
  if (opt.tab) {
    const t = p.getByRole('tab', { name: opt.tab });
    if (!(await t.count())) throw new Error(`${name}-${vp}: no "${opt.tab}" tab on ${url}`);
    await t.first().click(); await p.waitForTimeout(2000);
  }
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

async function prod(only) {
  const { open } = require('./lib');
  const pod = process.env.D215_POD, agent = process.env.D215_AGENT;
  if (!pod || !agent) throw new Error('D215_POD and D215_AGENT must be set');
  const side = process.env.D215_SIDEBAR_POD || pod;
  const targets = JSON.parse(fs.readFileSync(TARGETS, 'utf8'));
  const SURF = [
    ['settings', () => '/v2/settings'],
    ['agent-settings', () => `/v2/agents/${agent}`],
    ['agent-memory', () => `/v2/agents/${agent}`, { tab: 'Memory' }],
    ['board', () => `/v2/pods/${pod}/board`],
    ['connectors', () => '/v2/connectors'],
    ['byo', () => '/v2/agents/byo'],
    ['chat', () => `/v2/pods/${pod}`],
    ['sidebar', vp => (vp === '1440' ? `/v2/pods/${side}` : '/v2'), { list390: SIDEBAR_390 }],
  ];
  let miss = 0;
  for (const [vw, vh, mob, vp] of [[1440, 900, false, '1440'], [390, 844, true, '390']]) {
    const { b, p } = await open(vw, vh, mob);
    for (const surface of SURF) {
      if (only && !only.includes(surface[0])) continue;
      const { key, m, t, ok } = await checkSurface(p, surface, vp, targets);
      if (!ok) miss++;
      console.log(key.padEnd(20), `words ${m.helperWords}/${t.helperWords}`.padEnd(16), `scroll ${m.innerRatio}/${t.innerRatio}`.padEnd(20), ok ? 'HIT' : 'MISS');
    }
    await b.close();
  }
  process.exit(miss ? 1 : 0);
}

module.exports = { parseArgs, validateTargets, checkSurface, EXPECTED, SURFACES, SIDEBAR_390 };

if (require.main === module) {
  let args;
  try { args = parseArgs(process.argv); } catch (e) { console.error(e.message); process.exit(2); }
  (args.mode === 'prod' ? prod(args.only) : artboard()).catch(e => { console.error(e.message); process.exit(2); });
}
