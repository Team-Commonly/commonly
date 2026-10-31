// Shared Playwright session for the D215 measuring scripts.
// COMMONLY_TOKEN (required): a session token for the account to measure as. Read from env only; never logged.
// COMMONLY_URL (optional): instance origin, default https://commonly.me.
// PLAYWRIGHT_CHROMIUM (optional): a chromium executable; default is Playwright's bundled browser.
// Every non-GET /api request is aborted, so a measuring run cannot change state.
const { chromium } = require('playwright');

const BASE = (process.env.COMMONLY_URL || 'https://commonly.me').replace(/\/$/, '');

async function open(w = 1440, h = 900, mobile = false) {
  const token = process.env.COMMONLY_TOKEN;
  if (!token) throw new Error('COMMONLY_TOKEN is not set');
  const launch = { headless: true };
  if (process.env.PLAYWRIGHT_CHROMIUM) launch.executablePath = process.env.PLAYWRIGHT_CHROMIUM;
  const b = await chromium.launch(launch);
  const ctx = await b.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: 'light', isMobile: mobile, hasTouch: mobile });
  await ctx.route('**/api/**', r => { const m = r.request().method(); if (m === 'GET' || m === 'OPTIONS') return r.continue(); return r.abort(); });
  const p = await ctx.newPage();
  await p.goto(BASE + '/v2', { waitUntil: 'domcontentloaded' });
  await p.evaluate(t => localStorage.setItem('token', t), token);
  return { b, p };
}

// A failed navigation throws, so a check never measures the page it was meant to leave.
async function go(p, route) {
  let res;
  try {
    res = await p.goto(BASE + route, { waitUntil: 'networkidle', timeout: 30000 });
  } catch (e) {
    throw new Error(`navigation to ${route} failed: ${e.message.split('\n')[0]}`);
  }
  if (res && !res.ok()) throw new Error(`navigation to ${route} returned HTTP ${res.status()}`);
  await p.waitForTimeout(2500);
}

module.exports = { open, go, BASE };
