import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
const m=JSON.parse(readFileSync('/private/tmp/socrates-m07-compatibility.json','utf8'));assert.equal(m.source,'synthetic-m07-compatibility');
const {chromium}=await import(process.env.SOCRATES_PLAYWRIGHT_MODULE??'playwright');const browser=await chromium.launch({channel:'chrome',headless:true});
const out='output/playwright/multica-m06-m07/compatibility';mkdirSync(out,{recursive:true});const checks=[],errors=[],external=[];
const check=(name,ok)=>{checks.push({name,ok});console.log(name,ok);assert.ok(ok,name);};
try{for(const mode of ['fresh','upgrade']){
 const hs=m[mode],page=await browser.newPage({viewport:{width:1440,height:1000},reducedMotion:'reduce'});page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{const u=new URL(r.url());if(['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname))external.push(u.href);});
 await page.addInitScript(({port,token})=>{localStorage.setItem('socrates.lang','en');window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};window.__TAURI_INTERNALS__={invoke:async c=>c==='sidecar_handshake'?{port,token}:null,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback(){}};},hs);
 const api=async(path,body,method='POST')=>{const r=await fetch(`http://127.0.0.1:${hs.port}${path}`,{headers:{Authorization:`Bearer ${hs.token}`,'Content-Type':'application/json'},...(body?{method,body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v;};
 await api('/config',{language:'en'},'PUT');
 await page.goto('http://127.0.0.1:45379/');await page.getByRole('tab',{name:'Chat',exact:true}).waitFor();await page.getByRole('tab',{name:'Chat',exact:true}).click();
 if(mode==='fresh'){
  check('Fresh production database starts with no fabricated providers or sessions',(await api('/providers')).length===0&&(await api('/sessions')).length===0);
  await page.getByRole('button',{name:'Settings',exact:true}).click();await page.getByRole('dialog',{name:'Settings',exact:true}).waitFor();check('Fresh startup exposes Settings to configure a provider',true);await page.screenshot({animations:'disabled',path:`${out}/fresh-settings.png`});
 }else{
  await page.locator('[data-navigation-sidebar]').getByText('Synthetic Alpha.1 history',{exact:true}).click();await page.getByText('Synthetic Alpha.1 message retained after upgrade',{exact:true}).waitFor();check('Production upgrade displays preserved Alpha.1 messages',true);
  const room=(await api('/sessions')).find(s=>s.id===m.roomId);check('Upgrade retains original room ID and frozen member snapshot',room.agents[0].snapshot.nickname==='Frozen Alpha member');
  await api(`/sessions/${m.roomId}/archive`,{archived:true},'PUT');check('Upgraded historical room remains archivable',(await api('/sessions')).find(s=>s.id===m.roomId).archived===true);
  await api(`/sessions/${m.roomId}/archive`,{archived:false},'PUT');await page.reload();await page.getByText('Synthetic Alpha.1 message retained after upgrade',{exact:true}).waitFor();check('Unarchive and reload preserve the same message',true);await page.screenshot({animations:'disabled',path:`${out}/alpha-upgrade.png`});
  await page.getByRole('tab',{name:'Work',exact:true}).click();const side=page.locator('[data-navigation-sidebar]');
  for(let i=1;i<=2;i++){await side.getByRole('searchbox').fill(`Alpha Work ${i}`);await side.getByText(`Alpha Work ${i}`,{exact:true}).click();await page.getByText(`Synthetic project ${i} private context`,{exact:true}).waitFor();check(`Project ${i} room preserves its history without the other project's message`,!(await page.locator('main').innerText()).includes(`Synthetic project ${3-i} private context`));}
  await page.screenshot({animations:'disabled',path:`${out}/multiple-projects.png`});
 }
 writeFileSync(`${out}/${mode}-body.txt`,await page.locator('body').innerText());await page.close();
}check('Fresh and upgraded production UI have no renderer errors or external requests',errors.length===0&&external.length===0);
}finally{for(const p of browser.contexts().flatMap(c=>c.pages())){await p.screenshot({path:`${out}/last.png`}).catch(()=>{});writeFileSync(`${out}/last-body.txt`,await p.locator('body').innerText());}writeFileSync(`${out}/checks.json`,JSON.stringify({checks,errors,external,limitations:['Production Bun entry point with disposable databases; browser Tauri handshake shim, not an installed native release. No providers configured and no Keychain writes.']},null,2));await browser.close();}
