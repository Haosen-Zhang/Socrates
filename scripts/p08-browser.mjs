// Fresh production UI acceptance with disposable databases/workspaces and local model doubles.
// Reuses phase acceptance flows without changing their standalone entry points.
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,existsSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
const root=process.cwd(), scratch=mkdtempSync(join(tmpdir(),'socrates-p08-browser-'));
const out=resolve('output/playwright/p08');mkdirSync(out,{recursive:true});
const port=process.env.SOCRATES_P08_UI_PORT??'45358';
// Install Playwright locally (without saving) or pass an absolute SOCRATES_PLAYWRIGHT_MODULE.
const resolveModule=createRequire(resolve('package.json'));
const env={...process.env,SOCRATES_PLAYWRIGHT_MODULE:resolveModule.resolve(process.env.SOCRATES_PLAYWRIGHT_MODULE??'playwright')};
const processes=[],results=[];
const selected=new Set((process.env.SOCRATES_P08_FLOWS??'cost-aware,routing,verification,project-memory,flight-recorder,arena,p08-interactions,p08-stress').split(','));
const start=(cmd,args,log)=>{const p=spawn(cmd,args,{cwd:root,env,stdio:['ignore','pipe','pipe']});processes.push(p);let output='';p.stdout.on('data',b=>output+=b);p.stderr.on('data',b=>output+=b);p.on('exit',()=>writeFileSync(join(out,log),output));return p;};
const until=async(fn)=>{for(let i=0;i<300;i++){if(await fn())return;await new Promise(r=>setTimeout(r,100));}throw Error('Fixture readiness timed out');};
const run=async(name)=>{let code=readFileSync(`scripts/${name}-browser.mjs`,'utf8');for(const [from,to] of metadata)code=code.replaceAll(from,to);code=code.replaceAll('http://127.0.0.1:45338',`http://127.0.0.1:${port}`).replaceAll('http://127.0.0.1:45348',`http://127.0.0.1:${port}`).replaceAll(`output/playwright/${name}`,`${out}/${name}`);const path=join(scratch,`${name}.mjs`);writeFileSync(path,code);const p=start('node',[path],`${name}.log`);const exitCode=await new Promise(r=>p.on('exit',r));results.push({name,exitCode});console.log(name,exitCode);};
const metadata=[['/private/tmp/socrates-routing-browser-fixture.json',join(scratch,'routing.json')],['/private/tmp/socrates-verification-browser-fixture.json',join(scratch,'verification.json')],['/private/tmp/socrates-p05-p07-browser.json',join(scratch,'delivery.json')],['/private/tmp/socrates-cost-fixture.json',join(scratch,'cost.json')],['/private/tmp/socrates-p08-stress.json',join(scratch,'stress.json')]];
try{
start('bun',['run','--cwd','apps/desktop','dev','--host','127.0.0.1','--port',port,'--strictPort'],'vite.log');
await until(async()=>fetch(`http://127.0.0.1:${port}`).then(r=>r.ok).catch(()=>false));
for(const [index,name,flows] of [[4,'p08-stress',['p08-stress']],[3,'cost-aware',['cost-aware']],[0,'routing',['routing']],[1,'verification',['verification']],[2,'p05-p07',['project-memory','flight-recorder','arena']]]){
if(!flows.some(flow=>selected.has(flow))&&!(name==='p05-p07'&&selected.has('p08-interactions')))continue;
let code=readFileSync(`scripts/${name==='cost-aware'?'cost-aware-fixture':name+'-browser-fixture'}.ts`,'utf8').replaceAll('../apps/sidecar',resolve('apps/sidecar')).replaceAll(metadata[index][0],metadata[index][1]);
code=code.replace('console.log(JSON.stringify({ metadataPath, ...metadata }));','console.log(JSON.stringify({ metadataPath, source: metadata.source }));');
const path=join(scratch,`${name}.ts`);writeFileSync(path,code);const fixture=start('bun',[path],`${name}-fixture.log`);await until(()=>existsSync(metadata[index][1]));
for(const flow of flows)if(selected.has(flow))await run(flow);
if(name==='p05-p07'&&selected.has('p08-interactions')&&existsSync('scripts/p08-interactions-browser.mjs'))await run('p08-interactions');
fixture.kill('SIGTERM');await new Promise(r=>fixture.once('exit',r));
}
}finally{for(const p of processes)if(p.exitCode===null)p.kill('SIGTERM');writeFileSync(join(out,'runs.json'),JSON.stringify({source:'production UI with local synthetic providers',results},null,2));rmSync(scratch,{recursive:true,force:true});}
if(results.some(r=>r.exitCode!==0))process.exitCode=1;
