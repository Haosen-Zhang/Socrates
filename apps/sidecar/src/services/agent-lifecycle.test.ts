import {test,expect} from 'bun:test';
import {openDb} from '../db';
import {SessionStore} from '../store/session-store';
import {ExecutionEventStore} from '../store/execution-event-store';
import {MemorySecrets} from '../secrets';
import {providerRoutes} from '../providers';
import {AgentLifecycleService} from './agent-lifecycle';
import {providerFingerprint,recordConnectionEvidence,CONNECTION_EVIDENCE_TTL_MS} from './provider-connection-evidence';
import {agentLifecycleRoutes} from '../routes/agent-lifecycle';
import {FlightRecorderService} from './flight-recorder';
import {flightRecorderRoutes} from '../routes/flight-recorder';
import {packageSetup} from '../multi-agent/test-fixtures';

function seed(db:ReturnType<typeof openDb>){
 const now=new Date().toISOString();
 db.query("INSERT INTO providers(id,name,type,base_url,api_key_ref,created_at,updated_at) VALUES('p','Controlled','openai','https://example.test','ref',?,?)").run(now,now);
 for(const id of ['a','b'])db.query('INSERT INTO agents(id,display_name,provider_id,model_id,model_capabilities_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,id,'p','model',JSON.stringify({toolCalling:true}),now,now);
 const secrets=new MemorySecrets();secrets.set('ref','controlled-fixture-key');return secrets;
}
function nativeRun(db:ReturnType<typeof openDb>,roomId:string,id:string,status:string,at=new Date().toISOString(),error:string|null=null){
 db.query('INSERT INTO agent_runs(id,session_id,prompt,status,error,created_at) VALUES(?,?,?,?,?,?)').run(id,roomId,'controlled prompt',status,error,at);
 new ExecutionEventStore(db).append({eventId:`created:${id}`,sessionId:roomId,runId:id,agentId:'a',type:'run.created',coordinates:{turnId:'turn:'+id},payload:{threadId:'thread',attemptNo:1}});
}
test('provider evidence is durable, expires, does not leak keys and invalidates on edits and delayed probe completion',async()=>{
 const db=openDb(':memory:'),secrets=seed(db);let now=Date.now();
 const service=new AgentLifecycleService(db,{secrets,runtimeReady:()=>true,now:()=>now});
 const app=providerRoutes(db,secrets,async()=>new Response('{"data":[]}',{status:200}));
 expect(service.presence('a')?.availability.state).toBe('unknown');
 await app.request('/p/test',{method:'POST'});now=Date.now();
 expect(service.presence('a')?.availability.state).toBe('ready');
 expect(service.presence('a')?.workload.state).toBe('idle');
 expect(JSON.stringify(db.query('SELECT * FROM provider_connection_evidence').all())).not.toContain('controlled-fixture-key');
 now+=CONNECTION_EVIDENCE_TTL_MS+1;expect(service.presence('a')?.availability.state).toBe('unknown');now=Date.now();
 const fingerprint=providerFingerprint(db.query('SELECT * FROM providers WHERE id=\'p\'').get() as Parameters<typeof providerFingerprint>[0]);
 await app.request('/p',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({apiKey:'replacement-fixture-key'})});
 recordConnectionEvidence(db,'p',fingerprint,'ok');expect(service.presence('a')?.availability.state).toBe('unknown');
 await providerRoutes(db,secrets,async()=>new Response('',{status:401})).request('/p/test',{method:'POST'});
 now=Date.now();expect(service.presence('a')?.availability.state).toBe('unavailable');expect(service.presence('a')?.workload.state).toBe('idle');db.close();
});
test('direct runs distinguish queue, workspace waiting, approval and terminal failure; history uses stable pagination',async()=>{
 const db=openDb(':memory:'),secrets=seed(db),sessions=new SessionStore(db);
 const room=sessions.create({title:'Controlled',mode:'chat',primaryAgentId:'a',agents:[{agentId:'a',snapshot:{},executionEligible:false}]});
 const service=new AgentLifecycleService(db,{secrets,runtimeReady:()=>true});
 nativeRun(db,room.id,'queued','preparing');expect(service.presence('a')?.workload.state).toBe('queued');
 new ExecutionEventStore(db).append({eventId:'wait',sessionId:room.id,runId:'queued',agentId:'a',type:'run.workspace_waiting',coordinates:{turnId:'turn:queued'},payload:{reason:'workspace_write_lease_busy'}});
 expect(service.presence('a')?.workload.state).toBe('workspace_waiting');
 db.query("UPDATE agent_runs SET status='awaiting_approval' WHERE id='queued'").run();expect(service.presence('a')?.workload.state).toBe('awaiting_approval');
 db.query("UPDATE agent_runs SET status='failed' WHERE id='queued'").run();expect(service.presence('a')?.workload.state).toBe('idle');expect(service.presence('a')?.availability.state).toBe('unknown');
 nativeRun(db,room.id,'paused','interrupted',new Date(Date.now()+1).toISOString(),'budget_exhausted');expect(service.presence('a')?.workload.state).toBe('paused');
 const first=service.detail('a',undefined,1)!;expect(first.recentRuns.runs[0]!.id).toBe('paused');
 nativeRun(db,room.id,'newer','running',new Date(Date.now()+2).toISOString());
 expect(service.detail('a',first.recentRuns.next!,1)?.recentRuns.runs[0]!.id).toBe('queued');
 expect((await agentLifecycleRoutes(service).request('/missing')).status).toBe(404);expect((await agentLifecycleRoutes(service).request('/a?limit=0')).status).toBe(400);
 db.query("DELETE FROM agent_runs WHERE id='newer'").run();expect(service.detail('a')?.recentRuns.runs.map(r=>r.id)).not.toContain('newer');db.close();
});
test('team package attempts, queue and leader planning remain visible without agent_runs; rewind removes projections',async()=>{
 const {db,store,definitions}=packageSetup(),secrets=seed(db),service=new AgentLifecycleService(db,{secrets,runtimeReady:()=>true});
 store.replacePlan('t',1,definitions);
 expect(service.presence('b')?.workload.state).toBe('queued');
 let p=store.start(store.ready('t')[0]!.id);store.setQueueReason(p.id,'workspace_write_lease_busy');expect(service.presence('a')?.workload.state).toBe('workspace_waiting');
 const events=new ExecutionEventStore(db);events.append({eventId:'package-create',sessionId:'s',runId:p.runId!,agentId:'a',type:'run.created',coordinates:{turnId:p.runId!},payload:{threadId:'thread',attemptNo:1}});
 events.append({eventId:'failed-provider',sessionId:'s',runId:p.runId!,agentId:'a',type:'provider.attempt.failed',coordinates:{turnId:p.runId!,stepId:'step',providerAttemptId:'pa'},payload:{attemptNo:1,error:{code:'provider_network_error',category:'network',message:'private-fixture-content',retryable:true,phase:'provider_connect'},outputStarted:false,willRetry:true}});
 events.append({eventId:'retry-provider',sessionId:'s',runId:p.runId!,agentId:'a',type:'provider.attempt.started',coordinates:{turnId:p.runId!,stepId:'step',providerAttemptId:'pb'},payload:{attemptNo:2}});
 events.append({eventId:'package-failed',sessionId:'s',runId:p.runId!,agentId:'a',type:'run.failed',coordinates:{turnId:p.runId!},payload:{error:'provider_network_error'}});
 store.finish(p.id,{status:'failed',runId:p.runId!,result:'',reason:'provider_network_error'});store.retry(p.id);p=store.start(p.id);
 expect(service.detail('a')?.recentRuns.runs).toHaveLength(2);expect(service.detail('a')?.recentRuns.runs.map(r=>r.attemptNo)).toEqual([2,1]);
 const recorder=new FlightRecorderService(db);const page=recorder.list('s',{limit:200});
 expect(page.records.some(r=>r.fields.errorCode==='provider_network_error'&&r.fields.willRetry===true)).toBe(true);
 expect(page.records.find(r=>r.id==='runtime:retry-provider')?.fields).toMatchObject({attemptNo:1,providerAttemptNo:2});
 expect(JSON.stringify(page)).not.toContain('private-fixture-content');expect(page.records.filter(r=>r.source==='run')).toHaveLength(2);
 const again=recorder.list('s',{limit:200});expect(again.records.map(r=>[r.id,r.sequence])).toEqual(page.records.map(r=>[r.id,r.sequence]));
 const app=flightRecorderRoutes(recorder,events);
 const firstRun=service.detail('a')!.recentRuns.runs.find(r=>r.attemptNo===1)!;
 const stream=await app.request(`/rooms/s/runs/${encodeURIComponent(firstRun.id)}/events?afterSeq=1`);expect(stream.status).toBe(200);const replay=await stream.text();expect(replay).toContain('timeline.invalidate');expect(replay).not.toContain('private-fixture-content');expect(replay).not.toContain('id: 1\n');
 expect((await app.request('/rooms/other/runs/'+encodeURIComponent('package:t/first:1')+'/events')).status).toBe(404);
 db.query("DELETE FROM multi_tasks WHERE id='t'").run();expect(service.detail('a')?.recentRuns.runs).toHaveLength(0);expect(recorder.list('s').records.filter(r=>['runtime','run','package'].includes(r.source))).toHaveLength(0);
 await recorder.shutdown();db.close();
});

