#!/usr/bin/env node
/**
 * ui-interaction-crawler.mjs — discovery crawl over v2 routes (TASK-675, D215-2).
 *
 * For each route × viewport × colour scheme it measures what the D215 artboard measures,
 * clicks every interactive element, and writes one JSON per capture plus a ranked summary.
 *
 * Measured per capture:
 *   helperWords   visible text outside controls, in a grey band (sat < 50, 60 < avg < 200),
 *                 counted the same way cap/measure_after.js counts it.
 *   innerRatio    scrollHeight / clientHeight of the scroller: the target's named `scroller`
 *                 if it has one, else the largest scrollable pane in <main>.
 *   overflowX     document scrollWidth beyond the viewport width.
 *   consoleErrors console `error` messages and uncaught page errors.
 * Clicked per interactive element (button, a[href], [role=button|tab]):
 *   navigated | changed (DOM mutations) | requested (network) | dead (none of the three)
 *   | blocked (the click's request was refused by the read/write policy) | unclickable
 *   | stale (the element at that position is no longer the one listed).
 *   textOnly      a button-like control with transparent background and no border.
 *   skippedClicks candidates past CRAWL_MAX_CLICKS, reported so a short run cannot look complete.
 *
 * Read-only by construction, fail closed:
 *   - every request that is not GET, HEAD or OPTIONS is aborted and counted as `blockedWrites`;
 *   - a GET or HEAD is allowed only when its path is on the SAFE_GET list (or it is a same-origin
 *     app route or asset). Anything else is aborted and counted as `blockedReads`;
 *   - redirects are followed by hand, one hop at a time, and every hop is checked against the same
 *     list, so an allowed GET cannot reach a write endpoint by redirect;
 *   - WebSockets are closed before they reach the server and counted as `blockedSockets`;
 *   - service workers are blocked, because their requests bypass routing.
 *
 * Configuration is environment only. Nothing is hardcoded and no token is logged or written:
 *   CRAWL_BASE_URL     required, e.g. http://localhost:3000
 *   CRAWL_TARGETS      required, path to metrics.json keyed "<routeId>-<width>" with helperWords,
 *                      innerRatio and an optional scroller selector (the D215 artboard format)
 *   CRAWL_TOKEN        optional JWT, set as localStorage.token on the configured origin only
 *   CRAWL_POD_ID       required when a route path contains :podId
 *   CRAWL_ROUTES       optional path to a JSON list of {id, path}; default scripts/ui-crawl-routes.json
 *   CRAWL_VIEWPORTS    optional, default "1440x900,390x844"
 *   CRAWL_SCHEMES      optional, default "light,dark"
 *   CRAWL_OUT          optional output dir, default a fresh temp directory
 *   CRAWL_CHROMIUM     optional path to a chromium binary; unset uses Playwright's own
 *   CRAWL_MAX_CLICKS   optional, default 60 per capture
 *
 * Usage:
 *   CRAWL_BASE_URL=http://localhost:3000 CRAWL_TARGETS=metrics.json CRAWL_TOKEN="$TOKEN" \
 *     node scripts/ui-interaction-crawler.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const env = process.env;

function need(name) {
  if (!env[name]) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return env[name];
}

const BASE = need('CRAWL_BASE_URL').replace(/\/$/, '');
const BASE_ORIGIN = new URL(BASE).origin;
const TOKEN = env.CRAWL_TOKEN || '';
const POD_ID = env.CRAWL_POD_ID || '';
const MAX_CLICKS = Number(env.CRAWL_MAX_CLICKS || 60);
const OUT = env.CRAWL_OUT || mkdtempSync(join(tmpdir(), 'ui-crawl-'));
mkdirSync(OUT, { recursive: true });

const routesFile = env.CRAWL_ROUTES || join(here, 'ui-crawl-routes.json');
const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
if (!POD_ID && routes.some((r) => r.path.includes(':podId'))) {
  console.error('CRAWL_POD_ID is required: a route in the list has a :podId segment');
  process.exit(2);
}

// Targets are the measurement; a run without them would report numbers with nothing to judge them by.
const targetsFile = need('CRAWL_TARGETS');
if (!existsSync(targetsFile)) {
  console.error(`CRAWL_TARGETS=${targetsFile} does not exist`);
  process.exit(2);
}
const targets = JSON.parse(readFileSync(targetsFile, 'utf8'));
if (!targets || Object.keys(targets).length === 0) {
  console.error(`CRAWL_TARGETS=${targetsFile} is empty; refusing to report without targets`);
  process.exit(2);
}
for (const route of routes) {
  for (const width of (env.CRAWL_VIEWPORTS || '1440x900,390x844').split(',').map((v) => v.split('x')[0])) {
    if (!targets[`${route.id}-${width}`]) console.warn(`no target for ${route.id}-${width}; its gaps show as —`);
  }
}
const viewports = (env.CRAWL_VIEWPORTS || '1440x900,390x844').split(',').map((v) => {
  const [width, height] = v.split('x').map(Number);
  return { width, height, label: `${width}` };
});
const schemes = (env.CRAWL_SCHEMES || 'light,dark').split(',');

const launchOptions = { headless: true };
if (env.CRAWL_CHROMIUM) launchOptions.executablePath = env.CRAWL_CHROMIUM;

const CONTROL = 'button, a[href], [role=button], [role=tab]';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// GET paths the crawler may read. Fail closed: a GET not matched here is aborted. Exact entries
// match the whole path; entries ending in '/' match a prefix. Add a path only after checking the
// backend route is a read. Matching is on the lowercased path, because Express routes case-insensitively.
const SAFE_GET_EXACT = [
  '/api/auth/user', '/api/auth/registration-policy', '/api/users/me', '/api/users/me/agent-connection',
  '/api/integrations/user/all', '/api/pods', '/api/installables', '/api/artifacts', '/api/grants',
  '/api/machines', '/api/hosted/status', '/api/hosted/availability', '/api/posts', '/api/apps',
  '/api/skills/catalog', '/api/activity/decision-queue', '/api/activity/decision-history', '/api/activity/recap',
];
const SAFE_GET_PREFIX = [
  '/api/pods/', '/api/v1/tasks/', '/api/messages/', '/api/registry/pods/', '/api/registry/agents/',
  '/api/uploads/', '/api/agent-memory/', '/api/stats/',
];
// Same-origin app routes and static assets. The SPA answers these with HTML or files, never a write.
const APP_PREFIX = ['/v2/', '/assets/', '/static/'];
const MAX_REDIRECT_HOPS = 5;

// A path with an escape or a doubled slash could be routed differently by a proxy; fail closed on it.
function readAllowed(url) {
  const u = new URL(url);
  if (u.origin !== BASE_ORIGIN) return false;
  const path = u.pathname.toLowerCase();
  if (/%|\/\//.test(path)) return false;
  if (path === '/' || APP_PREFIX.some((p) => path.startsWith(p))) return true;
  if (!path.startsWith('/api/')) return false;
  return SAFE_GET_EXACT.includes(path) || SAFE_GET_PREFIX.some((p) => path.startsWith(p));
}

// Throws when a page did not stay on the requested route (a login redirect, say).
function assertLanded(page, url) {
  const landed = new URL(page.url()).pathname;
  const want = new URL(url).pathname;
  if (landed !== want) throw new Error(`redirected to ${landed}; route ${want} not measured`);
}

// The same word rule as cap/measure_after.js: visible, not inside a control, grey band.
const HELPER_WORDS = () => {
  const main = document.querySelector('main') || document.body;
  const skip = 'button,a,input,select,textarea,.rail,.mtab,.mbody,.tip,.seg,.sel';
  let words = 0;
  const sample = [];
  const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const text = node.nodeValue.trim();
    if (!text) continue;
    const el = node.parentElement;
    if (!el || el.closest(skip)) continue;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    if (!(r.width > 0 && r.height > 0) || cs.visibility === 'hidden') continue;
    const [R, G, B] = (cs.color.match(/\d+/g) || [0, 0, 0]).map(Number);
    const sat = Math.max(R, G, B) - Math.min(R, G, B);
    const avg = (R + G + B) / 3;
    if (sat < 50 && avg > 60 && avg < 200) {
      const n = text.split(/\s+/).filter((x) => /[A-Za-z一-鿿]/.test(x)).length;
      words += n;
      if (n && sample.length < 30) sample.push(text.slice(0, 40));
    }
  }
  return { words, sample };
};

const PANE = (selector) => {
  const root = document.querySelector('main') || document.body;
  let best = selector ? document.querySelector(selector) : null;
  if (!best) {
    for (const el of root.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (!/(auto|scroll)/.test(cs.overflowY)) continue;
      if (el.clientHeight === 0) continue;
      if (!best || el.clientHeight > best.clientHeight) best = el;
    }
  }
  const pane = best || document.scrollingElement;
  return {
    scroller: best ? (best.className || best.tagName).toString().slice(0, 60) : 'document',
    scrollHeight: pane.scrollHeight,
    clientHeight: pane.clientHeight,
    ratio: pane.clientHeight ? +(pane.scrollHeight / pane.clientHeight).toFixed(2) : null,
    overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  };
};

// Each candidate keeps its position in the unfiltered querySelectorAll list, which is the list
// page.$$(CONTROL) returns, so the index still points at the same element after filtering.
const CANDIDATES = () => {
  const els = [...document.querySelectorAll('button, a[href], [role=button], [role=tab]')];
  return els
    .map((el, index) => ({ el, index }))
    .filter(({ el }) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    })
    .map(({ el, index }) => {
      const cs = getComputedStyle(el);
      const textOnly = el.tagName === 'BUTTON' || el.getAttribute('role') === 'button'
        ? cs.backgroundColor === 'rgba(0, 0, 0, 0)' && cs.borderTopWidth === '0px'
        : false;
      return {
        index,
        label: (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
        textOnly,
      };
    });
};

// Same text as the label in CANDIDATES. Passed to handle.evaluate, so it must stand alone.
const LABEL_OF = (el) => (el.innerText || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim().slice(0, 60);

async function openPage(browser, viewport, scheme, record) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
  });
  // Every origin and path, not only /api: a click on a form or a link can send a write anywhere.
  await context.route('**/*', async (r) => {
    const method = r.request().method();
    if (method === 'OPTIONS') return r.continue();
    if (!SAFE_METHODS.has(method)) {
      record.blockedWrites += 1;
      return r.abort();
    }
    // Follow redirects by hand so every hop meets the same policy; Chromium would otherwise follow
    // a 3xx straight to a write endpoint without calling this handler.
    let url = r.request().url();
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      if (!readAllowed(url)) {
        record.blockedReads += 1;
        return r.abort();
      }
      const res = await r.fetch({ url, maxRedirects: 0 });
      const location = res.headers().location;
      if (res.status() >= 300 && res.status() < 400 && location) {
        url = new URL(location, url).href;
        continue;
      }
      return r.fulfill({ response: res });
    }
    record.blockedReads += 1;
    return r.abort();
  });
  // Without connectToServer the page's socket never reaches the server; the page just sees it closed.
  await context.routeWebSocket(/.*/, (ws) => {
    record.blockedSockets += 1;
    ws.close();
  });
  if (TOKEN) {
    // addInitScript also runs in cross-origin child frames, so the token goes to the configured origin only.
    await context.addInitScript(({ t, origin }) => {
      if (location.origin !== origin) return;
      if (!localStorage.getItem('token')) localStorage.setItem('token', t);
    }, { t: TOKEN, origin: BASE_ORIGIN });
  }
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') record.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => record.consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { context, page };
}

