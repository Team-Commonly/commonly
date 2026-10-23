#!/usr/bin/env node
// Tier-1 staging smoke — fast, gates prod promotion. Run after a deploy-staging rollout.
// Env: SMOKE_BASE (default https://staging.commonly.me), SMOKE_API (default https://api-staging.commonly.me),
//      SMOKE_EMAIL + SMOKE_PW (non-admin test creds; from a 0600 file, NEVER hard-coded/printed),
//      SMOKE_HOSTED=1 to also check a hosted-agent reply (skip until staging has an LLM key).
// Exit 0 = all green; non-zero = a blocking check failed (caller must block prod promotion).
import { chromium } from 'playwright';

const BASE = process.env.SMOKE_BASE || 'https://staging.commonly.me';
const API  = process.env.SMOKE_API  || 'https://api-staging.commonly.me';
const EMAIL = process.env.SMOKE_EMAIL, PW = process.env.SMOKE_PW;
const CHECK_HOSTED = process.env.SMOKE_HOSTED === '1';
// benign console noise we do not fail on
const CONSOLE_ALLOW = [/favicon/i, /manifest\.json/i, /\/api\/pg\/status/i, /ResizeObserver loop/i, /Download the React DevTools/i];

const results = [];
const rec = (name, ok, detail='') => { results.push({ name, ok, detail }); console.log(`${ok?'PASS':'FAIL'}  ${name}${detail?'  — '+detail:''}`); };

async function main() {
  // 1) health/ready (plain fetch, no browser)
  try {
    const r = await fetch(`${API}/api/health/ready`, { headers: { 'User-Agent': 'commonly-smoke/0.1' } });
    rec('health/ready 200', r.status === 200, `status ${r.status}`);
  } catch (e) { rec('health/ready 200', false, e.message); }

  // login via API -> token (injected into localStorage; more reliable than UI form)
  let token = null;
  try {
    const r = await fetch(`${API}/api/auth/login`, { method:'POST', headers:{'Content-Type':'application/json','User-Agent':'commonly-smoke/0.1'}, body: JSON.stringify({ email: EMAIL, password: PW }) });
    const d = await r.json().catch(()=> ({}));
    token = d.token || d.accessToken || null;
    rec('non-admin login', r.status === 200 && !!token, `status ${r.status}`);
  } catch (e) { rec('non-admin login', false, e.message); }

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  if (token) await ctx.addInitScript(t => { try { localStorage.setItem('token', t); } catch(e){} }, token);

  // pages that must render with no (non-allowlisted) console errors
  const pages = [ ['/v2 home','/v2'], ['/v2 pod','/v2/pods'], ['/v2 connectors','/v2/connectors'], ['bring-your-own','/v2/bring-your-own'] ];
  for (const [label, path] of pages) {
    const page = await ctx.newPage();
    const errs = [];
    page.on('console', m => { if (m.type()==='error' && !CONSOLE_ALLOW.some(rx=>rx.test(m.text()))) errs.push(m.text().slice(0,120)); });
    page.on('pageerror', e => errs.push('PAGEERR '+String(e.message).slice(0,120)));
    try {
      const resp = await page.goto(BASE+path, { waitUntil:'networkidle', timeout: 30000 });
      await page.waitForTimeout(1500);
      const httpOk = !resp || resp.status() < 400;
      rec(`render ${label}`, httpOk && errs.length===0, `http ${resp?resp.status():'?'}${errs.length?'; console: '+errs.slice(0,2).join(' | '):''}`);
    } catch (e) { rec(`render ${label}`, false, e.message.slice(0,100)); }
    await page.close();
  }

  // left rail no horizontal scroll at 1440 and 390
  for (const w of [1440, 390]) {
    const page = await ctx.newPage();
    try {
      await page.setViewportSize({ width: w, height: 844 });
      await page.goto(BASE+'/v2', { waitUntil:'networkidle', timeout: 30000 });
      await page.waitForTimeout(1200);
      const over = await page.evaluate(() => {
        const bodyOverflow = document.documentElement.scrollWidth - document.documentElement.clientWidth;
        const rail = document.querySelector('nav, aside, [class*="sidebar" i], [class*="rail" i], [data-testid*="sidebar" i]');
        const railOver = rail ? (rail.scrollWidth - rail.clientWidth) : null;
        return { bodyOverflow, railOver, railFound: !!rail };
      });
      const ok = over.bodyOverflow <= 1 && (over.railOver == null || over.railOver <= 1);
      rec(`no h-scroll @${w}px`, ok, `body+${over.bodyOverflow} rail+${over.railOver} (railFound=${over.railFound})`);
    } catch (e) { rec(`no h-scroll @${w}px`, false, e.message.slice(0,100)); }
    await page.close();
  }

  // hosted agent answers (skip until staging has an LLM key)
  if (CHECK_HOSTED) rec('hosted agent answers', false, 'TODO once staging LLM key is set');
  else console.log('SKIP  hosted agent answers — staging has no LLM key yet (SMOKE_HOSTED!=1)');

  await browser.close();
  const failed = results.filter(r => !r.ok);
  console.log(`\nSMOKE ${failed.length===0?'GREEN':'RED'} — ${results.length-failed.length}/${results.length} passed` + (failed.length?`; failing: ${failed.map(f=>f.name).join(', ')}`:''));
  process.exit(failed.length===0 ? 0 : 1);
}
main().catch(e => { console.error('SMOKE_HARNESS_ERROR', e.message); process.exit(2); });
