// Route-mocked renders for the D150 helper-text cut (TASK-588).
//
// Usage: node render.mjs --base http://localhost:5173 --label after --out ./renders
//
// Every /api/* call is answered from the fixtures below, so the signed-in BYO
// pages render without a backend and without real pod data. Names are sample
// names only (Alex, Maya, Jo); the token is an unsigned fixture the frontend
// only decodes for its expiry. Nothing here is app code.
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if (a.startsWith('--')) acc.push([a.slice(2), all[i + 1]]);
  return acc;
}, []));
const base = args.base || 'http://localhost:5173';
const label = args.label || 'run';
const outDir = args.out || './renders';
const chromiumPath = process.env.PW_CHROMIUM_PATH || undefined;

const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
// exp must be near-term: the app schedules a refresh at exp - 5min, and a delay
// past setTimeout's ~24.8-day ceiling fires at once and drops the session.
const FIXTURE_EXP = Math.floor(Date.now() / 1000) + 6 * 60 * 60;
const FIXTURE_TOKEN = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({ sub: 'fixture-alex', exp: FIXTURE_EXP })}.`;

const USER = { _id: 'fixture-alex', username: 'alex', displayName: 'Alex', email: 'alex@example.test', role: 'user' };
const POD = { _id: 'fixture-pod', id: 'fixture-pod', name: 'Launch room', type: 'chat', members: ['fixture-alex'], createdBy: 'fixture-alex' };

// Path → JSON. Anything unlisted gets {} so an unexpected call cannot crash the page.
const FIXTURES = [
  [/^\/api\/auth\/user$/, USER],
  [/^\/api\/pods$/, [POD]],
  [/^\/api\/hosted\/availability$/, { configured: true, caps: { agentsPerUser: 1, turnsPerDay: 200 } }],
  [/^\/api\/machines$/, { machines: [] }],
  [/^\/api\/registry\/pods\/[^/]+\/agents$/, { agents: [] }],
  [/^\/api\/registry\/agents\/next-free-name/, { name: 'alex-agent' }],
  [/^\/api\/users\/me\/agent-connection$/, {}],
  [/^\/api\/pods\/fixture-pod$/, POD],
  [/^\/api\/messages\//, []],
  [/^\/api\/posts/, []],
  [/^\/api\/activity\/decision-queue/, []],
  [/^\/api\/pg\/status$/, { ok: true }],
];

const fixtureFor = (path) => {
  const hit = FIXTURES.find(([re]) => re.test(path));
  return hit ? hit[1] : {};
};

const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
];

// Each capture is a route the BYO work touches. The invite modal is opened
// from the pod page; its trigger is resolved by text inside the harness.
const SHOTS = [
  { name: 'byo', path: '/v2/agents/byo' },
  { name: 'byo-hosted', path: '/v2/agents/byo?mode=hosted' },
  { name: 'invite', path: '/v2/pods/fixture-pod', openInvite: true },
];

const run = async () => {
  mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, executablePath: chromiumPath });
  try {
    for (const vp of VIEWPORTS) {
      for (const shot of SHOTS) {
        // The inspector (and its invite control) is not rendered at the 390 width,
        // so the invite modal is captured at 1440 only until a mobile trigger is verified.
        if (shot.openInvite && vp.name === '390') {
          console.log('skip invite at 390: no verified mobile trigger');
          continue;
        }
        const context = await browser.newContext({
          viewport: { width: vp.width, height: vp.height },
          reducedMotion: 'reduce',
          deviceScaleFactor: 1,
        });
        await context.addInitScript((token) => {
          localStorage.setItem('token', token);
        }, FIXTURE_TOKEN);
        const page = await context.newPage();
        // The app calls its API on another origin (localhost:5000 in dev), so every
        // answer carries CORS headers and preflights are answered here.
        const cors = {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
        };
        await page.route('**/api/**', async (route) => {
          if (route.request().method() === 'OPTIONS') {
            await route.fulfill({ status: 204, headers: cors });
            return;
          }
          const url = new URL(route.request().url());
          await route.fulfill({
            status: 200,
            headers: cors,
            contentType: 'application/json',
            body: JSON.stringify(fixtureFor(url.pathname)),
          });
        });
        await page.goto(`${base}${shot.path}`, { waitUntil: 'networkidle' });
        await page.addStyleTag({ content: '*,*::before,*::after{transition:none!important;animation:none!important;caret-color:transparent!important}' });
        if (shot.openInvite) {
          // Opened from the pod inspector's "members" control (V2Inspector onOpenInvite).
          await page.getByRole('button', { name: /^members$/i }).first().click();
        }
        await page.waitForTimeout(400);
        const file = join(outDir, `${label}-${shot.name}-${vp.name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        console.log(`wrote ${file}`);
        await context.close();
      }
    }
  } finally {
    await browser.close();
  }
};

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
