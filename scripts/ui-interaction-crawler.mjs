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
 *   navigated | changed (DOM mutations) | requested (network) | dead (none of the three).
 *   textOnly      a button-like control with transparent background and no border.
 *
 * Read-only by construction: every non-GET /api request is aborted and counted as
 * `blockedWrites`, so a click that would write is visible in the report but never lands.
 *
 * Configuration is environment only. Nothing is hardcoded and no token is logged or written:
 *   CRAWL_BASE_URL     required, e.g. http://localhost:3000
 *   CRAWL_TOKEN        optional JWT, set as localStorage.token before each load
 *   CRAWL_ROUTES       optional path to a JSON list of {id, path}; default scripts/ui-crawl-routes.json
 *   CRAWL_POD_ID       optional, substituted for :podId in route paths
 *   CRAWL_TARGETS      optional path to metrics.json, keyed "<routeId>-<width>" with helperWords,
 *                      innerRatio and an optional scroller selector (the D215 artboard format)
 *   CRAWL_VIEWPORTS    optional, default "1440x900,390x844"
 *   CRAWL_SCHEMES      optional, default "light,dark"
 *   CRAWL_OUT          optional output dir, default a fresh temp directory
 *   CRAWL_CHROMIUM     optional path to a chromium binary; unset uses Playwright's own
 *   CRAWL_MAX_CLICKS   optional, default 60 per capture
 *
 * Usage:
 *   CRAWL_BASE_URL=http://localhost:3000 CRAWL_TOKEN="$TOKEN" node scripts/ui-interaction-crawler.mjs
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
const TOKEN = env.CRAWL_TOKEN || '';
const POD_ID = env.CRAWL_POD_ID || '';
const MAX_CLICKS = Number(env.CRAWL_MAX_CLICKS || 60);
const OUT = env.CRAWL_OUT || mkdtempSync(join(tmpdir(), 'ui-crawl-'));
mkdirSync(OUT, { recursive: true });

const routesFile = env.CRAWL_ROUTES || join(here, 'ui-crawl-routes.json');
const routes = JSON.parse(readFileSync(routesFile, 'utf8'));
const targets = env.CRAWL_TARGETS && existsSync(env.CRAWL_TARGETS)
  ? JSON.parse(readFileSync(env.CRAWL_TARGETS, 'utf8'))
  : {};
if (env.CRAWL_TARGETS && Object.keys(targets).length === 0) {
  console.error(`CRAWL_TARGETS=${env.CRAWL_TARGETS} is missing or empty; reporting without targets`);
}
const viewports = (env.CRAWL_VIEWPORTS || '1440x900,390x844').split(',').map((v) => {
  const [width, height] = v.split('x').map(Number);
  return { width, height, label: `${width}` };
});
const schemes = (env.CRAWL_SCHEMES || 'light,dark').split(',');

const launchOptions = { headless: true };
if (env.CRAWL_CHROMIUM) launchOptions.executablePath = env.CRAWL_CHROMIUM;

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

const CANDIDATES = () => {
  const els = [...document.querySelectorAll('button, a[href], [role=button], [role=tab]')];
  return els
    .filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && !el.disabled;
    })
    .map((el, index) => {
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

async function openPage(browser, viewport, scheme, record) {
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    colorScheme: scheme,
    deviceScaleFactor: 1,
  });
  await context.route('**/api/**', (r) => {
    const m = r.request().method();
    if (m === 'GET' || m === 'OPTIONS') return r.continue();
    record.blockedWrites += 1;
    return r.abort();
  });
  if (TOKEN) {
    await context.addInitScript((t) => {
      if (!localStorage.getItem('token')) localStorage.setItem('token', t);
    }, TOKEN);
  }
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error') record.consoleErrors.push(m.text().slice(0, 200)); });
  page.on('pageerror', (e) => record.consoleErrors.push(`pageerror: ${e.message.slice(0, 200)}`));
  return { context, page };
}

async function settle(page, url) {
  await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(1500);
}

async function crawlCapture(browser, route, viewport, scheme) {
  const url = BASE + route.path.replace(':podId', POD_ID);
  const record = {
    routeId: route.id, url, viewport: viewport.label, scheme,
    blockedWrites: 0, consoleErrors: [], clicks: [], helperWords: null, scroll: null, target: null, error: null,
  };
  const { context, page } = await openPage(browser, viewport, scheme, record);
  try {
    await settle(page, url);
    const measured = await page.evaluate(HELPER_WORDS);
    record.helperWords = measured.words;
    record.helperSample = measured.sample;
    const target = targets[`${route.id}-${viewport.label}`] || {};
    record.target = target;
    record.scroll = await page.evaluate(PANE, target.scroller || null);
    await page.screenshot({ path: join(OUT, `${route.id}-${viewport.label}-${scheme}.png`) });

    const candidates = await page.evaluate(CANDIDATES);
    const slice = candidates.slice(0, MAX_CLICKS);
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
      const handles = await page.$$('button, a[href], [role=button], [role=tab]');
      const handle = handles[cand.index];
      let outcome = 'dead';
      if (handle) {
        await handle.click({ timeout: 2000, trial: false }).catch(() => { outcome = 'unclickable'; });
        await page.waitForTimeout(400);
        const mut = await page.evaluate(() => window.__mut || 0);
        if (page.url() !== before) outcome = 'navigated';
        else if (mut > 0) outcome = 'changed';
        else if (requests > 0) outcome = 'requested';
      }
      page.off('request', onRequest);
      record.clicks.push({ label: cand.label, textOnly: cand.textOnly, outcome });
      if (outcome === 'navigated') {
        await settle(page, url);
      } else {
        await page.keyboard.press('Escape').catch(() => {});
      }
    }
    record.candidateCount = candidates.length;
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
    const dead = r.clicks.filter((c) => c.outcome === 'dead').length;
    const textOnly = r.clicks.filter((c) => c.textOnly).length;
    rows.push({
      routeId: r.routeId, viewport: r.viewport, scheme: r.scheme,
      dead, textOnly,
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
  '| route | viewport | scheme | dead clicks | text-only | console errors | overflow-x | helper words (target) | scroll ratio (target) | error |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...ranked.map((r) => `| ${r.routeId} | ${r.viewport} | ${r.scheme} | ${r.dead} | ${r.textOnly} | ${r.consoleErrors} | ${r.overflowX} | ${r.helperWords} (${r.helperTarget ?? '—'}) | ${r.scrollRatio} (${r.scrollTarget ?? '—'}) | ${r.error ?? ''} |`),
].join('\n') + '\n');
console.log(`wrote ${records.length} captures to ${resolve(OUT)}`);