test('model edits clear old capabilities and connection/credential evidence remains independently truthful',async()=>{
 const {agentRoutes}=await import('../agents');
 const db=openDb(':memory:'),secrets=seed(db),service=new AgentLifecycleService(db,{secrets,runtimeReady:()=>true});
 await providerRoutes(db,secrets,async()=>new Response('{}')).request('/p/test',{method:'POST'});
 expect(service.presence('a')?.availability.state).toBe('ready');
 const response=await agentRoutes(db).request('/a',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({modelId:'replacement-model'})});expect(response.status).toBe(200);
 expect(service.presence('a')?.availability).toMatchObject({state:'degraded',toolCalling:'unknown'});
 db.query("UPDATE agents SET model_id='' WHERE id='a'").run();expect(service.presence('a')?.availability).toMatchObject({state:'unavailable',reason:'configuration_incomplete'});
 db.query("UPDATE agents SET model_id='replacement-model' WHERE id='a'").run();secrets.delete('ref');expect(service.presence('a')?.availability.reason).toBe('credential_missing');
 expect(new AgentLifecycleService(db,{secrets,runtimeReady:()=>false}).presence('b')?.availability.state).toBe('unavailable');db.close();
});

test('actual controlled Native completion, safe tool evidence and context rewind leave no ghost runs',async()=>{
 const {setupCostFlowFixture,untilCostFlow}=await import('./cost-flow-fixture');
 const f=await setupCostFlowFixture();
 try{
  const room=f.sessions.get(f.roomIds.work)!;f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});
  const command=await f.commands.submit({roomId:room.id,clientRequestId:'lifecycle-rewind',content:'Create the controlled result',intent:'execute',mentions:[]});
  await untilCostFlow(()=>f.commands.get(command.commandId)?.status==='completed','lifecycle controlled completion');
  const before=f.agentLifecycle.detail('fixture-a')!;expect(before.recentRuns.runs).toHaveLength(1);expect(before.statistics.completedRuns).toBe(1);expect(before.cost.invocations).toBeGreaterThan(0);
  const page=f.flightRecorder.list(room.id,{rootTaskId:command.commandId,limit:200});expect(page.records.some(r=>r.source==='runtime')).toBe(true);
  const tool=page.records.find(r=>r.type==='tool.write_file')!;expect(tool).toBeTruthy();
  const diff=f.flightRecorder.artifactDiff(room.id,String(tool.fields.toolCallId));expect(diff.basis).toBe('recorded_tool_output');expect(diff.patch).toContain('+++ b/result.txt');expect(diff.newSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(()=>f.flightRecorder.artifactDiff(f.roomIds.chat,String(tool.fields.toolCallId))).toThrow('artifact_diff_not_found');
  const message=f.sessions.listMessages(room.id).find(m=>m.role==='user')!;await f.sessions.rewind(room.id,message.id);
  expect(f.agentLifecycle.detail('fixture-a')?.recentRuns.runs).toHaveLength(0);
  expect(f.agentLifecycle.presence('fixture-a')?.workload.state).toBe('idle');
  expect(f.flightRecorder.list(room.id,{rootTaskId:command.commandId,limit:200}).records).toHaveLength(0);
  expect(f.agentLifecycle.detail('fixture-a')?.cost.invocations).toBe(before.cost.invocations);expect(()=>f.flightRecorder.artifactDiff(room.id,String(tool.fields.toolCallId))).toThrow('artifact_diff_not_found');
 }finally{await f.close();}
});

