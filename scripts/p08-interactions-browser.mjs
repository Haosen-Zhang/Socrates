import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
const m=JSON.parse(readFileSync('/private/tmp/socrates-p05-p07-browser.json','utf8'));
assert.equal(m.source,'synthetic-p05-p07');
const {chromium}=await import(process.env.SOCRATES_PLAYWRIGHT_MODULE??'playwright');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1400,height:950}});page.setDefaultTimeout(15000);
const out='output/playwright/p08-interactions';mkdirSync(out,{recursive:true});
const checks=[],errors=[],external=[],submissions=[];
const check=(name,ok)=>{checks.push({name,ok});console.log(name,ok);assert.ok(ok,name);};
page.on('pageerror',e=>errors.push(String(e)));page.on('request',r=>{const u=new URL(r.url());if(['http:','https:'].includes(u.protocol)&&!['127.0.0.1','localhost'].includes(u.hostname))external.push(u.origin);if(r.method()==='POST'&&u.pathname.includes('room-commands'))submissions.push(u.pathname);});
await page.addInitScript(({port,token})=>{localStorage.setItem('socrates.lang','en');window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener(){}};window.__TAURI_INTERNALS__={invoke:async c=>c==='sidecar_handshake'?{port,token}:null,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback(){}};},m);
const composer=()=>page.locator('textarea.pixel-composer-input:visible');
async function work(){await page.getByRole('tab',{name:'Work',exact:true}).click();const sidebar=page.locator('[data-navigation-sidebar]');const item=sidebar.getByText('Delivery Lab',{exact:true});if(!await item.isVisible())await sidebar.getByRole('button',{expanded:false}).first().click();await item.click();}
try{
await page.goto('http://127.0.0.1:45348/');await work();await composer().fill('工作草稿：保留中文与未发送内容');
await page.getByRole('tab',{name:'Chat',exact:true}).click();await composer().fill('聊天草稿：与工作分开');await work();
check('Work draft survives Chat navigation',await composer().inputValue()==='工作草稿：保留中文与未发送内容');
await page.getByRole('tab',{name:'Chat',exact:true}).click();check('Chat draft remains separately scoped',await composer().inputValue()==='聊天草稿：与工作分开');
const before=submissions.length;
await composer().evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:'中文'}));el.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:'中文'}));});
await page.waitForTimeout(150);check('Chinese composition Enter does not submit',submissions.length===before);
await composer().focus();await page.keyboard.press('Shift+Enter');check('Keyboard newline does not submit',submissions.length===before&&(await composer().inputValue()).includes('\n'));
await page.getByRole('button',{name:'Settings',exact:true}).click();let settings=page.getByRole('dialog',{name:'Settings',exact:true});await settings.getByRole('button',{name:'General',exact:true}).click();
for(const theme of ['Dark','Light']){await settings.getByRole('button',{name:theme,exact:true}).click();await settings.getByRole('button',{name:'Dismiss',exact:true}).click();check(`${theme} theme applies through settings`,await page.locator('html').getAttribute('data-theme')===theme.toLowerCase());await page.screenshot({path:`${out}/${theme.toLowerCase()}.png`});if(theme==='Dark'){await page.getByRole('button',{name:'Settings',exact:true}).click();settings=page.getByRole('dialog',{name:'Settings',exact:true});}}
await page.setViewportSize({width:650,height:600});await page.waitForTimeout(300);check('Narrow Chat has no document horizontal overflow',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await composer().scrollIntoViewIfNeeded();check('Narrow input remains reachable',await composer().isVisible());await page.screenshot({path:`${out}/narrow-chat.png`});
await page.setViewportSize({width:1400,height:950});await composer().focus();await page.keyboard.press('Tab');check('Keyboard focus moves to another visible control',await page.evaluate(()=>document.activeElement!==document.body&&document.activeElement?.tagName!=='TEXTAREA'));
const renamed=await fetch(`http://127.0.0.1:${m.port}/sessions/${m.roomIds.chat}`,{method:'PUT',headers:{Authorization:`Bearer ${m.token}`,'Content-Type':'application/json'},body:JSON.stringify({title:'长任务名称 / Long research task — '.repeat(8)})});assert.ok(renamed.ok);await page.reload();await composer().waitFor();await page.setViewportSize({width:650,height:600});await page.waitForTimeout(250);check('Long persisted room title does not push narrow controls outside viewport',await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.screenshot({path:`${out}/long-title.png`});
check('Composer has an accessible task-input name',await page.getByRole('textbox',{name:'Task input',exact:true}).count()===1);check('No renderer errors or external requests',errors.length===0&&external.length===0);
}finally{writeFileSync(`${out}/checks.json`,JSON.stringify({checks,errors,external,limitations:['IME verified with composition events; native OS candidate-window interaction and assistive-technology announcement are not exercised.']},null,2));await page.screenshot({path:`${out}/final.png`}).catch(()=>{});await browser.close();}
