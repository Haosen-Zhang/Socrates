const { chromium } = await import(process.env.SOCRATES_PLAYWRIGHT_MODULE ?? 'playwright');
import { writeFileSync } from 'node:fs';
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(12000);
const errors=[],checks=[];page.on('pageerror',error=>errors.push(String(error)));
try {
await page.addInitScript(()=>{window.__TAURI_EVENT_PLUGIN_INTERNALS__={unregisterListener:()=>{}};window.__TAURI_INTERNALS__={invoke:async cmd=>cmd==='sidecar_handshake'?{port:45327,token:'ui-validation'}:null,metadata:{currentWindow:{label:'main'},currentWebview:{label:'main'}},transformCallback:()=>0,unregisterCallback:()=>{}};});
await page.goto('http://127.0.0.1:45328/',{waitUntil:'domcontentloaded',timeout:30000});
await page.getByRole('tab',{name:'Work',exact:true}).click();await page.getByText('Work one',{exact:true}).click();
await Promise.all([page.waitForResponse(response=>response.url().endsWith('/collaboration')&&response.request().method()==='PUT'),page.getByRole('combobox',{name:'回应方式',exact:true}).selectOption('team')]); await page.waitForFunction(()=>document.querySelector('select[aria-label="回应方式"]')?.value==='team');
await page.getByRole('textbox',{name:'任务输入',exact:true}).fill('Preview two member responses');
writeFileSync('output/playwright/team-before-send.yml',await page.locator('body').ariaSnapshot()); const [submitted]=await Promise.all([page.waitForResponse(response=>response.url().endsWith('/room-commands')&&response.request().method()==='POST'),page.getByRole('button',{name:'发送',exact:true}).click()]); const command=await submitted.json();
await page.getByRole('button',{name:'批准此精确计划',exact:true}).waitFor();
await page.screenshot({path:'output/playwright/team-plan.png'});
const planned=await page.evaluate(async id=>(await(await fetch(`http://127.0.0.1:45327/multi/tasks/${id}`)).json()),command.taskId);
checks.push({check:'Manager creates two assigned packages before approval',ok:planned.state==='awaiting_plan_approval'&&planned.workPackages.length===2&&new Set(planned.workPackages.map(p=>p.executorAgentId)).size===2});
await page.getByRole('button',{name:'批准此精确计划',exact:true}).click();
await page.waitForFunction(async id=>(await(await fetch(`http://127.0.0.1:45327/multi/tasks/${id}`)).json()).state==='completed',command.taskId);
await page.getByText('Babbage: 模拟流式输出。完成。',{exact:true}).last().waitFor();
const task=await page.evaluate(async id=>(await(await fetch(`http://127.0.0.1:45327/multi/tasks/${id}`)).json()),command.taskId);
checks.push({check:'Approved UI task executes distinct members with dependency',ok:task.workPackages.every(p=>p.state==='completed')&&task.workPackages[1].dependencies[0]===task.workPackages[0].id&&task.summary.completed.length===2});
await page.screenshot({path:'output/playwright/team-completed.png'});
writeFileSync('output/playwright/team.yml',await page.locator('body').ariaSnapshot());
writeFileSync('output/playwright/team-checks.json',JSON.stringify({checks,errors,taskId:task.id},null,2));
console.log(JSON.stringify({checks,errors}));
if(checks.some(c=>!c.ok)||errors.length)process.exitCode=1;
} catch(error) {writeFileSync('output/playwright/team-failed.yml',await page.locator('body').ariaSnapshot());await page.screenshot({path:'output/playwright/team-failed.png'});throw error;}
finally {await browser.close();}