test('planner and reviewer turns are counted separately from Native attempts and active leader work uses real turns',()=>{
 const {db}=packageSetup();seed(db);const service=new AgentLifecycleService(db);
 const now=new Date().toISOString();db.query("UPDATE multi_tasks SET state='synthesizing',config_json=? WHERE id='t'").run(JSON.stringify({synthesizerId:'a'}));
 db.query("INSERT INTO multi_task_attempts(id,task_id,attempt_no,status,started_at) VALUES('attempt','t',1,'active',?)").run(now);
 db.query("INSERT INTO multi_turns(id,task_id,attempt_id,stable_key,phase,round,participant_index,agent_id,snapshot_json,status,started_at) VALUES('plan-turn','t','attempt','plan-turn','synthesizing',1,0,'a','{}','running',?)").run(now);
 expect(service.presence('a')?.workload.items).toHaveLength(1);expect(service.presence('a')?.workload.items[0]?.kind).toBe('discussion');
 expect(service.detail('a')?.statistics).toMatchObject({totalRuns:0,discussionTurns:1});
 db.query("UPDATE multi_tasks SET state='cancelled' WHERE id='t'").run();expect(service.presence('a')?.workload.state).toBe('idle');db.close();
});

test('connection evidence survives database reopen while actual availability is recomputed',async()=>{
 const {mkdtempSync,rmSync}=await import('node:fs');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
 const directory=mkdtempSync(join(tmpdir(),'agent-presence-'));let db=openDb(join(directory,'fixture.db'));
 try{
  const secrets=seed(db);await providerRoutes(db,secrets,async()=>new Response('{}')).request('/p/test',{method:'POST'});
  db.close();db=openDb(join(directory,'fixture.db'));
  expect(new AgentLifecycleService(db,{secrets,runtimeReady:()=>true}).presence('a')?.availability.state).toBe('ready');
  db.query("UPDATE providers SET enabled=0 WHERE id='p'").run();
  expect(new AgentLifecycleService(db,{secrets,runtimeReady:()=>true}).presence('a')).toMatchObject({availability:{state:'unavailable'},workload:{state:'idle'}});
 }finally{db.close();rmSync(directory,{recursive:true,force:true});}
});

