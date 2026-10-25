import {chromium} from '/tmp/vera-2657-browser/node_modules/playwright/index.mjs';
import fs from 'node:fs';
const out='/tmp/rivet2661-evidence';
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
const entry={installableId:'linear',list:'tools',label:'Linear',description:'Issues in Linear.',available:true,connectionType:'hosted-mcp',entryId:'linear',broker:{id:'commonly-grant-broker'},tools:[{name:'linear.list_issues',requiredWriteMode:'read',irreversible:false}],connections:[{connectionId:'conn-2',owner:'Team-Commonly',repo:'linear'}]};
const results=[];
try {
for(const lang of ['en','zh-CN']) for(const width of [390,1440]) {
 const context=await browser.newContext({viewport:{width,height:1000},deviceScaleFactor:1});
 const page=await context.newPage(),errors=[],failedRequests=[],posts=[];
 page.on('pageerror',e=>errors.push(e.message));
 page.on('response',r=>{if(r.status()>=400) failedRequests.push({url:r.url(),status:r.status()});});
 await page.route('**/api/**',async route=>{
  const req=route.request(),path=new URL(req.url()).pathname;
  if(req.method()==='POST'&&path==='/api/grants'){posts.push(req.postDataJSON());return route.fulfill({json:{grantId:'fixture-grant'}});}
  if(path==='/api/installables')return route.fulfill({json:{installables:[entry]}});
  if(path==='/api/pods/p1/grants')return route.fulfill({json:{podId:'p1',grants:[]}});
  if(path==='/api/registry/pods/p1/agents')return route.fulfill({json:{agents:[{name:'scout',displayName:'Scout',userId:'a1'}]}});
  throw Error('Unexpected '+req.method()+' '+path);
 });
 await page.goto('http://127.0.0.1:42661/rivet-2661.html?lang='+lang);
 await page.locator('.v2-connector-row__action').click();
 const aside=page.getByRole('complementary'),scout=aside.getByRole('checkbox',{name:'Scout'}),submit=aside.locator('.v2-connector-aside__primary');
 await scout.check();
 if(!await submit.isEnabled())throw Error('normal grant disabled');
 await page.evaluate(()=>document.fonts.ready);
 await page.screenshot({path:`${out}/${lang}-normal-${width}.png`,fullPage:true});
 await scout.uncheck();
 const notice=lang==='en'?'Select at least one agent to grant access.':'请至少选择一个智能体以授予访问权限。';
 await aside.getByRole('status').filter({hasText:notice}).waitFor();
 if(!await submit.isDisabled())throw Error('empty grant enabled');
 await page.screenshot({path:`${out}/${lang}-empty-${width}.png`,fullPage:true});
 const geometry=await aside.evaluate(el=>{const r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scrollWidth:document.documentElement.scrollWidth,viewport:innerWidth};});
 if(geometry.scrollWidth>width||errors.length||failedRequests.length||posts.length)throw Error(JSON.stringify({geometry,errors,failedRequests,posts}));
 await scout.check();await submit.click();
 await page.waitForFunction(()=>!document.querySelector('.v2-connector-aside'));
 if(posts.length!==1||posts[0].audience.join(',')!=='a1')throw Error(JSON.stringify(posts));
 results.push({lang,width,geometry,notice,emptyDisabled:true,normalEnabled:true,submitted:posts[0],errors,failedRequests});
 await context.close();
}
fs.writeFileSync(out+'/browser-results.json',JSON.stringify({head:'afe160b203d662294101c35bd8c0bfd44e06a6d3',provenance:'Isolated local Chrome, actual component and CSS, mocked API fixtures, no production account',results},null,2));
console.log(JSON.stringify(results));
} finally {await browser.close();}