async function settle(page, url) {
  // A failed or 4xx navigation throws, so the capture records it instead of measuring a broken page.
  const res = await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} for ${url}`);
  // Idle is best effort: a page that polls never goes idle, and that is not a failed navigation.
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function crawlCapture(browser, route, viewport, scheme) {
  const path = route.path.replace(':podId', POD_ID);
  const url = BASE + path;
  const record = {
    routeId: route.id, url, viewport: viewport.label, scheme, maxClicks: MAX_CLICKS,
    blockedWrites: 0, blockedReads: 0, blockedSockets: 0, consoleErrors: [], clicks: [], candidateCount: null, skippedClicks: null,
    helperWords: null, scroll: null, target: null, error: null,
  };
  const { context, page } = await openPage(browser, viewport, scheme, record);
  try {
    await settle(page, url);
    // A protected route that redirects (to /v2/login, say) must not be measured as the route.
    assertLanded(page, url);

    const measured = await page.evaluate(HELPER_WORDS);
    record.helperWords = measured.words;
    record.helperSample = measured.sample;
    const target = targets[`${route.id}-${viewport.label}`] || {};
    record.target = target;
    record.scroll = await page.evaluate(PANE, target.scroller || null);
    await page.screenshot({ path: join(OUT, `${route.id}-${viewport.label}-${scheme}.png`) });

    const candidates = await page.evaluate(CANDIDATES);
    const slice = candidates.slice(0, MAX_CLICKS);
    record.candidateCount = candidates.length;
    record.skippedClicks = candidates.length - slice.length;
    for (const cand of slice) {
      const before = page.url();
      await page.evaluate(() => {
        window.__mut = 0;
        if (!window.__obs) {
          window.__obs = new MutationObserver((list) => { window.__mut += list.length; });
          window.__obs.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
        }
      });
      let requests = 0;
      const onRequest = () => { requests += 1; };
      page.on('request', onRequest);
      const handles = await page.$$(CONTROL);
      const handle = handles[cand.index];
      const current = handle ? await handle.evaluate(LABEL_OF).catch(() => null) : null;
      let outcome = 'dead';
      if (!handle || current !== cand.label) {
        // The DOM moved since the candidate list was read; clicking now would hit the wrong control.
        outcome = 'stale';
      } else {
        let clicked = true;
        const blockedBefore = record.blockedWrites + record.blockedReads;
        await handle.click({ timeout: 2000 }).catch(() => { clicked = false; });
        await page.waitForTimeout(400);
        const mut = await page.evaluate(() => window.__mut || 0);
        // A click whose request the policy refused is reported as blocked, whatever else it did.
        if (record.blockedWrites + record.blockedReads > blockedBefore) outcome = 'blocked';
        else if (!clicked) outcome = 'unclickable';
        else if (page.url() !== before) outcome = 'navigated';
        else if (mut > 0) outcome = 'changed';
        else if (requests > 0) outcome = 'requested';
      }
      page.off('request', onRequest);
      record.clicks.push({ label: cand.label, textOnly: cand.textOnly, outcome });
      if (outcome === 'navigated' || outcome === 'blocked') {
        // A refused navigation can leave an error page behind, so reload the route before the next candidate.
        // The session can also expire mid-capture; a later candidate must not run on the login page.
        await settle(page, url);
        assertLanded(page, url);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
  } catch (err) {
    record.error = String(err && err.message ? err.message : err).slice(0, 200);
  } finally {
    await context.close();
  }
  const file = join(OUT, `${route.id}-${viewport.label}-${scheme}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return record;
}

