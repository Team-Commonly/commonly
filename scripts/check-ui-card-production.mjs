import { createRequire } from 'node:module';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
const requireFrontend = createRequire(new URL('../frontend/package.json', import.meta.url));
const vite = await import(requireFrontend.resolve('vite'));
const { build, preview } = vite.default || vite;
const root = fileURLToPath(new URL('../frontend/', import.meta.url));
const outDir = await mkdtemp(join(tmpdir(), 'commonly-card-production-'));
let server; let browser;
try {
  await build({ root, configFile:join(root,'vite.config.ts'), mode:'production', build:{outDir,emptyOutDir:true,rollupOptions:{input:join(root,'design-system/preview/ui-card.html')}} });
  for (const name of await readdir(join(outDir,'assets'))) {
    if (name.endsWith('.js')) assert.doesNotMatch(await readFile(join(outDir,'assets',name),'utf8'), /cdn\.jsdelivr\.net|data-openui-devtools-auto-mount/, `Devtools entered ${name}`);
  }
  server = await preview({root,configFile:join(root,'vite.config.ts'),build:{outDir},preview:{host:'127.0.0.1',port:3498,strictPort:true}});
  browser = await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE ? {executablePath:process.env.CHROME_EXECUTABLE} : {})});
  const page = await browser.newPage(); const requests=[]; const errors=[];
  page.on('request', request => requests.push(request.url()));
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**',route=>route.fulfill({json:{tasks:[{taskId:'TASK-498',title:'Render OpenUI cards',status:'claimed'}],run:{id:'012345678901234567890123',podId:'111111111111111111111111',startedAt:'2026-10-25T09:00:00Z',completedAt:'2026-10-25T09:02:10Z',omittedToolCalls:0,turns:[{toolCalls:[{name:'commonly_get_tasks',outcome:'ok',elapsedMs:100},{name:'sentry.search_issues',outcome:'refused',elapsedMs:30},{name:'commonly_post_message',outcome:'ok',elapsedMs:80}]}]}}}));
  const measurements=[];
  for(const width of [1440,390]) {
    await page.setViewportSize({width,height:1000});
    await page.goto('http://127.0.0.1:3498/design-system/preview/ui-card.html');
    await page.getByText('sentry.search_issues',{exact:true}).waitFor();
    await page.getByText('Unsupported card version.',{exact:true}).waitFor();
    const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);
    const buttonHeight=await page.getByRole('link',{name:'Open pull request github.com'}).evaluate(e=>e.getBoundingClientRect().height);
    const devtools=await page.locator('[data-openui-devtools-auto-mount]').count();
    assert.equal(overflow,false); assert.equal(devtools,0); assert.equal(buttonHeight,width===390?44:32);
    await page.screenshot({path:`docs/audits/task-498/catalogue-${width}.png`,fullPage:true});
    measurements.push({width,overflow,buttonHeight,devtools});
  }
  assert.deepEqual(errors,[]);
  assert.deepEqual(requests.filter(url=>/jsdelivr|posthog/i.test(url)),[]);
  const evidence={mode:'production',api:'controlled fixtures; no deployed walk',measurements,jsdelivrRequests:0,posthogRequests:0,pageErrors:errors};
  await writeFile('docs/audits/task-498/production-proof.json',JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence));
} finally {
  await browser?.close(); await server?.httpServer.close(); await rm(outDir,{recursive:true,force:true});
}
