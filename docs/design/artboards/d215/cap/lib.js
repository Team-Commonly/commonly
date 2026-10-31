// Shared Playwright session for the D215 measuring scripts.
// COMMONLY_TOKEN (required): a session token for the account to measure as. Read from env only; never logged.
// COMMONLY_URL (optional): instance origin, default https://commonly.me.
// PLAYWRIGHT_CHROMIUM (optional): a chromium executable; default is Playwright's bundled browser.
// Every non-GET /api request is aborted, so a measuring run cannot change state.

const BASE = (process.env.COMMONLY_URL || 'https://commonly.me').replace(/\/$/, '');

async function open(w = 1440, h = 900, mobile = false) {
  const token = process.env.COMMONLY_TOKEN;
  if (!token) throw new Error('COMMONLY_TOKEN is not set');
  const { chromium } = require('playwright');
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

// Paths the app sends a signed-out visitor to. Landing on one means the token was refused.
const SIGNED_OUT = new Set(['/', '/v2/login', '/v2/register', '/v2/register/invite-required', '/v2/forgot-password']);
// Redirects a signed-in visitor can legitimately get: /v2 auto-selects a pod.
const ALLOWED_REDIRECT = { '/v2': /^\/v2\/pods\/[^/]+$/ };

const pathOf = url => new URL(url, BASE).pathname.replace(/(.)\/+$/, '$1');

// Throws unless the page sits on the route it was sent to. A rejected token passes res.ok()
// (the SPA shell is a 200) and then redirects client-side, so the status alone proves nothing.
function assertLanded(route, finalUrl) {
  const want = pathOf(route), got = pathOf(finalUrl);
  if (SIGNED_OUT.has(got)) throw new Error(`navigation to ${route} ended signed out on ${got}; check COMMONLY_TOKEN`);
  if (got === want || (ALLOWED_REDIRECT[want] && ALLOWED_REDIRECT[want].test(got))) return;
  throw new Error(`navigation to ${route} was redirected to ${got}`);
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
  assertLanded(route, p.url());
}

module.exports = { open, go, assertLanded, pathOf, BASE };
