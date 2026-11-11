import {expect,test} from 'bun:test';
import {setupCostFlowFixture,untilCostFlow} from './cost-flow-fixture';
import {WorkInteractionService} from './work-interactions';
import {EventStore} from '../store/event-store';
import {LEADER_LIMITS,type WorkInteractionInput} from '@socrates/core';
type Fixture=Awaited<ReturnType<typeof setupCostFlowFixture>>;
const input=(id:string,extra:Partial<WorkInteractionInput>={}):WorkInteractionInput=>({clientRequestId:id,action:'message',content:'Inspect the existing result',mentions:[],...extra});
const create=(f:Fixture)=>f.workItems.create({workspaceId:f.workspace.id,title:'Inspect context',objective:'Read context.txt',acceptanceCriteria:['Report findings'],ownerKind:'user',priority:'normal'});
async function squadItem(f:Fixture){
 const squad=f.squads.create({workspaceId:f.workspace.id,name:'Delivery',avatar:null,description:'',instructions:'',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'},{agentId:'fixture-b',responsibility:'Build'}]});
 const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});
 await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'launch'});
 await untilCostFlow(()=>f.workItems.get(item.id)?.currentRun?.commandStatus==='awaiting_plan_approval','plan');
 return {item:f.workItems.get(item.id)!,squad,roomId:preview.executionRoomId};
}
test('durable unbound notes and review requests are idempotent, free and resolve Inbox without resurrection',async()=>{
 const f=await setupCostFlowFixture();try{
  const item=create(f),scope={workItemId:item.id},note=input('note',{action:'note',content:'@fixture-a is ordinary text'});
  const a=await f.interactions.submit(scope,note),b=await f.interactions.submit(scope,note);expect(a.id).toBe(b.id);expect(a.status).toBe('saved');
  const review=await f.interactions.submit(scope,input('review',{action:'request_human_review'}));
  const first=f.inbox.list(f.workspace.id);expect(first.items).toHaveLength(1);expect(first.notifications).toHaveLength(1);
  const second=f.inbox.list(f.workspace.id);expect(second.notifications).toEqual(first.notifications);
  f.inbox.read(first.items[0]!.id,first.items[0]!.revision);expect(f.inbox.list().notifications).toHaveLength(0);
  f.interactions.resolve(scope,review.id,'Reviewed locally');expect(f.inbox.list().items).toHaveLength(0);expect(f.inbox.list().notifications).toHaveLength(0);
  await expect(f.interactions.submit(scope,{...note,content:'changed'})).rejects.toThrow('client_request_conflict');
  expect(f.gatewayCalls).toHaveLength(0);expect(f.nativeCalls).toHaveLength(0);expect(f.interactions.list(scope)).toHaveLength(2);
 }finally{await f.close();}
});
test('explicit agent in team room only calls that member; frozen owner stays independent; HTTP rejects prepared-room bypass',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {item,roomId,squad}=await squadItem(f),scope={workItemId:item.id};
  const request=input('mention',{mentions:[{type:'agent',agentId:'fixture-b'}],delivery:'stop_restart'});
  const preview=f.interactions.preview(scope,request);expect(preview.agentIds).toEqual(['fixture-b']);expect(preview.changesOwner).toBe(false);expect(preview.canSubmit).toBe(true);
  const next=await f.interactions.submit(scope,request);expect(next.status).toBe('dispatched');
  await untilCostFlow(()=>f.commands.get(next.commandId!)?.status==='completed','mention complete');
  expect(f.nativeCalls.map(c=>c.model)).toEqual(['fixture-model-b']);expect(f.gatewayCalls.map(c=>c.purpose)).toEqual(['plan']);
  expect(f.workItems.get(item.id)!.ownerId).toBe(squad.id);expect(f.workItems.get(item.id)!.currentRun!.commandStatus).toBe('cancelled');
  const calls=f.nativeCalls.length;await f.interactions.submit(scope,request);expect(f.nativeCalls).toHaveLength(calls);
  const note=await f.app.request(`/room-commands/rooms/${roomId}/interactions`,{method:'POST',headers:f.headers,body:JSON.stringify(input('room-note',{action:'note'}))});expect(note.status).toBe(202);expect(f.interactions.list(scope).some(i=>i.input.clientRequestId==='room-note')).toBe(true);
  const unstarted=create(f),pending=f.workItemLaunch.preview(unstarted.id,{expectedRevision:unstarted.revision,ownerKind:'agent',ownerId:'fixture-a'});
  const bypass=await f.app.request(`/room-commands/rooms/${pending.executionRoomId}/interactions`,{method:'POST',headers:f.headers,body:JSON.stringify({...input('bypass'),workItemRunId:item.currentRun!.id})});expect(bypass.status).toBe(409);
  const invalid=f.interactions.preview(scope,input('invalid',{mentions:[{type:'squad',squadId:'not-binding'}]}));expect(invalid.canSubmit).toBe(false);
  const leader=f.interactions.preview(scope,input('squad',{mentions:[{type:'squad',squadId:squad.id}]}));expect(leader.agentIds).toEqual(['fixture-a']);
 }finally{await f.close();}
});
test('queue persists across service restart, pumps after settlement and dispatches once without a browser',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});let recovered:WorkInteractionService|undefined;try{
  const {item}=await squadItem(f),scope={workItemId:item.id};
  const queued=await f.interactions.submit(scope,input('queued',{mentions:[{type:'agent',agentId:'fixture-b'}],delivery:'queue'}));expect(queued.status).toBe('queued');
  await f.interactions.shutdown();
  recovered=new WorkInteractionService(f.db,f.workItems,f.sessions,f.commands,f.coordinator,f.tasks,f.team,f.packages);recovered.start(5);
  expect(recovered.get(queued.id)!.status).toBe('queued');await f.commands.cancel(item.currentRun!.commandId!);
  await untilCostFlow(()=>recovered!.get(queued.id)?.status==='dispatched','durable queue');
  const commandId=recovered.get(queued.id)!.commandId!;await untilCostFlow(()=>f.commands.get(commandId)?.status==='completed','queued result');
  await recovered.pump();expect(f.nativeCalls).toHaveLength(1);expect(f.commands.list(queued.roomId!).filter(c=>c.kind==='direct')).toHaveLength(1);
 }finally{await recovered?.shutdown();await f.close();}
});
test('unknown side effects block queued dispatch after cancellation and remain actionable in Inbox',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {item,roomId}=await squadItem(f),scope={workItemId:item.id};
  const queued=await f.interactions.submit(scope,input('queue',{delivery:'queue',mentions:[{type:'agent',agentId:'fixture-b'}]}));
  f.db.query(`INSERT INTO tool_calls(id,stable_key,session_id,task_id,attempt_id,turn_id,agent_id,name,generation,input_json,input_hash,workspace_identity,policy_version,risk,idempotency,status,created_at,updated_at) VALUES('uncertain','uncertain',?,'old-run','attempt','turn','fixture-a','run_shell',1,'{}','hash','workspace',1,'high','non_idempotent','outcome_unknown',?,?)`).run(roomId,new Date().toISOString(),new Date().toISOString());
  await f.commands.cancel(item.currentRun!.commandId!);await f.interactions.pump();
  expect(f.interactions.get(queued.id)!.status).toBe('blocked');expect(f.nativeCalls).toHaveLength(0);
  const inbox=f.inbox.list();expect(inbox.items.some(i=>i.kind==='unknown_side_effect'&&i.link.workItemId===item.id)).toBe(true);
  expect(f.interactions.preview(scope,input('restart',{delivery:'stop_restart'})).canSubmit).toBe(false);
 }finally{await f.close();}
});
test('Leader evaluates one event batch with bounded real broker calls and never self-wakes from summaries',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {item,roomId}=await squadItem(f),taskId=f.commands.get(item.currentRun!.commandId!)!.taskId!;
  const events=new EventStore(f.db);
  events.append({eventId:'member-a-report',sessionId:roomId,taskId,type:'multi.package_finished',payload:{id:'first',attemptNo:1,state:'completed'}});
  events.append({eventId:'member-b-report',sessionId:roomId,taskId,type:'multi.package_finished',payload:{id:'second',attemptNo:1,state:'completed'}});
  await untilCostFlow(()=>f.db.query<{n:number},[]>("SELECT COUNT(*) n FROM leader_evaluations WHERE status='no_action'").get()!.n===1,'evaluation');
  expect(f.gatewayCalls.filter(c=>c.purpose==='review')).toHaveLength(1);expect(f.gatewayCalls.at(-1)!.maxOutputTokens).toBe(LEADER_LIMITS.maxOutputTokens);
  const invocation=f.broker.ledger.list({rootTaskId:item.currentRun!.commandId!}).find(c=>c.purpose==='review');expect(invocation!.rootTaskId).toBe(item.currentRun!.commandId!);
  events.append({eventId:'same-report-new-envelope',sessionId:roomId,taskId,type:'multi.package_finished',payload:{id:'first',attemptNo:1,state:'completed'}});
  events.append({eventId:'leader-summary',sessionId:roomId,taskId,type:'multi.summary',payload:{agentId:'fixture-a',content:'@fixture-b'}});
  await f.interactions.pump();expect(f.gatewayCalls.filter(c=>c.purpose==='review')).toHaveLength(1);
  const turns=f.db.query<{phase:string;status:string},[]>("SELECT phase,status FROM multi_turns WHERE phase='leader_evaluation'").all();expect(turns).toEqual([{phase:'leader_evaluation',status:'completed'}]);
 }finally{await f.close();}
});
test('real TeamRunner package completion automatically schedules bounded Leader evaluation and Inbox review',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {item}=await squadItem(f),taskId=f.commands.get(item.currentRun!.commandId!)!.taskId!,plan=f.tasks.getPlan(taskId)!;
  const response=await f.app.request(`/multi/tasks/${taskId}/plan-decisions`,{method:'POST',headers:f.headers,body:JSON.stringify({version:plan.version,hash:plan.contentHash,clientDecisionKey:'approve',decision:'approve_exact_plan'})});expect(response.status).toBe(200);
  await untilCostFlow(()=>f.db.query<{n:number},[]>("SELECT COUNT(*) n FROM leader_evaluations WHERE status='no_action'").get()!.n===1,'real reports');
  expect(f.packages.list(taskId).every(p=>p.state==='completed')).toBe(true);
  expect(f.db.query<{n:number},[]>("SELECT COUNT(*) n FROM leader_report_receipts WHERE event_id LIKE 'package-report:%'").get()!.n).toBeGreaterThanOrEqual(2);
  expect(f.inbox.list().items.some(i=>i.kind==='human_review'&&i.link.workItemId===item.id)).toBe(true);
  const current=f.workItems.get(item.id)!;f.workItems.review(item.id,current.revision,'accept');expect(f.inbox.list().items.some(i=>i.id.startsWith('review:'))).toBe(false);
 }finally{await f.close();}
});
test('explicit re-evaluation preserves approval and terminal plans; strict output and maximum calls stop safely',async()=>{
 const f=await setupCostFlowFixture({leaderDecision:{action:'human_review',reason:'New plan needs approval.'}});try{
  const {item}=await squadItem(f),scope={workItemId:item.id},taskId=f.commands.get(item.currentRun!.commandId!)!.taskId!,plan=f.tasks.getPlan(taskId)!;
  for(let i=0;i<LEADER_LIMITS.maxEvaluations;i++){
   const response=await f.app.request(`/work-items/${item.id}/interactions`,{method:'POST',headers:f.headers,body:JSON.stringify(input('evaluate-'+i,{action:'reevaluate'}))});expect(response.status).toBe(202);
  }
  expect(f.gatewayCalls.filter(c=>c.purpose==='review')).toHaveLength(LEADER_LIMITS.maxEvaluations);
  expect(f.interactions.preview(scope,input('exhausted',{action:'reevaluate'})).canSubmit).toBe(false);
  expect(f.tasks.getPlan(taskId)!.contentHash).toBe(plan.contentHash);expect(f.nativeCalls).toHaveLength(0);
  const entry=f.inbox.list().items.find(i=>i.link.evaluationId)!;expect(entry.kind).toBe('human_review');
  f.interactions.resolveEvaluation(item.id,entry.link.evaluationId!,'Reviewed: keep existing approved workflow');
  expect(f.inbox.list().items.some(i=>i.id===entry.id)).toBe(false);
 }finally{await f.close();}
});
test('temporary execution inherits existing owner budget instead of bypassing zero dollars',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a',budget:{mode:'strict_admission',limitAtomic:'0'}});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'zero'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.currentRun?.commandStatus==='interrupted','root budget pause');
  const next=await f.interactions.submit({workItemId:item.id},input('next',{delivery:'stop_restart',mentions:[{type:'agent',agentId:'fixture-a'}]}));
  await untilCostFlow(()=>f.commands.get(next.commandId!)?.status==='interrupted','child budget pause');
  expect(f.nativeCalls).toHaveLength(0);expect(f.broker.budgets.get(next.commandId!)!.parentId).toBe(f.workItems.get(item.id)!.currentRun!.commandId!);
 }finally{await f.close();}
});
test('approved ready delegation reuses TeamRunner and never rewrites approved package history',async()=>{
 const decision={action:'delegate_package',reason:'Continue the approved ready package',packageId:''};
 const f=await setupCostFlowFixture({leaderDecision:decision,nativeToolCalls:()=>[]});try{
  const {item}=await squadItem(f),taskId=f.commands.get(item.currentRun!.commandId!)!.taskId!,plan=f.tasks.getPlan(taskId)!;
  decision.packageId=f.packages.list(taskId)[0]!.id;
  f.tasks.decidePlan({taskId,version:plan.version,hash:plan.contentHash,clientDecisionKey:'approved',decision:'approve_exact_plan'});
  expect(f.tasks.get(taskId)!.state).toBe('executing');
  await f.interactions.submit({workItemId:item.id},input('delegate',{action:'delegate_package',packageId:decision.packageId}));
  expect(f.packages.list(taskId).every(p=>p.state==='completed')).toBe(true);
  expect(f.db.query<{n:number},[]>("SELECT COUNT(*) n FROM leader_evaluations WHERE status='delegated'").get()!.n).toBe(1);
  expect(f.tasks.getPlan(taskId)!.contentHash).toBe(plan.contentHash);expect(f.nativeCalls.length).toBeGreaterThan(0);
 }finally{await f.close();}
});
test('invalid Leader decision and interrupted pending call fail closed without automatic replay',async()=>{
 const f=await setupCostFlowFixture({leaderDecision:{action:'execute_shell',reason:'Not an allowed structured action'}});let recovered:WorkInteractionService|undefined;try{
  const {item}=await squadItem(f),scope={workItemId:item.id};
  await f.interactions.submit(scope,input('bad',{action:'reevaluate'}));
  const row=f.db.query<{id:string;status:string;reason:string},[]>('SELECT * FROM leader_evaluations').get()!;expect(row.status).toBe('blocked');expect(row.reason).toBe('leader_output_invalid');expect(f.nativeCalls).toHaveLength(0);
  await f.interactions.shutdown();f.db.query("UPDATE leader_evaluations SET status='running' WHERE id=?").run(row.id);
  recovered=new WorkInteractionService(f.db,f.workItems,f.sessions,f.commands,f.coordinator,f.tasks,f.team,f.packages);recovered.start(5);await recovered.pump();
  expect(f.db.query<{status:string},[string]>('SELECT status FROM leader_evaluations WHERE id=?').get(row.id)!.status).toBe('blocked');expect(f.gatewayCalls.filter(c=>c.purpose==='review')).toHaveLength(1);
 }finally{await recovered?.shutdown();await f.close();}
});
test('Will trigger alreadyQueued reflects durable target-specific instructions, not a future queue intent',async()=>{
 const f=await setupCostFlowFixture();try{
  const {item}=await squadItem(f),scope={workItemId:item.id};
  const request=input('queued-fact',{delivery:'queue',mentions:[{type:'agent',agentId:'fixture-b'}]});
  const before=f.interactions.preview(scope,request);expect(before.targets[0]!.alreadyQueued).toBe(false);expect(before.queued).toBe(false);
  await f.interactions.submit(scope,request);
  const after=f.interactions.preview(scope,request);expect(after.targets[0]!.alreadyQueued).toBe(true);expect(after.queued).toBe(true);
  expect(f.interactions.preview(scope,input('different',{delivery:'queue',mentions:[{type:'agent',agentId:'fixture-a'}]})).targets[0]!.alreadyQueued).toBe(false);
 }finally{await f.close();}
});
for(const pendingState of ['created','sent','outcome_unknown'] as const)test(`unsettled ${pendingState} model cost blocks queue dispatch and restart without a dollar budget`,async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {item}=await squadItem(f),scope={workItemId:item.id};
  const queued=await f.interactions.submit(scope,input('cost-queue',{delivery:'queue',mentions:[{type:'agent',agentId:'fixture-b'}]}));
  const original=f.broker.ledger.list({rootTaskId:item.currentRun!.commandId!})[0]!;
  f.broker.ledger.begin({...original,invocationId:'unsettled-model',logicalStepId:'unsettled-step'},original.priceSnapshotId);
  if(pendingState!=='created')f.broker.ledger.markSent('unsettled-model');
  if(pendingState==='outcome_unknown')f.broker.ledger.markUnknown('unsettled-model');
  await f.commands.cancel(item.currentRun!.commandId!);await f.interactions.pump();
  expect(f.interactions.get(queued.id)!.status).toBe('blocked');expect(f.interactions.get(queued.id)!.reason).toBe('model_cost_settlement_required');
  const restart=input('cost-restart',{delivery:'stop_restart',mentions:[{type:'agent',agentId:'fixture-b'}]});
  expect(f.interactions.preview(scope,restart).reasons).toContain('model_cost_settlement_required');
  await expect(f.interactions.submit(scope,restart)).rejects.toThrow('model_cost_settlement_required');expect(f.nativeCalls).toHaveLength(0);
  if(pendingState==='created')f.broker.ledger.releaseUnsent('unsettled-model');
  else {if(pendingState==='sent')f.broker.ledger.markUnknown('unsettled-model');f.broker.ledger.reconcile('unsettled-model',{requestId:'invoice',totalAtomic:'0',currency:'USD',reason:'Controlled invoice confirms no charge'});}
  const resumed=await f.interactions.submit(scope,restart);expect(resumed.status).toBe('dispatched');
  await untilCostFlow(()=>f.commands.get(resumed.commandId!)?.status==='completed','settled model charge');expect(f.nativeCalls).toHaveLength(1);
  expect(f.interactions.get(queued.id)!.status).toBe('blocked');
 }finally{await f.close();}
});
