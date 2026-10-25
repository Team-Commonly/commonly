const {chromium}=require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const fs=require('fs');
const toolsProof=process.env.TOOLS_PROOF==='1';
const outDir=process.env.OUTPUT_DIR || require('path').join(__dirname,'captures');
(async()=>{
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
fs.mkdirSync(outDir,{recursive:true});
for(const lang of ['en','zh-CN']) for(const kind of (toolsProof?['byo','hosted','scout']:['byo','hosted','scout','never'])) for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:width===390?844:1000}}); const page=await context.newPage(); const errors=[];page.on('pageerror',e=>errors.push(e.message));
 let paused=false;let heartbeatEnabled=false;
 const runtime={runtimeType:kind==='scout'?'native':kind==='hosted'?'hosted':'wrapper',adapter:kind==='byo'?'codex':undefined};
 const receipt={harness:'claude',version:'2.1',model:'claude-sonnet-4-5',effort:'high',at:'2026-10-25T16:40:00Z'};
 const installation=()=>({name:kind,instanceId:'default',displayName:kind==='scout'?'Scout':kind==='hosted'?'Launch plan agent':'Maya agent',runtime,status:paused?'paused':'active',installedBy:'fixture-owner'});
 await page.route('**/*',route=>['127.0.0.1','localhost'].includes(new URL(route.request().url()).hostname)?route.continue():route.abort());
 await page.route('**/api/**',async route=>{const req=route.request();const u=new URL(req.url());let data={};
 if(req.method()==='PATCH'){const patch=req.postDataJSON();if('status' in patch)paused=patch.status==='paused';if('heartbeatEnabled' in patch)heartbeatEnabled=patch.heartbeatEnabled;data={agent:installation()};}
 else if(u.pathname==='/api/auth/user')data={_id:'fixture-owner',username:'alex',email:'fixture@example.invalid',verified:true};
 else if(u.pathname==='/api/pods')data=[{_id:'fixture-pod',name:'Launch plan',type:'chat',createdBy:{_id:'fixture-owner'}}];
 else if(u.pathname.includes('manage-settings'))data={writablePodId:'fixture-pod',installations:[{podId:'fixture-pod',podName:'Launch plan',status:paused?'paused':'active',heartbeatEnabled,heartbeatMinutes:60}],turnCap:30,userRunCeiling:120,usage:kind==='hosted'?{used:12,cap:30,resetsAt:'2026-10-26T00:00:00Z'}:null,processConnected:kind==='byo',runtimeManaged:kind==='byo',runtimeObservation:kind==='byo'?{lastSpawn:receipt,lastTurnAt:'2026-10-25T16:41:00Z',turnRunning:false}:null,runtimeRun:kind==='hosted'||kind==='scout'?{model:'deepseek-v4-flash',startedAt:'2026-10-25T16:40:00Z',completedAt:'2026-10-25T16:41:00Z',status:'succeeded'}:null,heldTask:kind==='hosted'?{taskId:'TASK-6',podId:'fixture-pod',podName:'Launch plan'}:null};
 else if(u.pathname===`/api/registry/pods/fixture-pod/agents`)data={agents:[{...installation(),connection:{state:kind==='never'?'never':kind==='byo'?'stale':'available',lastSeenAt:'2026-10-25T16:40:00Z'}}]};
 else if(u.pathname===`/api/registry/pods/fixture-pod/agents/${kind}`)data={agent:installation()};
 else if(u.pathname==='/api/agent-binding/placement')data={boundMachineId:'fixture-machine',activeMachines:[{machineId:'fixture-machine',name:'Laptop'}],boundMachineRevoked:false};
 else if(u.pathname==='/api/credentials')data=[{_id:'fixture-key',label:'Runtime token',status:'active',createdAt:'2026-10-01T00:00:00Z',lastUsedAt:'2026-10-25T16:40:00Z'},{_id:'fixture-old',label:'Runtime token',status:'revoked',createdAt:'2026-10-01T00:00:00Z',lastUsedAt:'2026-10-24T16:40:00Z',revokedAt:'2026-10-25T16:40:00Z'}];
 else if(u.pathname.endsWith('/grants'))data={grants:toolsProof&&kind!=='hosted'?[{grantId:'fixture-grant',tools:['repo.read'],connector:'Repository',podName:'Launch plan',grantedBy:'Alex',createdAt:'2026-10-20T12:00:00Z',expiresAt:'2099-01-01T00:00:00Z',revokedAt:null,canRevoke:true}]:[]};
 else if(u.pathname.endsWith('/editable'))data={sections:{long_term:{content:'Remembers the launch plan.',updatedAt:null},soul:{content:'',updatedAt:null},shared:{content:'',updatedAt:null}}};
 else if(u.pathname.includes('attention'))data={items:[],count:0};
 else if(u.pathname.includes('/skills'))data={items:toolsProof&&kind!=='hosted'?[{name:'Writing',description:'Draft release notes.'},{name:'Review',description:'Review a change.'}]:[],canEdit:toolsProof,skillLoad:toolsProof?{at:'2026-10-25T16:40:00Z',mounted:['Writing'],conflicted:['Review']}:null};
 await route.fulfill({json:data});});
 await page.addInitScript((lang)=>{localStorage.setItem('token','fixture-only-user');localStorage.setItem('v2.lang',lang);},lang);
 await page.goto(`http://127.0.0.1:3546/v2/agents/${kind}/default`); await page.getByRole('heading',{name:lang==='en'?'Status':'状态',exact:true}).waitFor(); await page.locator('.v2-agent-status strong').filter({hasText:kind==='byo'?(lang==='en'?'Off':'离线'):kind==='never'?(lang==='en'?'Not connected yet':'尚未连接'):kind==='hosted'?(lang==='en'?'Working':'工作中'):(lang==='en'?'Ready':'就绪')}).waitFor();await page.evaluate(async()=>{
 await document.fonts.ready;
 for(const family of ['IBM Plex Sans','IBM Plex Mono']) {
 const faces=await document.fonts.load(`400 12px "${family}"`);
 if(!faces.some(face=>face.family.replaceAll('"','')===family && face.status==='loaded')) throw new Error('Signal font missing: '+family);
 }
 });
 if(width===390) {
 for(const el of await page.locator('.v2-agent-status button, .v2-agent-status a.v2-agent-settings__action, .v2-agent-runtime-summary__command button').all()) {
 const box=await el.boundingBox(); if(box && box.height<44) throw new Error('Phone action below 44px: '+box.height);
 }
 }
 if(kind==='byo') {
 const flags=page.locator('.v2-agent-runtime-summary__command code span').filter({hasText:/^--/});
 if(await flags.count()!==2) throw new Error('Config flags missing');
 for(const flag of await flags.all()) if(await flag.evaluate(el=>getComputedStyle(el).whiteSpace)!=='nowrap') throw new Error('Config flag can split');
 }
 if(kind==='never' && await page.getByText(/To change it, run this there:/).count()) throw new Error('Missing command hint');
 if(kind==='byo' && await page.getByText(/Running on Laptop/).count()) throw new Error('Binding claims a running process');
 for (const title of (lang==='en'?['Status','Runtime']:['状态','运行方式'])) { const section=page.getByRole('heading',{name:title,exact:true}).locator('..'); await section.screenshot({path:`${outDir}/${lang}-${kind}-${width}-${title.toLowerCase()}.png`}); }
 await page.locator('.v2-agent-settings').evaluate(el=>el.closest('.v2-feature__body').scrollTop=0);
 await page.screenshot({path:`${outDir}/${lang}-${kind}-${width}.png`,fullPage:true});
 console.log(lang,kind,width,JSON.stringify({errors,overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),h2:await page.locator('h2').allTextContents()}));
 if(kind==='byo') {
 const keys=page.getByRole('heading',{name:lang==='en'?'Access key':'访问密钥',exact:true}).locator('..').locator('..');
 await keys.screenshot({path:`${outDir}/${lang}-byo-keys-folded-${width}.png`});
 const history=keys.locator('details');await history.locator('summary').click();
 const labels=lang==='en'?['Created','Last used','Revoked']:['创建于','上次使用','撤销于'];
 for(const [index,value] of ['2026-10-01T00:00:00Z','2026-10-24T16:40:00Z','2026-10-25T16:40:00Z'].entries()) {
 const date=await page.evaluate(({value,lang})=>new Date(value).toLocaleString(lang,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),{value,lang});
 await history.getByText(`${labels[index]} ${date}`,{exact:true}).waitFor();
 }
 await keys.screenshot({path:`${outDir}/${lang}-byo-keys-expanded-${width}.png`});
 await history.locator('summary').click();
 }
 if(kind!=='never' && kind!=='scout') {
 const usage=page.getByRole('heading',{name:lang==='en'?'Usage':'用量',exact:true}).locator('..');
 if(kind==='hosted') {
 await usage.getByText(lang==='en'?'Owner’s daily limit, all agents':'所有者全部智能体的每日运行上限',{exact:true}).waitFor();
 const date=await page.evaluate(lang=>new Date('2026-10-26T00:00:00Z').toLocaleString(lang,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),lang);
 await usage.getByText(`${lang==='en'?'Resets':'重置时间'} ${date}`,{exact:true}).waitFor();
 }
 await usage.screenshot({path:`${outDir}/${lang}-${kind}-usage-${width}.png`});
 }
 if(toolsProof) {
 if(kind!=='hosted') {
 await page.locator('.v2-agent-runtime-grants').getByRole('button',{name:lang==='en'?'Revoke':'撤销',exact:true}).click();
 const confirm=page.locator('.v2-agent-runtime-grants__actions button').first();
 await page.mouse.move(0,0);
 await page.waitForFunction(()=>getComputedStyle(document.querySelector('.v2-agent-runtime-grants__actions button')).backgroundColor==='rgb(16, 24, 40)');
 const ink=await confirm.evaluate(el=>getComputedStyle(el).backgroundColor);
 if(ink!=='rgb(16, 24, 40)')throw new Error('Revoke confirm is not ink: '+ink);
 await confirm.locator('..').screenshot({path:`${outDir}/${lang}-${kind}-revoke-${width}.png`});
 await page.locator('.v2-agent-runtime-grants__actions button').last().click();
 }
 await page.getByRole('button',{name:lang==='en'?'Add skill':'添加技能',exact:true}).click();
 const input=page.locator('#v2-agent-skills-search');await input.waitFor();
 const metrics=await input.evaluate(el=>({height:el.getBoundingClientRect().height,font:getComputedStyle(el).fontFamily,parentFont:getComputedStyle(el.parentElement).fontFamily}));
 if(width===390&&metrics.height<44)throw new Error('Catalog input below 44px');
 if(metrics.font!==metrics.parentFont)throw new Error('Catalog input font not inherited');
 await page.locator('.v2-agent-skills').screenshot({path:`${outDir}/${lang}-${kind}-catalog-${width}.png`});
 console.log('tools',lang,kind,width,JSON.stringify(metrics));
 await page.getByRole('button',{name:lang==='en'?'Close catalog':'关闭目录',exact:true}).click();
 }
 if(kind!=='never') {
 const reach=page.getByRole('heading',{name:lang==='en'?'Reach per pod':'各 Pod 的唤醒设置',exact:true}).locator('..');
 const toggle=reach.getByRole('checkbox',{name:lang==='en'?'Heartbeat':'心跳',exact:true});
 if(await reach.locator('select').count())throw new Error('Heartbeat off exposes interval');
 if(await reach.getByText(/turns\/day|次运行.*天/).count())throw new Error('Heartbeat off exposes estimate');
 await reach.screenshot({path:`${outDir}/${lang}-${kind}-reach-off-${width}.png`});
 await toggle.click();const interval=reach.locator('select');await interval.waitFor();
 const box=await interval.boundingBox();if(width===390 && (!box || box.height<44))throw new Error('Interval below 44px');
 await reach.screenshot({path:`${outDir}/${lang}-${kind}-reach-on-${width}.png`});
 console.log('heartbeat',lang,kind,width,box.height);
 await toggle.click();await interval.waitFor({state:'hidden'});
 }
 if(kind==='byo' && lang==='en'){
 await page.goto('http://127.0.0.1:3546/v2/agents');
 const name=page.getByRole('link',{name:'Maya agent',exact:true}); await name.waitFor();
 if(await name.getAttribute('href')!=='/v2/agents/byo/default') throw new Error('Wrong Settings link');
 const color=await name.evaluate(el=>getComputedStyle(el).color);if(color!=='rgb(16, 24, 40)')throw new Error('Changed name color: '+color);
 await page.screenshot({path:`${outDir}/en-team-${width}.png`,fullPage:true});
 await name.click(); await page.getByRole('heading',{name:'Status',exact:true}).waitFor();
 }
 if(kind==='never') {
 const disclosure=page.locator('details').filter({has:page.getByRole('heading',{name:lang==='en'?'Remove':'移除',exact:true,includeHidden:true})});
 if(await disclosure.getAttribute('open')!==null) throw new Error('Removal must start folded');
 await disclosure.locator('summary').click();
 await disclosure.getByRole('button').waitFor();
 await page.screenshot({path:`${outDir}/${lang}-never-remove-${width}.png`,fullPage:true});
 }
 if(kind==='hosted'){await page.getByRole('button',{name:lang==='en'?'Pause':'暂停',exact:true}).click();await page.getByRole('button',{name:lang==='en'?'Resume':'恢复',exact:true}).waitFor();}
 await context.close();
} await browser.close();
})();
