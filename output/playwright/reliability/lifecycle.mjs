const {chromium}=await import(process.env.SOCRATES_PLAYWRIGHT_MODULE??'playwright');
import {writeFileSync} from 'node:fs';
const browser=await chromium.launch({channel:'chrome',headless:true}),page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);
const checks=[],errors=[];page.on('pageerror',e=>errors.push(String(e)));
const check=(name,ok)=>{console.log(name,ok);checks.push({check:name,ok});if(!ok)throw Error(name);};
await page.addInitScript(()=>{window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__={invoke:async cmd=>cmd==='sidecar_handshake'?{port:45327,token:'ui-validation'}:null,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback:()=>{}};});
const attach=()=>page.evaluate(async()=>{window.__testStore=(await import(performance.getEntriesByType('resource').find(e=>/\/src\/store\.ts(?:\?|$)/.test(e.name)).name)).useStore;});
const choose=async(name,id)=>{await page.getByRole('complementary').getByText(name,{exact:true}).click();await page.waitForFunction(id=>window.__testStore.getState().currentSessionId===id,id);};
const input=page.getByRole('textbox',{name:'任务输入',exact:true});
try {
await page.goto('http://127.0.0.1:45328/',{waitUntil:'domcontentloaded',timeout:30000});await input.waitFor();await attach();
await choose('Chat one','chat-one');
for(const mode of ['respond','discuss']) {
  await page.getByRole('combobox',{name:'回应方式'}).selectOption(mode);
  await input.fill(`Rewind ${mode} verification`);
  await page.getByRole('button',{name:'发送',exact:true}).click();
  await page.waitForFunction(async()=>{const s=window.__testStore.getState();return !s.agentRunning&&s.sessionMessages.filter(m=>m.role==='assistant').length>0;});
  await page.locator('.anim-msg').filter({hasText:`Rewind ${mode} verification`}).getByRole('button',{name:'回溯',exact:true}).click();
  await page.getByRole('button',{name:/^确认删除/}).click();
  await page.waitForFunction(()=>window.__testStore.getState().sessionMessages.length===0);
  await page.reload();await input.waitFor();await attach();
  check(`${mode} rewind stays empty after reload`,await page.evaluate(()=>window.__testStore.getState().currentSessionId==='chat-one'&&window.__testStore.getState().sessionMessages.length===0&&!window.__testStore.getState().lastStoppedRunId));
  const commands=await page.evaluate(async()=>(await(await fetch('http://127.0.0.1:45327/room-commands/rooms/chat-one')).json()));
  check(`${mode} rewind has no recoverable command`,commands.length===0);
}
await page.getByRole('tab',{name:'Work',exact:true}).click();await choose('Work two','work-two');
await Promise.all([page.waitForResponse(r=>r.url().endsWith('/collaboration')&&r.request().method()==='PUT'),page.getByRole('combobox',{name:'回应方式'}).selectOption('team')]);
await input.fill('Pause then continue team');
const [created]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/room-commands')&&r.request().method()==='POST'),page.getByRole('button',{name:'发送',exact:true}).click()]);const command=await created.json();
await page.getByRole('button',{name:'批准此精确计划',exact:true}).click();
await page.waitForFunction(()=>Object.values(window.__testStore.getState().multiLiveStreams).some(x=>x.text?.includes('Ada')));
await page.getByRole('button',{name:'暂停',exact:true}).click();
await page.waitForFunction(()=>window.__testStore.getState().currentMultiTask?.state==='paused');
check('UI pause settles into recoverable paused state',true);
writeFileSync('output/playwright/reliability/paused.txt',await page.locator('body').ariaSnapshot());
await page.screenshot({path:'output/playwright/reliability/team-paused.png'});
const retry=page.getByRole('button',{name:/重试|继续/}).filter({hasNotText:'查看'}).first();
await retry.click();
await page.waitForFunction(async id=>(await(await fetch(`http://127.0.0.1:45327/multi/tasks/${id}`)).json()).state==='completed',command.taskId);
await page.waitForFunction(()=>window.__testStore.getState().currentMultiTask?.state==='completed');
const task=await page.evaluate(async id=>(await(await fetch(`http://127.0.0.1:45327/multi/tasks/${id}`)).json()),command.taskId);
check('UI continuation completes both packages once per required attempt',task.attemptNo===2&&task.workPackages[0].attemptNo===2&&task.workPackages[1].attemptNo===1&&task.workPackages.every(p=>p.state==='completed'));
await page.screenshot({path:'output/playwright/reliability/team-resumed.png'});
check('no lifecycle page exceptions',errors.length===0);
} catch(error) {writeFileSync('output/playwright/reliability/lifecycle-failure.txt',String(error)+'\n'+await page.locator('body').ariaSnapshot());await page.screenshot({path:'output/playwright/reliability/lifecycle-failure.png'});throw error;}
finally {writeFileSync('output/playwright/reliability/lifecycle-checks.json',JSON.stringify({checks,errors},null,2));console.log(JSON.stringify({checks,errors}));await browser.close();}
