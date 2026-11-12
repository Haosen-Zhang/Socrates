import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '../apps/sidecar/src/store/migrations';
import { migrations } from '../apps/sidecar/src/store/migrations/index';
import { SessionStore } from '../apps/sidecar/src/store/session-store';
const directory=mkdtempSync(join(tmpdir(),'socrates-m07-compatibility-'));
const fresh=join(directory,'fresh'),upgrade=join(directory,'upgrade');mkdirSync(fresh);mkdirSync(upgrade);
const db=new Database(join(upgrade,'socrates.db'));runMigrations(db,migrations.filter(m=>m.version<=22));
const sessions=new SessionStore(db);
const room=sessions.create({title:'Synthetic Alpha.1 history',kind:'chat',mode:'chat',primaryAgentId:'historic-agent',agents:[{agentId:'historic-agent',snapshot:{nickname:'Frozen Alpha member',modelId:'legacy-model',providerId:'missing-provider',avatar:'/avatars/owl-engineer.webp'},executionEligible:false}]});
db.query("INSERT INTO session_messages(id,session_id,role,kind,content,status,created_at) VALUES('historic-message',?,'assistant','text','Synthetic Alpha.1 message retained after upgrade','completed','2026-01-01')").run(room.id);const projects=[];
for(let i=1;i<=2;i++){
 const path=join(directory,`project-${i}`);mkdirSync(path);const id=`synthetic-project-${i}`;
 db.query('INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES(?,?,?,?,?,?,?)').run(id,path,path,id,`Synthetic project ${i}`,'before','before');
 const work=sessions.create({title:`Alpha Work ${i}`,kind:'cowork',mode:'single_agent',workspaceId:id,primaryAgentId:'historic-agent',agents:[{agentId:'historic-agent',snapshot:{nickname:'Frozen Alpha member',modelId:'legacy-model',providerId:'missing-provider',avatar:'/avatars/owl-engineer.webp'},executionEligible:false}]});
 db.query("INSERT INTO session_messages(id,session_id,role,kind,content,status,created_at) VALUES(?,?,'assistant','text',?,'completed','2026-01-01')").run(`history-${i}`,work.id,`Synthetic project ${i} private context`);projects.push({workspaceId:id,roomId:work.id});
}
db.close();
async function start(path:string){
 const child=Bun.spawn(['bun','apps/sidecar/src/index.ts'],{env:{...process.env,SOCRATES_DATA_DIR:path},stdout:'pipe',stderr:'inherit'});
 const reader=child.stdout.getReader();let text='';
 while(!text.includes('\n')){const part=await reader.read();if(part.done)throw new Error('Missing production handshake');text+=new TextDecoder().decode(part.value);}
 reader.releaseLock();return {child,handshake:JSON.parse(text.split('\n')[0]!)};
}
const a=await start(fresh),b=await start(upgrade),path='/private/tmp/socrates-m07-compatibility.json';
writeFileSync(path,JSON.stringify({source:'synthetic-m07-compatibility',pid:process.pid,directory,fresh:a.handshake,upgrade:b.handshake,roomId:room.id,projects}));console.log('M07 production startup fixtures ready');
let closing=false;for(const signal of ['SIGTERM','SIGINT'] as const)process.on(signal,()=>{if(closing)return;closing=true;a.child.kill();b.child.kill();void Promise.all([a.child.exited,b.child.exited]).finally(()=>{rmSync(directory,{recursive:true,force:true});try{unlinkSync(path);}catch{}process.exit(0);});});
await Promise.all([a.child.exited,b.child.exited]);