function gaps(records) {
  const rows = [];
  for (const r of records) {
    const t = r.target || {};
    const count = (outcome) => r.clicks.filter((c) => c.outcome === outcome).length;
    rows.push({
      routeId: r.routeId, viewport: r.viewport, scheme: r.scheme,
      dead: count('dead'), stale: count('stale'),
      textOnly: r.clicks.filter((c) => c.textOnly).length,
      skippedClicks: r.skippedClicks,
      blockedWrites: r.blockedWrites,
      blockedReads: r.blockedReads,
      blockedSockets: r.blockedSockets,
      // distinct messages: a reload after a navigating click repeats the same error
      consoleErrors: new Set(r.consoleErrors).size,
      overflowX: r.scroll ? r.scroll.overflowX : null,
      helperWords: r.helperWords,
      helperTarget: t.helperWords ?? null,
      scrollRatio: r.scroll ? r.scroll.ratio : null,
      scrollTarget: t.innerRatio ?? null,
      error: r.error,
    });
  }
  return rows;
}

const browser = await chromium.launch(launchOptions);
const records = [];
try {
  for (const route of routes) {
    for (const viewport of viewports) {
      for (const scheme of schemes) {
        const rec = await crawlCapture(browser, route, viewport, scheme);
        records.push(rec);
        console.log(`${route.id} ${viewport.label} ${scheme}: clicks=${rec.clicks.length} error=${rec.error ? 'yes' : 'no'}`);
      }
    }
  }
} finally {
  await browser.close();
}

