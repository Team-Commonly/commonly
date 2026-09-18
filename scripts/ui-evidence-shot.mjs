#!/usr/bin/env node
/**
 * ui-evidence-shot.mjs — render one v2 route in a real browser and write evidence.
 *
 * Writes a full-page PNG **and** a `.txt` of `document.body.innerText` beside it.
 * The text dump is the evidence a reviewer can diff and quote; a text-only agent
 * cannot read the PNG at all. Prints the text length, its sha1, every non-2xx
 * response and every console error, so a blank page or a CORS block names itself
 * instead of looking like a layout bug.
 *
 * `--selector` narrows the capture to one element, scrolled into view first.
 * `fullPage` is not enough for content inside an inner scroller: it captures the
 * whole document, but a panel with its own `overflow` is still clipped to its own
 * box, so the interesting row sits below the fold of that box and the capture is of
 * the panel's first screenful. A capture that cannot name what it shows is the
 * reason `--selector` exists. With a selector the PNG is that element's box and an
 * extra `<out>.selector.txt` holds the element's own innerText; the page dump and a
 * `<out>.page.png` full-page shot are still written, so the scoped shot keeps its
 * context.
 *
 * See docs/runbooks/local-ui-render-harness.md for the stack this expects.
 *
 * Usage:
 *   node scripts/ui-evidence-shot.mjs --route /v2/pods/team/<podId> --out /tmp/after.png \
 *     [--selector '.tools-trail'] \
 *     [--base-url http://localhost:3000] [--api http://localhost:5050] \
 *     [--email dev@commonly.local] [--password password123] [--wait 2500]
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const parseArgs = (argv) => {
  const out = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) {
      out.set(key, inline);
    } else if (argv[i + 1] && !argv[i + 1].startsWith('--')) {
      out.set(key, argv[i + 1]);
      i += 1;
    } else {
      out.set(key, 'true');
    }
  }
  return out;
};

const args = parseArgs(process.argv.slice(2));
const route = args.get('route');
const outPath = args.get('out');
if (!route || !outPath) {
  console.error('usage: node scripts/ui-evidence-shot.mjs --route <path> --out <file.png> [--base-url URL] [--api URL]');
  process.exit(2);
}

const baseUrl = (args.get('base-url') || process.env.UI_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const apiBase = (args.get('api') || process.env.UI_API_URL || 'http://localhost:5050').replace(/\/$/, '');
const email = args.get('email') || process.env.UI_EMAIL || 'dev@commonly.local';
const password = args.get('password') || process.env.UI_PASSWORD || 'password123';
const waitMs = Number(args.get('wait') || 2500);
const selector = args.get('selector');
const basePath = outPath.replace(/\.png$/, '');
const textPath = `${basePath}.txt`;
const selectorTextPath = selector ? `${basePath}.selector.txt` : null;
const pagePath = selector ? `${basePath}.page.png` : null;

const login = async () => {
  const res = await fetch(`${apiBase}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  const body = await res.json().catch(() => ({}));
  const token = body.token || body?.data?.token;
  if (!token) {
    throw new Error(`login failed (${res.status}) at ${apiBase}: ${JSON.stringify(body).slice(0, 200)}`);
  }
  return token;
};

const main = async () => {
  const token = await login();
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  // The shell reads the JWT from localStorage; injecting it before the first
  // paint skips the login page (and its flake) entirely.
  await context.addInitScript((value) => {
    try { localStorage.setItem('token', value); } catch (_err) { /* storage unavailable */ }
  }, token);

  const page = await context.newPage();
  const badResponses = [];
  const consoleErrors = [];
  page.on('response', (res) => {
    if (res.status() >= 400) badResponses.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 200)); });

  await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 45000 });
  await page.waitForTimeout(waitMs);

  let selectorChars = null;
  if (selector) {
    const target = page.locator(selector).first();
    // Throws with the selector named if it never appears, rather than writing a
    // screenshot of whatever happened to be on screen.
    await target.waitFor({ state: 'visible', timeout: 15000 });
    // scrollIntoViewIfNeeded walks ancestor scrollers too, which is the whole
    // point: an element inside a panel's own overflow is otherwise captured out of view.
    await target.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await target.screenshot({ path: outPath });
    const scopeText = await target.evaluate((el) => el.innerText || '');
    writeFileSync(selectorTextPath, scopeText);
    selectorChars = scopeText.length;
    // Context beside the scoped shot: what the scoped element sits inside.
    await page.screenshot({ path: pagePath, fullPage: true });
  } else {
    await page.screenshot({ path: outPath, fullPage: true });
  }
  const text = await page.evaluate(() => (document.body && document.body.innerText) || '');
  writeFileSync(textPath, text);

  const sha = createHash('sha1').update(text).digest('hex').slice(0, 12);
  console.log(`${outPath} | page ${text.length}ch innerText sha1=${sha}${selectorChars === null ? '' : ` | ${selector} ${selectorChars}ch`}`);
  console.log(`  text: ${textPath}`);
  if (selector) console.log(`  selector text: ${selectorTextPath}`);
  console.log(`  non-2xx: ${badResponses.length ? [...new Set(badResponses)].join(' | ') : 'none'}`);
  console.log(`  console errors: ${consoleErrors.length ? [...new Set(consoleErrors)].join(' | ') : 'none'}`);
  if (consoleErrors.length || badResponses.length) {
    console.log('  (a 4xx here is often the harness: check FRONTEND_URL covers this origin, and that the viewer is a pod member)');
  }
  await browser.close();
};

main().catch((err) => {
  console.error(`FAIL ${err.message}`);
  process.exit(1);
});
