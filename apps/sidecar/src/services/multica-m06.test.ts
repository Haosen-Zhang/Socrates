import { test, expect } from 'bun:test';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { setupCostFlowFixture, untilCostFlow } from './cost-flow-fixture';
import { ArenaService } from './arena-service';
import { FlightRecorderService } from './flight-recorder';
const squadInput=(workspaceId:string)=>({workspaceId,name:'M06 squad',avatar:null,description:'',instructions:'Only coordinate approved members',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'},{agentId:'fixture-b',responsibility:'Build'}]});
const itemInput=(workspaceId:string)=>({workspaceId,title:'M06 evidence',objective:'Inspect context.txt',acceptanceCriteria:['Independent result'],ownerKind:'user' as const,priority:'normal' as const});
test('M06 unified scopes deduplicate Squad, item, project and Agent usage; frozen attribution survives rebind',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const squad=f.squads.create(squadInput(f.workspace.id)), item=f.workItems.create(itemInput(f.workspace.id));
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'scope'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.currentRun?.commandStatus==='awaiting_plan_approval','leader only');
  const run=f.workItems.get(item.id)!.currentRun!, root=run.commandId!;
  const query=async(q:string)=>{const r=await f.app.request('/cost/scopes?'+q,{headers:f.headers});expect(r.status).toBe(200);return r.json();};
  const scoped=await query('squadId='+squad.id), work=await query('workItemId='+item.id), project=await query('workspaceId='+f.workspace.id), agent=await query('agentId=fixture-a');
  expect(scoped.summary.invocations).toBe(1);expect(work.summary).toEqual(scoped.summary);expect(project.summary).toEqual(work.summary);expect(agent.summary.invocations).toBe(1);
  expect(new Set(scoped.invocations.map((i:{invocationId:string})=>i.invocationId)).size).toBe(1);
  expect(scoped.tasks[0].quote.id).toBe(preview.quote.id);expect(scoped.tasks[0].budget).toBeNull();
  const recorder=new FlightRecorderService(f.db);try{const page=recorder.list(preview.executionRoomId,{rootTaskId:root});expect(page.records.some(r=>r.fields.squadId===squad.id&&r.fields.workItemId===item.id)).toBe(true);}finally{await recorder.shutdown();}
  await f.commands.cancel(root);f.workItems.assign(item.id,f.workItems.get(item.id)!.revision,{ownerKind:'user',runDisposition:'keep_current'});
  expect((await query('squadId='+squad.id)).summary.invocations).toBe(1);
  expect((await query('squadId=missing')).summary.invocations).toBe(0);
 }finally{await f.close();}
});
test('M06 Squad policies use supported routing, preserve explicit members, require review and freeze revision',async()=>{
 const f=await setupCostFlowFixture({routingFixture:true,nativeToolCalls:()=>[]});try{
  const squad=f.squads.create({...squadInput(f.workspace.id),routingPreset:'economy'});
  expect(squad.routingPreset).toBe('economy');
  const prepared=f.squads.prepareForStart(squad.id,squad.revision);
  expect(prepared.collaborationDefaults.strategy).toBe('adaptive');expect(prepared.collaborationDefaults.assignment.routing.automaticPolicy).toBe('cost');
  expect(prepared.collaborationDefaults.discussion.enabled).toBe(false);expect(prepared.collaborationDefaults.assignment.callableAgentIds).toEqual(['fixture-a','fixture-b']);
  expect(prepared.collaborationDefaults.planConfirmation.mode).toBe('user');
  expect(()=>f.squads.create({...squadInput(f.workspace.id),name:'Bad',routingPreset:'pretend'} as never)).toThrow('routing');
  const item=f.workItems.create(itemInput(f.workspace.id));const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id,budget:{mode:'strict_admission',limitAtomic:'0'}});
  expect(preview.canStart).toBe(false);expect(preview.reason).toBe('routing_no_feasible_candidate');
  await expect(f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'zero'})).rejects.toThrow();
  expect(f.nativeCalls).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);
 }finally{await f.close();}
});
test('M06 accepted work reopens review when independent evidence changes',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=f.workItems.create(itemInput(f.workspace.id)),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'verified'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review','complete');
  const current=f.workItems.get(item.id)!,target={roomId:preview.executionRoomId,rootTaskId:current.currentRun!.commandId!};
  const plan=f.verification.prepare({...target,requestId:'plan',checks:[{id:'context',label:'Context exists',kind:'file',path:'context.txt',required:true,origin:'user'}],artifactPaths:['context.txt'],protectedPaths:[]});
  f.verification.approve(plan.id,'approve');await f.verification.verify(target,{requestId:'verify'});
  expect(f.workItems.review(item.id,current.revision,'accept').workflow).toBe('done');
  writeFileSync(join(f.workspace.canonicalPath,'context.txt'),'changed after verification');
  const changed=f.workItems.get(item.id)!;expect(changed.workflow).toBe('in_review');expect(changed.reviewState).toBe('pending');expect(changed.waitReason).toBe('verification_invalidated');
  expect(()=>f.workItems.review(item.id,changed.revision,'accept')).toThrow('verification');
  await f.verification.verify(target,{requestId:'reverify'});expect(f.workItems.review(item.id,changed.revision,'accept').workflow).toBe('done');
 }finally{await f.close();}
});
test('M06 Arena Squad candidates freeze distinct rosters into isolated workspaces',async()=>{
 const f=await setupCostFlowFixture({routingFixture:true});try{
  const a=f.squads.create(squadInput(f.workspace.id)),b=f.squads.create({...squadInput(f.workspace.id),name:'Second',leaderAgentId:'fixture-b'});
  const arena=new ArenaService(f.db,{...f,baseDirectory:join(f.directory,'arena'),controlled:true});
  expect(arena.templates(f.roomIds.work).squads.map(s=>s.id)).toEqual(expect.arrayContaining([a.id,b.id]));
  const variants=[a,b].map(s=>({id:s.id,label:s.name,primaryAgentId:s.leaderAgentId,collaboration:f.sessions.get(f.roomIds.work)!.collaboration,squadId:s.id,squadRevision:s.revision}));
  const definition={schemaVersion:1,roomId:f.roomIds.work,requestId:'squads',label:'Squad Arena',datasetVersion:'m06',files:['context.txt'],tasks:[{id:'task',category:'read',prompt:'Inspect',checks:[{id:'file',label:'exists',kind:'file',path:'context.txt',required:true,origin:'user'}],artifactPaths:['context.txt'],protectedPaths:[]}],variants,repeats:1,concurrency:2,timeoutMs:10000,groupBudgetAtomic:'1000000000000',trialBudgetAtomic:'1000000000000',mode:'controlled',authorizeLive:false,acknowledgeSnapshot:true};
  const e=arena.prepare(definition);expect(new Set(e.trials.map(t=>t.workspaceId)).size).toBe(2);expect(e.trials.every(t=>t.workspaceId!==f.workspace.id)).toBe(true);
  for(const trial of e.trials){const room=f.sessions.get(trial.roomId)!;expect(room.agents.map(a=>a.agentId)).toEqual(['fixture-a','fixture-b']);expect(f.squads.binding(room.id)?.squadId).toBe(trial.variantId);}
  f.squads.update(a.id,a.revision,{...a,instructions:'changed'});expect(()=>arena.prepare({...definition,requestId:'stale'})).toThrow('changed');
  expect(arena.prepare(definition).id).toBe(e.id);
  arena.start(e.id);await untilCostFlow(()=>arena.view(e.id).trials.every(t=>t.status==='waiting'),'Squad trial leaders');
  expect(new Set(f.gatewayCalls.filter(c=>c.purpose==='plan').map(c=>c.agentId))).toEqual(new Set(['fixture-a','fixture-b']));
  await arena.cancel(e.id);await arena.wait(e.id);
 }finally{await f.close();}
});
test('M06 preflight verification requotes the same frozen room and binds evidence to execution',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=f.workItems.create(itemInput(f.workspace.id)),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  const plan=f.verification.prepare({roomId:preview.executionRoomId,requestId:'preflight',checks:[{id:'file',label:'Context',kind:'file',path:'context.txt',required:true,origin:'user'}],artifactPaths:['context.txt'],protectedPaths:[]});
  f.verification.approve(plan.id,'approve');
  const next=f.workItemLaunch.requote(item.id,preview.id,plan.id);expect(next.id).not.toBe(preview.id);expect(next.executionRoomId).toBe(preview.executionRoomId);expect(f.nativeCalls).toHaveLength(0);
  await f.workItemLaunch.start(item.id,{previewId:next.id,expectedRevision:item.revision,clientRequestId:'verified-launch'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review','verified execution');
  const root=f.workItems.get(item.id)!.currentRun!.commandId!;expect(f.verification.view({roomId:next.executionRoomId,rootTaskId:root}).verificationStatus).toBe('passed');
  expect(()=>f.workItemLaunch.requote(item.id,preview.id,plan.id)).toThrow('changed');
 }finally{await f.close();}
});
test('M06 Squad Leader and WorkPackages receive only confirmed authorized project memory as user context',async()=>{
 const gateway:unknown[]=[],native:unknown[]=[];
 const f=await setupCostFlowFixture({onGatewayRequest:r=>gateway.push(r),onNativeRequest:r=>native.push(r),nativeToolCalls:()=>[]});try{
  const allowed=f.projectMemory.save(f.roomIds.work,{kind:'constraint',content:'M06_CONFIRMED_CONSTRAINT'},{status:'confirmed'});
  f.projectMemory.save(f.roomIds.work,{kind:'constraint',content:'M06_UNTRUSTED_PROPOSAL'},{origin:'agent_proposal'});
  f.projectMemory.save(f.roomIds.work,{kind:'constraint',content:'M06_OTHER_PROVIDER',allowedProviders:['unavailable-provider']},{status:'confirmed'});
  const squad=f.squads.create(squadInput(f.workspace.id)),item=f.workItems.create(itemInput(f.workspace.id)),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'memory'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.currentRun?.commandStatus==='awaiting_plan_approval','memory leader');
  const command=f.commands.get(f.workItems.get(item.id)!.currentRun!.commandId!)!,plan=f.tasks.getPlan(command.taskId!)!;
  const response=await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`,{method:'POST',headers:f.headers,body:JSON.stringify({version:plan.version,hash:plan.contentHash,clientDecisionKey:'m06-memory',decision:'approve_exact_plan'})});expect(response.status).toBe(200);
  await untilCostFlow(()=>f.nativeCalls.length>0,'memory worker');
  expect(JSON.stringify(gateway)).toContain('M06_CONFIRMED_CONSTRAINT');expect(JSON.stringify(native)).toContain('M06_CONFIRMED_CONSTRAINT');
  for(const payload of [gateway,native]){expect(JSON.stringify(payload)).not.toContain('M06_UNTRUSTED_PROPOSAL');expect(JSON.stringify(payload)).not.toContain('M06_OTHER_PROVIDER');}
  const manifests=f.projectMemory.manifests(preview.executionRoomId,command.commandId);expect(manifests.some(m=>m.selected.some((e:{id:string;version:number})=>e.id===allowed.id&&e.version===1))).toBe(true);
 }finally{await f.close();}
});
test('M06 scope reports retain unknown usage and bind Squad history before a room is rebound',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const a=f.squads.create(squadInput(f.workspace.id)),b=f.squads.create({...squadInput(f.workspace.id),name:'Rebound'});
  f.squads.bind(a.id,a.revision,f.roomIds.work,null);
  const command=await f.commands.submit({roomId:f.roomIds.work,clientRequestId:'first-squad',content:'Inspect',mentions:[{type:'agent',agentId:'fixture-a'}],intent:'respond'});
  await untilCostFlow(()=>f.commands.get(command.commandId)?.status==='completed'&&f.sessions.get(f.roomIds.work)?.status==='completed','completed before rebind');
  f.squads.bind(b.id,b.revision,f.roomIds.work,f.squads.binding(f.roomIds.work)!.bindingVersion);
  expect(f.broker.ledger.summary({squadId:a.id}).invocations).toBe(1);expect(f.broker.ledger.summary({squadId:b.id}).invocations).toBe(0);
  const original=f.broker.ledger.list({squadId:a.id})[0]!;
  const id={...original,invocationId:'unknown-attempt',logicalStepId:'unknown-attempt',attemptNo:2,workPackageId:'package-cost'};
  f.broker.ledger.begin(id,null);f.broker.ledger.markSent(id.invocationId);f.broker.ledger.finish(id.invocationId,{});
  expect(f.broker.ledger.summary({squadId:a.id})).toMatchObject({invocations:2,unknownCount:1});
  expect(f.broker.ledger.summary({workPackageId:'package-cost'})).toMatchObject({invocations:1,unknownCount:1,usage:{}});
  expect(f.broker.ledger.summary({workspaceId:f.workspace.id}).invocations).toBe(2);
  f.broker.ledger.reconcile(id.invocationId,{requestId:'invoice',totalAtomic:'100',currency:'USD',reason:'Synthetic invoice'});
  expect(f.broker.ledger.summary({squadId:a.id}).unknownCount).toBe(0);expect(f.broker.ledger.summary({workPackageId:'package-cost'}).totals[0]!.atomic).toBe('100');
 }finally{await f.close();}
});
async function completedTeamWithIndependentEvidence(f:Awaited<ReturnType<typeof setupCostFlowFixture>>) {
 const squad=f.squads.create(squadInput(f.workspace.id)),item=f.workItems.create(itemInput(f.workspace.id)),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});
 await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'review-evidence'});
 await untilCostFlow(()=>f.workItems.get(item.id)?.currentRun?.commandStatus==='awaiting_plan_approval','team plan');
 const command=f.commands.get(f.workItems.get(item.id)!.currentRun!.commandId!)!,plan=f.tasks.getPlan(command.taskId!)!;
 const approval=await f.app.request(`/multi/tasks/${command.taskId}/plan-decisions`,{method:'POST',headers:f.headers,body:JSON.stringify({version:plan.version,hash:plan.contentHash,clientDecisionKey:'evidence-plan',decision:'approve_exact_plan'})});expect(approval.status).toBe(200);
 await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review','completed team');
 const target={roomId:preview.executionRoomId,rootTaskId:command.commandId},child={...target,workPackageId:f.workItems.get(item.id)!.workPackages[0]!.id};
 writeFileSync(join(f.workspace.canonicalPath,'child.txt'),'original child');
 for(const [scope,file,key] of [[target,'context.txt','root'],[child,'child.txt','child']] as const){
  const check=f.verification.prepare({...scope,requestId:key,checks:[{id:'file',label:file,kind:'file',path:file,required:true,origin:'user'}],artifactPaths:[file],protectedPaths:[]});
  f.verification.approve(check.id,key+'-approve');await f.verification.verify(scope,{requestId:key+'-verify'});
 }
 const accepted=f.workItems.review(item.id,f.workItems.get(item.id)!.revision,'accept');expect(accepted.workflow).toBe('done');
 return {itemId:item.id,target,child};
}
test('M06 human acceptance covers separate package evidence and cannot revive after unobserved reruns',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {itemId,target,child}=await completedTeamWithIndependentEvidence(f);
  writeFileSync(join(f.workspace.canonicalPath,'child.txt'),'first change');
  expect(f.verification.view(target)).toMatchObject({verificationStatus:'passed',gatePassed:false});
  expect(f.workItems.get(itemId)).toMatchObject({workflow:'in_review',reviewState:'pending',waitReason:'verification_invalidated'});
  await f.verification.verify(child,{requestId:'child-again'});
  expect(f.workItems.get(itemId)).toMatchObject({workflow:'in_review',reviewState:'pending'});
  f.workItems.review(itemId,f.workItems.get(itemId)!.revision,'accept');
  writeFileSync(join(f.workspace.canonicalPath,'child.txt'),'second change');
  await f.verification.verify(child,{requestId:'child-unobserved-rerun'});
  expect(f.verification.view(target).gatePassed).toBe(true);
  expect(f.workItems.get(itemId)).toMatchObject({workflow:'in_review',reviewState:'pending'});
  expect(f.workItems.review(itemId,f.workItems.get(itemId)!.revision,'accept').workflow).toBe('done');
  writeFileSync(join(f.workspace.canonicalPath,'child.txt'),'explicitly accepted without passing rerun');
  f.verification.acceptUnverified(child,'accept-child-unverified');
  expect(f.verification.view(target)).toMatchObject({gatePassed:true,outcome:'completed_unverified'});
  expect(f.workItems.get(itemId)!.workflow).toBe('in_review');
  expect(f.workItems.review(itemId,f.workItems.get(itemId)!.revision,'accept').workflow).toBe('done');
 }finally{await f.close();}
});
test('M06 request changes survives stale root and subsequent root/package verification reruns',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const {itemId,target,child}=await completedTeamWithIndependentEvidence(f);
  writeFileSync(join(f.workspace.canonicalPath,'context.txt'),'changed root');
  const rejected=f.workItems.review(itemId,f.workItems.get(itemId)!.revision,'request_changes');
  expect(rejected).toMatchObject({reviewState:'changes_requested',workflow:'todo'});
  await f.verification.verify(target,{requestId:'root-after-rejection'});
  await f.verification.verify(child,{requestId:'child-after-rejection'});
  expect(f.workItems.get(itemId)).toMatchObject({reviewState:'changes_requested',workflow:'todo'});
  expect(f.workItems.get(itemId)!.reviews.at(-1)!.decision).toBe('request_changes');
 }finally{await f.close();}
});