test('runtime timeline pagination preserves durable event order, room scope and safe arguments',async()=>{
 const {toolArgumentSummary}=await import('./flight-recorder');
 expect(toolArgumentSummary({path:'/private/fixture',command:'secret arbitrary command',content:'private source',apiKey:'fake-sensitive'})).toBe('path:string:16 command:string:24 content:string:14');
 const db=openDb(':memory:');seed(db);const sessions=new SessionStore(db);
 const create=(title:string)=>sessions.create({title,mode:'chat',primaryAgentId:'a',agents:[{agentId:'a',snapshot:{},executionEligible:false}]}).id;
 const room=create('A'),other=create('B');nativeRun(db,room,'long','completed');
 const events=new ExecutionEventStore(db);for(let i=0;i<115;i++)events.append({eventId:`long:${i}`,sessionId:room,runId:'long',agentId:'a',type:'runtime.event',coordinates:{turnId:'turn:long'},payload:{runtimeSessionId:'runtime',event:{type:'status',status:'running'}}});
 const recorder=new FlightRecorderService(db);try{
  let after=0;const ids:string[]=[],seq:number[]=[];
  do{const page=recorder.list(room,{runId:'long',after,limit:25});ids.push(...page.records.map(r=>r.id));seq.push(...page.records.filter(r=>r.source==='runtime').map(r=>r.sourceSequence));if(page.next===null)break;after=page.next;}while(true);
  expect(new Set(ids).size).toBe(ids.length);expect(seq).toEqual(Array.from({length:116},(_,i)=>i+1));expect(recorder.list(other).records).toHaveLength(0);
  expect(recorder.list(room,{runId:'long',after:0,limit:25}).records.map(r=>r.id)).toEqual(ids.slice(0,25));
 }finally{await recorder.shutdown();db.close();}
});

test('standalone supervisor Run rewind hides its timeline without needing a room-command tombstone',async()=>{
 const {setupCostFlowFixture,untilCostFlow}=await import('./cost-flow-fixture');const f=await setupCostFlowFixture();
 try{
  const started=await f.supervisor.start({sessionId:f.roomIds.work,runtimeKind:'native_ai_sdk',prompt:'Standalone controlled write',clientTurnKey:'standalone-lifecycle'});
  await untilCostFlow(()=>f.supervisor.get(started.runId)?.status==='completed','standalone completion');
  expect(f.flightRecorder.list(f.roomIds.work,{rootTaskId:started.runId}).records.length).toBeGreaterThan(0);
  const message=f.sessions.listMessages(f.roomIds.work).find(m=>m.role==='user')!;await f.sessions.rewind(f.roomIds.work,message.id);
  expect(f.flightRecorder.list(f.roomIds.work,{rootTaskId:started.runId}).records).toHaveLength(0);
  expect(f.agentLifecycle.detail('fixture-a')?.recentRuns.runs).toHaveLength(0);expect(f.agentLifecycle.detail('fixture-a')?.cost.invocations).toBeGreaterThan(0);
 }finally{await f.close();}
});

