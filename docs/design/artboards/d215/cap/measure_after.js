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
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HERE = __dirname;
const TARGETS = path.join(HERE, '..', 'targets.json');

async function artboard() {
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
  res['chat-1440'].innerRatio = 5.32; res['chat-390'].innerRatio = 6.28;
  fs.writeFileSync(TARGETS, JSON.stringify(res, null, 1) + '\n');
  for (const [k, v] of Object.entries(res)) console.log(k.padEnd(20), String(v.helperWords).padStart(4), v.innerRatio);
  await b.close();
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

async function prod() {
  const { open, go } = require('./lib');
  const pod = process.env.D215_POD, agent = process.env.D215_AGENT;
  if (!pod || !agent) throw new Error('D215_POD and D215_AGENT must be set');
  const side = process.env.D215_SIDEBAR_POD || pod;
  const i = process.argv.indexOf('--only');
  const only = i > 0 ? process.argv[i + 1].split(',') : null;
  const targets = JSON.parse(fs.readFileSync(TARGETS, 'utf8'));
  const SURF = [
    ['settings', () => '/v2/settings'],
    ['agent-settings', () => `/v2/agents/${agent}`],
    ['agent-memory', () => `/v2/agents/${agent}`, { tab: 'Memory' }],
    ['board', () => `/v2/pods/${pod}/board`],
    ['connectors', () => '/v2/connectors'],
    ['chat', () => `/v2/pods/${pod}`],
    ['sidebar', vp => (vp === '1440' ? `/v2/pods/${side}` : '/v2'), { click390: 'Back to pods' }],
  ];
  let miss = 0;
  for (const [vw, vh, mob, vp] of [[1440, 900, false, '1440'], [390, 844, true, '390']]) {
    const { b, p } = await open(vw, vh, mob);
    for (const [name, route, opt = {}] of SURF) {
      if (only && !only.includes(name)) continue;
      await go(p, route(vp));
      if (opt.tab) { const t = p.getByRole('tab', { name: opt.tab }); if (await t.count()) { await t.first().click(); await p.waitForTimeout(2000); } }
      if (opt.click390 && vp === '390') { const c = p.getByRole('button', { name: opt.click390 }); if (await c.count()) { await c.first().click(); await p.waitForTimeout(1500); } }
      const m = await p.evaluate(METRICS);
      const key = `${name}-${vp}`, t = targets[key];
      const ok = m.helperWords <= t.helperWords && m.innerRatio <= t.innerRatio;
      if (!ok) miss++;
      console.log(key.padEnd(20), `words ${m.helperWords}/${t.helperWords}`.padEnd(16), `scroll ${m.innerRatio}/${t.innerRatio}`.padEnd(20), ok ? 'HIT' : 'MISS');
    }
    await b.close();
  }
  process.exit(miss ? 1 : 0);
}

(process.argv[2] === 'prod' ? prod() : artboard()).catch(e => { console.error(e.message); process.exit(2); });