const summary = gaps(records);
writeFileSync(join(OUT, 'summary.json'), JSON.stringify(summary, null, 2));
const ranked = [...summary].sort((a, b) => (b.dead + b.consoleErrors + b.textOnly) - (a.dead + a.consoleErrors + a.textOnly));
writeFileSync(join(OUT, 'summary.md'), [
  '| route | viewport | scheme | dead clicks | text-only | skipped | stale | blocked writes | blocked reads | blocked sockets | console errors | overflow-x | helper words (target) | scroll ratio (target) | error |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...ranked.map((r) => `| ${r.routeId} | ${r.viewport} | ${r.scheme} | ${r.dead} | ${r.textOnly} | ${r.skippedClicks} | ${r.stale} | ${r.blockedWrites} | ${r.blockedReads} | ${r.blockedSockets} | ${r.consoleErrors} | ${r.overflowX} | ${r.helperWords} (${r.helperTarget ?? '—'}) | ${r.scrollRatio} (${r.scrollTarget ?? '—'}) | ${r.error ?? ''} |`),
].join('\n') + '\n');
const failed = records.filter((r) => r.error).length;
// A run with errored captures is not evidence; exit non-zero so nobody reads it as a clean run.
if (failed) process.exitCode = 1;
console.log(`wrote ${records.length} captures to ${resolve(OUT)}; ${failed} with errors`);
