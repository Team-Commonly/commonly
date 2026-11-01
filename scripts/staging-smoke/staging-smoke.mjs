#!/usr/bin/env node
// Tier-1 staging smoke — fast, gates prod promotion. Run after a deploy-staging rollout.
// Env: SMOKE_BASE (default https://staging.commonly.me), SMOKE_API (default https://api-staging.commonly.me),
//      SMOKE_EMAIL + SMOKE_PW (non-admin test creds; from a 0600 file / CI secrets, NEVER printed),
//      SMOKE_HOSTED=1 to also check a hosted-agent reply (skip until staging has an LLM key).
// Exit 0 = all green; non-zero = a blocking check failed (caller must block prod promotion).
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'https://staging.commonly.me';
const API  = process.env.SMOKE_API  || 'https://api-staging.commonly.me';
const EMAIL = process.env.SMOKE_EMAIL, PW = process.env.SMOKE_PW;
const CHECK_HOSTED = process.env.SMOKE_HOSTED === '1';
const UA = { 'User-Agent': 'commonly-smoke/0.1' };
const CONSOLE_ALLOW = [/favicon/i, /manifest\.json/i, /\/api\/pg\/status/i, /ResizeObserver loop/i, /Download the React DevTools/i];

const results = [];
const rec = (name, ok, detail='') => { results.push({ name, ok }); console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?'  — '+detail:''}`); };
const norm = p => (p || '').replace(/\/+$/,'') || '/';

async function api(path, opts={}) {
  const r = await fetch(`${API}${path}`, { ...opts, headers: { ...UA, ...(opts.headers||{}) } });
  let body = null; try { body = await r.json(); } catch {}
  return { status: r.status, body };
}

async function main() {
  // 1) health/ready
  try { const r = await fetch(`${API}/api/health/ready`, { headers: UA }); rec('health/ready 200', r.status === 200, `status ${r.status}`); }
  catch (e) { rec('health/ready 200', false, e.message); }

  // 2) login -> token
  let token = null;
  try {
    const { status, body } = await api('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: EMAIL, password: PW }) });
    token = body?.token || body?.accessToken || null;
    rec('non-admin login', status === 200 && !!token, `status ${status}`);
  } catch (e) { rec('non-admin login', false, e.message); }
  const authH = token ? { Authorization: `Bearer ${token}` } : {};

  // 3) resolve a real pod id (so /v2/pods/<id> is a true route, not the path="*" redirect to /v2)
  let podId = null;
  if (token) {
    try {
      const { body } = await api('/api/pods', { headers: authH });
      const pods = Array.isArray(body) ? body : (body?.pods || body?.data || []);
      if (pods.length) podId = pods[0]._id || pods[0].id;
      if (!podId) {
        const { body: cb } = await api('/api/pods', { method:'POST', headers:{ ...authH, 'Content-Type':'application/json' }, body: JSON.stringify({ name:'Smoke Check Pod', type:'chat', description:'tier-1 smoke render target' }) });
        const p = cb?.pod || cb; podId = p?._id || p?.id;
      }
    } catch {}
  }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (token) await ctx.addInitScript(t => { try { localStorage.setItem('token', t); } catch(e){} }, token);

  // 4) pages must render (http<400), with no non-allowlisted console errors, and WITHOUT redirecting
  //    away from the requested path (a missing route falls through path="*" to /v2 and would false-pass).
  // okLanding: a missing sub-route falls through path="*" to /v2 (or the default pod), so each
  // page asserts it LANDED on its own path. Exception: /v2 home itself redirects to the user's
  // default pod, so any in-app /v2* landing is fine for home.
  const pages = [
    ['/v2 home', '/v2', l => l.startsWith('/v2')],
    ['/v2 pod', podId ? `/v2/pods/${podId}` : null, l => l === norm(`/v2/pods/${podId}`)],
    ['/v2 connectors', '/v2/connectors', l => l === '/v2/connectors'],
    ['bring-your-own', '/v2/agents/byo', l => l === '/v2/agents/byo'],
  ];
  for (const [label, path, okLanding] of pages) {
    if (!path) { rec(`render ${label}`, false, 'no pod id (GET/POST /api/pods failed)'); continue; }
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type()==='error' && !CONSOLE_ALLOW.some(rx=>rx.test(m.text()))) errs.push(m.text().slice(0,110)); });
    page.on('pageerror', e => errs.push('PAGEERR '+String(e.message).slice(0,110)));
    try {
      const resp = await page.goto(BASE+path, { waitUntil:'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);
      const landed = norm(new URL(page.url()).pathname);
      const redirected = !okLanding(landed);
      const httpOk = !resp || resp.status() < 400;
      rec(`render ${label}`, httpOk && errs.length===0 && !redirected,
        `http ${resp?resp.status():'?'} url=${landed}${redirected?' REDIRECTED (route missing?)':''}${errs.length?'; console: '+errs.slice(0,2).join(' | '):''}`);
    } catch (e) { rec(`render ${label}`, false, e.message.slice(0,100)); }
    await page.close();
  }

  // 5) no horizontal scroll. At desktop (1440) the left rail is .v2-rail__nav and MUST exist and
  //    not overflow (TASK-363 — the Activity-badge overflow — lives here, so a missing rail fails).
  //    At mobile (390) the desktop rail is replaced by a mobile nav, so there we assert the PAGE
  //    itself does not h-scroll (and the rail, if present, fits).
  {
    const page = await ctx.newPage();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(BASE+'/v2', { waitUntil:'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const el = document.querySelector('.v2-rail__nav');
        if (!el) return { found: false };
        return { found: true, over: el.scrollWidth - el.clientWidth };
      });
      rec('rail no h-scroll @1440px', r.found === true && r.over <= 1, r.found ? `over+${r.over}` : 'RAIL NOT FOUND (.v2-rail__nav)');
    } catch (e) { rec('rail no h-scroll @1440px', false, e.message.slice(0,100)); }
    await page.close();
  }
  {
    const page = await ctx.newPage();
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(BASE+'/v2', { waitUntil:'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      const r = await page.evaluate(() => {
        const doc = document.documentElement;
        const el = document.querySelector('.v2-rail__nav');
        return { pageOver: doc.scrollWidth - doc.clientWidth, railOver: el ? (el.scrollWidth - el.clientWidth) : 0 };
      });
      rec('no h-scroll @390px', r.pageOver <= 1 && r.railOver <= 1, `page+${r.pageOver} rail+${r.railOver}`);
    } catch (e) { rec('no h-scroll @390px', false, e.message.slice(0,100)); }
    await page.close();
  }

  // 6) connectors fold — guards the #2504 regression. A FRESH, grant-free account must see at least
  //    one connectable TOOL outside the inactive fold. Fail-CLOSED: absent creds, a failed login, or a
  //    non-grant-free account all FAIL (never skip-green). Since the d215 rebuild (#3143) a tool is a
  //    .v2-cx-tile in the Tools group, what is not offered folds behind "+N off" (.v2-cx-off) and
  //    renders --dim only when opened, and the act lives in the tile's reveal (.v2-cx-pop). So we
  //    open each shown tile and require a real Connect/Install button in its reveal — NOT the tile's
  //    text alone (a tile is shown even when its reveal offers only "Ask" or needs an admin).
  const FRESH_EMAIL = process.env.SMOKE_FRESH_EMAIL, FRESH_PW = process.env.SMOKE_FRESH_PW;
  if (!FRESH_EMAIL || !FRESH_PW) {
    rec('connectors: fresh user sees a tool row outside the fold', false, 'SMOKE_FRESH_EMAIL/PW not set — fresh-account check could not run (fail-closed)');
  } else {
    try {
      const { status, body } = await api('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email: FRESH_EMAIL, password: FRESH_PW }) });
      const ftoken = body?.token || body?.accessToken || null;
      if (!ftoken) { rec('connectors: fresh user sees a tool row outside the fold', false, `fresh login failed (status ${status})`); }
      else {
        // 6a) 0 live TOOL grants. Tool grants live per-pod at /api/pods/:podId/grants (NOT the
        //     Integration list), so sum .grants across the fresh account's pods. res.ok is asserted
        //     on every fetch — a 503 whose body happens to be [] must FAIL, not pass.
        const pr = await api('/api/pods', { headers: { Authorization: `Bearer ${ftoken}` } });
        if (pr.status !== 200) {
          rec('connectors: fresh account has 0 live grants', false, `GET /api/pods -> ${pr.status}`);
        } else {
          const pods = Array.isArray(pr.body) ? pr.body : (pr.body?.pods || []);
          let totalGrants = 0, bad = null;
          for (const pod of pods) {
            const id = pod._id || pod.id;
            const gr = await api(`/api/pods/${id}/grants`, { headers: { Authorization: `Bearer ${ftoken}` } });
            if (gr.status !== 200) { bad = `grants ${id} -> ${gr.status}`; break; }
            totalGrants += Array.isArray(gr.body?.grants) ? gr.body.grants.length : 0;
          }
          rec('connectors: fresh account has 0 live grants', bad === null && totalGrants === 0, bad || `pods=${pods.length} tool-grants=${totalGrants}`);
        }
        // 6b) at least one connectable TOOL tile shown OUTSIDE the "+N off" fold, whose reveal
        //     carries a Connect/Install button (never the secondary "Ask" link, never "Add").
        const fctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
        await fctx.addInitScript(t => { try { localStorage.setItem('token', t); } catch(e){} }, ftoken);
        const page = await fctx.newPage();
        await page.goto(BASE+'/v2/connectors', { waitUntil:'networkidle', timeout: 30000 });
        await page.waitForTimeout(1800);
        const TOOLS = ['GitHub','Linear','Slack','Notion','Google','Jira','Atlassian','Gmail','Airtable','Sentry'];
        const tiles = page.locator('section.v2-cx-group[aria-label="Tools"] .v2-cx-tile:not(.v2-cx-tile--add):not(.v2-cx-tile--dim)');
        const shown = [], connectable = [];
        for (let i = 0; i < await tiles.count(); i++) {
          const tile = tiles.nth(i);
          if (!await tile.isVisible()) continue;
          const name = (await tile.locator('.v2-cx-tile__name').textContent() || '').trim();
          const tool = TOOLS.find(t => name.includes(t));
          if (!tool) continue;
          shown.push(tool);
          await tile.click();
          const pop = page.locator('.v2-cx-pop[role="dialog"]');
          const opened = await pop.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false);
          if (opened) {
            const acts = await pop.locator('button.v2-connector-row__action:not(.v2-connector-row__action--secondary)').allTextContents();
            if (acts.some(a => /\b(connect|install)\b/i.test(a))) connectable.push(tool);
            await page.keyboard.press('Escape');
            await pop.waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
          }
          if (connectable.length) break;
        }
        const offLabel = ((await page.locator('section.v2-cx-group[aria-label="Tools"] .v2-cx-off').allTextContents())[0] || 'none').trim();
        rec('connectors: fresh user sees a tool row outside the fold', connectable.length >= 1, `connectable=[${connectable.join(',')}] shown=[${shown.join(',')}] off=${offLabel}`);
        await fctx.close();
      }
    } catch (e) { rec('connectors: fresh user sees a tool row outside the fold', false, e.message.slice(0,100)); }
  }

  // 7) hosted agent answers (skip until staging has an LLM key)
  if (CHECK_HOSTED) rec('hosted agent answers', false, 'TODO once staging LLM key is set');
  else console.log('SKIP  hosted agent answers — staging has no LLM key yet (SMOKE_HOSTED!=1)');

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\nSMOKE ${failed.length===0?'GREEN':'RED'} — ${results.length-failed.length}/${results.length} passed` + (failed.length?`; failing: ${failed.map(f=>f.name).join(', ')}`:''));
  process.exit(failed.length===0 ? 0 : 1);
}
main().catch(e => { console.error('SMOKE_HARNESS_ERROR', e.message); process.exit(2); });