test.each([false,true])('older adaptive team children keep their frozen root and cursor after parent advances (already projected: %s)',async(alreadyProjected)=>{
 const {db,store,definitions}=packageSetup();seed(db);
 const lifecycle=new AgentLifecycleService(db),recorder=new FlightRecorderService(db),events=new ExecutionEventStore(db);
 try{
  store.replacePlan('t',1,definitions);let item=store.start(store.ready('t')[0]!.id);
  for(let attemptNo=1;attemptNo<=2;attemptNo++){
   events.append({eventId:`old-child:${attemptNo}:created`,sessionId:'s',runId:item.runId!,agentId:'a',type:'run.created',coordinates:{turnId:item.runId!},payload:{threadId:'thread',attemptNo}});
   events.append({eventId:`old-child:${attemptNo}:failed`,sessionId:'s',runId:item.runId!,agentId:'a',type:'run.failed',coordinates:{turnId:item.runId!},payload:{error:'provider_network_error'}});
   store.finish(item.id,{status:'failed',runId:item.runId!,result:'',reason:'provider_network_error'});
   if(attemptNo===1){store.retry(item.id);item=store.start(item.id);}
  }
  const now=new Date().toISOString();
  db.query("INSERT INTO multi_task_attempts(id,task_id,attempt_no,status,started_at) VALUES('old-turn-attempt','t',1,'active',?)").run(now);
  for(const phase of ['synthesizing','reviewing'])db.query("INSERT INTO multi_turns(id,task_id,attempt_id,stable_key,phase,round,participant_index,agent_id,snapshot_json,status,started_at,completed_at) VALUES(?,'t','old-turn-attempt',?,?,1,0,'a','{}','completed',?,?)").run('old-'+phase,'old-'+phase,phase,now,now);
  const previous=alreadyProjected?recorder.list('s',{rootTaskId:'t',limit:200}).records.filter(r=>r.source!=='root'):[];
  expect(alreadyProjected?previous.length>0:true).toBe(true);
  db.query("UPDATE multi_tasks SET config_json=? WHERE id='t'").run(JSON.stringify({costRootTaskId:'root-command'}));
  db.exec("INSERT INTO multi_tasks(id,session_id,prompt,state,config_json,created_at,updated_at) VALUES('new-child','s','next','executing','{}','now','now'); INSERT INTO room_commands(id,room_id,client_request_id,fingerprint,input_json,kind,status,task_id,created_at,updated_at) VALUES('root-command','s','root-request','fixture','{}','team','running','new-child','now','now')");
  const recent=lifecycle.detail('a')!.recentRuns.runs;expect(recent.map(r=>r.rootTaskId)).toEqual(Array(4).fill('root-command'));expect(recent.filter(r=>r.kind==='discussion')).toHaveLength(2);
  let after=0;const linked:import('@socrates/core').FlightRecord[]=[];
  do{const page=recorder.list('s',{rootTaskId:recent[0]!.rootTaskId,after,limit:2});linked.push(...page.records);if(page.next===null)break;after=page.next;}while(true);
  expect(linked.filter(r=>r.source==='run')).toHaveLength(2);expect(linked.filter(r=>r.source==='runtime')).toHaveLength(4);expect(linked.filter(r=>r.source==='package')).toHaveLength(2);expect(linked.filter(r=>r.source==='discussion')).toHaveLength(2);
  expect(new Set(linked.map(r=>r.id)).size).toBe(linked.length);expect(linked.every(r=>r.rootTaskId==='root-command')).toBe(true);expect(linked.every(r=>r.parentId!=='root:t')).toBe(true);
  for(const before of previous)expect(linked.find(r=>r.id===before.id)?.sequence).toBe(before.sequence);
  expect(recorder.list('s',{rootTaskId:'t'}).records).toHaveLength(0);
  const again=recorder.list('s',{rootTaskId:'root-command',limit:200});expect(again.records.map(r=>[r.id,r.sequence])).toEqual(linked.map(r=>[r.id,r.sequence]));
 }finally{await recorder.shutdown();db.close();}
});
