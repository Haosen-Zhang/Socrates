import {test,expect} from 'bun:test';
import {setupCostFlowFixture,untilCostFlow} from './cost-flow-fixture';
const create=(f:Awaited<ReturnType<typeof setupCostFlowFixture>>)=>f.workItems.create({workspaceId:f.workspace.id,roomId:f.roomIds.work,title:'Inspect context',objective:'Read context.txt',acceptanceCriteria:['Report findings'],ownerKind:'user',priority:'normal'});
test('assignment and preview are free; exact frozen Agent launch deduplicates, completion requires human review',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  let item=create(f);item=f.workItems.assign(item.id,item.revision,{ownerKind:'agent',ownerId:'fixture-a',runDisposition:'keep_current'});
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  expect(f.nativeCalls).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);expect(f.workItems.get(item.id)!.runs).toHaveLength(0);
  expect(preview.executionRoomId).not.toBe(f.roomIds.work);
  const request={previewId:preview.id,expectedRevision:item.revision,clientRequestId:'once'};
  await Promise.all([f.workItemLaunch.start(item.id,request),f.workItemLaunch.start(item.id,request)]);
  await untilCostFlow(()=>f.workItems.get(item.id)!.workflow==='in_review','root complete');
  item=f.workItems.get(item.id)!;expect(item.runs).toHaveLength(1);expect(item.workflow).toBe('in_review');expect(item.messages.length).toBeGreaterThan(0);
  const calls=f.nativeCalls.length;await f.workItemLaunch.start(item.id,request);expect(f.nativeCalls.length).toBe(calls);
  const owner=item.runs[0]!.frozenOwner;item=f.workItems.assign(item.id,item.revision,{ownerKind:'agent',ownerId:'fixture-b',runDisposition:'keep_current'});
  expect(item.runs[0]!.frozenOwner).toEqual(owner);expect(item.ownerId).toBe('fixture-b');expect(item.workflow).toBe('in_review');
  item=f.workItems.review(item.id,item.revision,'accept');expect(item.workflow).toBe('done');expect(item.reviews[0]!.runId).toBe(item.runs[0]!.id);
  expect(f.commands.list(f.roomIds.work)).toHaveLength(0);
  const second=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-b'});
  await f.workItemLaunch.start(item.id,{previewId:second.id,expectedRevision:item.revision,clientRequestId:'second'});
  await untilCostFlow(()=>f.workItems.get(item.id)!.workflow==='in_review','new root requires review');
  expect(f.workItems.get(item.id)!.reviewState).toBe('pending');
  expect(f.workItems.get(item.id)!.reviews[0]!.runId).toBe(item.runs[0]!.id);
 }finally{await f.close();}
});
test('Squad launch calls only Leader, awaiting approval; cancellation targets its command and preserves owner history',async()=>{
 const f=await setupCostFlowFixture();try{
  const squad=f.squads.create({workspaceId:f.workspace.id,name:'Delivery',avatar:null,description:'',instructions:'Freeze me',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'},{agentId:'fixture-b',responsibility:'Build'}]});
  let item=create(f);const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'squad'});
  await untilCostFlow(()=>f.workItems.get(item.id)!.currentRun?.commandStatus==='awaiting_plan_approval','leader plan');
  expect(f.gatewayCalls.map(c=>[c.purpose,c.agentId])).toEqual([['plan','fixture-a']]);expect(f.nativeCalls).toHaveLength(0);
  item=f.workItems.get(item.id)!;expect(item.workflow).toBe('in_progress');expect(item.workPackages.length).toBeGreaterThan(0);expect(f.squads.detail(squad.id)!.activeWorkItems).toHaveLength(1);
  const run=item.currentRun;item=await f.workItemLaunch.assign(item.id,item.revision,{expectedRevision:item.revision,ownerKind:'user',runDisposition:'stop_then_handoff'});
  expect(item.ownerKind).toBe('user');expect(item.currentRun!.id).toBe(run!.id);expect(item.currentRun!.commandStatus).toBe('cancelled');
  expect(f.squads.detail(squad.id)!.activeWorkItems).toHaveLength(0);
 }finally{await f.close();}
});
test('stale previews, conflicting retries and invalid budgets cannot silently assign',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  let item=create(f);const rooms=f.sessions.list().length;
  expect(()=>f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a',budget:{mode:'strict_admission',limitAtomic:'bad'}})).toThrow();
  expect(f.sessions.list()).toHaveLength(rooms);expect(f.workItems.get(item.id)!.ownerKind).toBe('user');
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  item=f.workItems.assign(item.id,item.revision,{ownerKind:'user',runDisposition:'keep_current'});
  await expect(f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:preview.expectedRevision,clientRequestId:'stale'})).rejects.toThrow('changed');
  expect(f.nativeCalls).toHaveLength(0);expect(f.workItems.get(item.id)!.runs).toHaveLength(0);
  const next=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a',budget:{mode:'strict_admission',limitAtomic:'0'}});
  await f.workItemLaunch.start(item.id,{previewId:next.id,expectedRevision:item.revision,clientRequestId:'budget'});
  await untilCostFlow(()=>f.workItems.get(item.id)!.currentRun?.commandStatus==='interrupted','budget admission');
  expect(f.nativeCalls).toHaveLength(0);expect(f.workItems.get(item.id)!.workflow).toBe('in_progress');
 }finally{await f.close();}
});
test('pending accepted launch recovers from persistent identity without creating another command',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  const input={previewId:preview.id,expectedRevision:item.revision,clientRequestId:'restart'};
  await f.workItemLaunch.start(item.id,input);
  await untilCostFlow(()=>f.workItems.get(item.id)!.workflow==='in_review','completed');
  const before=f.workItems.get(item.id)!,calls=f.nativeCalls.length;
  f.db.query("UPDATE work_item_runs SET state='preparing',command_id=NULL WHERE id=?").run(before.currentRun!.id);
  const {WorkItemLaunchService}=await import('./work-item-launch');
  const recovered=new WorkItemLaunchService(f.db,f.workItems,f.sessions,f.squads,f.quotes,f.commands);
  const after=f.workItems.get(item.id);
  expect(after!.currentRun!.commandId).toBe(before.currentRun!.commandId);expect(after!.runs).toHaveLength(1);expect(f.nativeCalls.length).toBe(calls);
  await expect(recovered.start(item.id,{...input,expectedRevision:999})).rejects.toThrow('revision changed');
 }finally{await f.close();}
});
test('prepared rooms cannot bypass explicit start and archived Squad cannot launch',async()=>{
 const f=await setupCostFlowFixture();try{
  const squad=f.squads.create({workspaceId:f.workspace.id,name:'Controlled',avatar:null,description:'',instructions:'',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'}]});
  const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});
  await expect(f.commands.submit({roomId:preview.executionRoomId,clientRequestId:'bypass',content:'Start',mentions:[],intent:'execute'})).rejects.toThrow('work_item_start_required');
  f.squads.archive(squad.id,squad.revision);
  await expect(f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'archived'})).rejects.toThrow('archived');
  expect(f.workItems.get(item.id)!.ownerKind).toBe('user');expect(f.workItems.get(item.id)!.runs).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);
 }finally{await f.close();}
});
test('source deletion retains item and execution history cannot be silently removed',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  f.db.query("INSERT INTO session_messages(id,session_id,role,content,status,created_at) VALUES('source',?,'user','Original request','completed',?)").run(f.roomIds.work,new Date().toISOString());
  const item=f.workItems.create({workspaceId:f.workspace.id,roomId:f.roomIds.work,sourceMessageId:'source',title:'Retain task',objective:'Inspect',acceptanceCriteria:[],ownerKind:'user',priority:'normal'});
  f.db.query("DELETE FROM session_messages WHERE id='source'").run();expect(f.workItems.get(item.id)!.sourceMessageId).toBeNull();
  await f.sessions.remove(f.roomIds.work);expect(f.workItems.get(item.id)!.roomId).toBeNull();
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'retain'});
  await untilCostFlow(()=>f.workItems.get(item.id)!.workflow==='in_review','complete');
  await expect(f.sessions.remove(preview.executionRoomId)).rejects.toThrow('work_item_execution_history_retained');
  await expect(f.sessions.rewind(preview.executionRoomId,f.workItems.get(item.id)!.messages[0]!.id)).rejects.toThrow('work_item_execution_history_retained');
 }finally{await f.close();}
});
test('public legacy entry points cannot execute prepared rooms or bypass a zero budget',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a',budget:{mode:'strict_admission',limitAtomic:'0'}});
  expect(f.sessions.list().some(s=>s.id===preview.executionRoomId)).toBe(false);
  for(const [path,body] of [
   [`/agent/sessions/${preview.executionRoomId}/runs`,{prompt:'Bypass budget'}],
   [`/multi/sessions/${preview.executionRoomId}/tasks`,{prompt:'Bypass budget',config:{speakingOrder:['fixture-a'],maxRounds:1,synthesizerId:'fixture-a'}}],
  ] as const){
   const response=await f.app.request(path,{method:'POST',headers:f.headers,body:JSON.stringify(body)});
   expect(response.status).toBeGreaterThanOrEqual(400);expect((await response.json()).error).toBe('work_item_start_required');
  }
  expect(f.nativeCalls).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);expect(f.workItems.get(item.id)!.runs).toHaveLength(0);expect(f.commands.list(preview.executionRoomId)).toHaveLength(0);
 }finally{await f.close();}
});
test('startup releases unaccepted expired reservations without executing or needing browser identity',async()=>{
 const f=await setupCostFlowFixture();try{
  const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  f.db.query("INSERT INTO work_item_runs VALUES('lost',?,'lost-client',NULL,?,?,'preparing','{}',?)").run(item.id,preview.executionRoomId,JSON.stringify({ownerKind:'agent',ownerId:'fixture-a'}),new Date().toISOString());
  f.db.query('UPDATE work_items SET revision=revision+1 WHERE id=?').run(item.id);
  f.db.query("UPDATE cost_quotes SET expires_at='2000-01-01T00:00:00Z',quote_json=json_set(quote_json,'$.expiresAt','2000-01-01T00:00:00Z') WHERE id=?").run(preview.quote.id);
  const {WorkItemLaunchService}=await import('./work-item-launch');
  const recovered=new WorkItemLaunchService(f.db,f.workItems,f.sessions,f.squads,f.quotes,f.commands);
  const restored=f.workItems.get(item.id)!;expect(restored.workflow).toBe('backlog');expect(restored.ownerKind).toBe('user');expect(restored.currentRun).toBeNull();
  expect(recovered.preview(item.id,{expectedRevision:restored.revision,ownerKind:'agent',ownerId:'fixture-a'}).canStart).toBe(true);
  expect(f.nativeCalls).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);
 }finally{await f.close();}
});
test('budget-paused single handoff cancels durable run and forbids later resume',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  let item=create(f);const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a',budget:{mode:'strict_admission',limitAtomic:'0'}});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'pause-single'});
  await untilCostFlow(()=>f.workItems.get(item.id)!.currentRun?.commandStatus==='interrupted','single budget pause');
  item=f.workItems.get(item.id)!;const runId=f.commands.get(item.currentRun!.commandId!)!.runId!;
  await f.supervisor.wait(runId);
  const {RunSupervisor}=await import('../runtime/run-supervisor');
  const {WorkItemLaunchService}=await import('./work-item-launch');
  const coldSupervisor=new RunSupervisor(f.runner);
  const recovered=new WorkItemLaunchService(f.db,f.workItems,f.sessions,f.squads,f.quotes,f.commands,id=>coldSupervisor.cancel(f.commands.get(id)!.runId!));
  item=await recovered.assign(item.id,item.revision,{expectedRevision:item.revision,ownerKind:'user',runDisposition:'stop_then_handoff'});
  expect(item.currentRun!.commandStatus).toBe('cancelled');expect(item.workflow).toBe('todo');expect(item.ownerKind).toBe('user');
  expect(()=>f.runner.continuationInput(runId)).toThrow('agent_run_not_budget_stopped');expect(f.nativeCalls).toHaveLength(0);
 }finally{await f.close();}
});
test('budget-paused Squad handoff cancels root and forbids later resume',async()=>{
 const f=await setupCostFlowFixture();try{
  const squad=f.squads.create({workspaceId:f.workspace.id,name:'Paused',avatar:null,description:'',instructions:'',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'}]});
  let item=create(f);const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id,budget:{mode:'strict_admission',limitAtomic:'0'}});
  await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'pause-team'});
  await untilCostFlow(()=>f.workItems.get(item.id)!.currentRun?.commandStatus==='paused','team budget pause');
  item=f.workItems.get(item.id)!;const taskId=f.commands.get(item.currentRun!.commandId!)!.taskId!;
  item=await f.workItemLaunch.assign(item.id,item.revision,{expectedRevision:item.revision,ownerKind:'user',runDisposition:'stop_then_handoff'});
  expect(item.currentRun!.commandStatus).toBe('cancelled');expect(item.ownerKind).toBe('user');
  await expect(f.coordinator.resume(taskId)).rejects.toThrow();expect(f.gatewayCalls).toHaveLength(0);expect(f.nativeCalls).toHaveLength(0);
 }finally{await f.close();}
});
for(const mutation of ['workspace','approval-policy','approval-version'] as const){
 test(`public ${mutation} mutation makes preview stale before admission; fresh preview still starts`,async()=>{
  const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
   const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
   if(mutation==='workspace')f.db.query("INSERT INTO workspaces(id,canonical_path,display_path,identity_hash,label,created_at,last_opened_at) VALUES('other','/tmp/other','/tmp/other','other','other','now','now')").run();
   const path=mutation==='workspace'?'workspace':'approval-policy';
   const response=await f.app.request(`/sessions/${preview.executionRoomId}/${path}`,{method:'PUT',headers:f.headers,body:JSON.stringify(mutation==='workspace'?{workspaceId:'other'}:{mode:'workspace_full'})});
   expect(response.status).toBe(200);
   if(mutation==='approval-version'){
    const restored=await f.app.request(`/sessions/${preview.executionRoomId}/approval-policy`,{method:'PUT',headers:f.headers,body:JSON.stringify({mode:preview.approvalPolicy.mode})});
    expect(restored.status).toBe(200);
   }
   const denied=await f.app.request(`/work-items/${item.id}/start`,{method:'POST',headers:f.headers,body:JSON.stringify({previewId:preview.id,expectedRevision:item.revision,clientRequestId:'stale-authority'})});
   expect(denied.status).toBe(409);expect((await denied.json()).error).toContain('authority changed');
   expect(f.workItems.get(item.id)!.runs).toHaveLength(0);expect(f.commands.list(preview.executionRoomId)).toHaveLength(0);expect(f.nativeCalls).toHaveLength(0);expect(f.gatewayCalls).toHaveLength(0);
   const fresh=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
   expect(fresh.workspaceId).toBe(item.workspaceId);expect(fresh.executionRoomId).not.toBe(preview.executionRoomId);
   await f.workItemLaunch.start(item.id,{previewId:fresh.id,expectedRevision:item.revision,clientRequestId:'fresh-authority'});
   await untilCostFlow(()=>f.workItems.get(item.id)!.workflow==='in_review','fresh preview completion');
  }finally{await f.close();}
 });
}
test('preparing retry rejects changed authority but accepted-command recovery remains valid',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=create(f),preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  const input={previewId:preview.id,expectedRevision:item.revision,clientRequestId:'retry-authority'};
  const frozen=f.db.query<{owner_json:string},[string]>('SELECT owner_json FROM work_item_previews WHERE id=?').get(preview.id)!;
  f.db.query("INSERT INTO work_item_runs VALUES('retry-reserved',?,?,NULL,?,?,'preparing',?,?)").run(item.id,input.clientRequestId,preview.executionRoomId,frozen.owner_json,JSON.stringify(input),new Date().toISOString());
  f.sessions.updateApprovalPolicy(preview.executionRoomId,'workspace_full');
  await expect(f.workItemLaunch.start(item.id,input)).rejects.toThrow('authority changed');
  expect(f.workItems.get(item.id)!.runs).toHaveLength(0);expect(f.commands.list(preview.executionRoomId)).toHaveLength(0);expect(f.nativeCalls).toHaveLength(0);
  const fresh=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});
  const acceptedInput={previewId:fresh.id,expectedRevision:item.revision,clientRequestId:'accepted-authority'};
  await f.workItemLaunch.start(item.id,acceptedInput);
  await untilCostFlow(()=>f.workItems.get(item.id)!.workflow==='in_review','accepted completion');
  const accepted=f.workItems.get(item.id)!.currentRun!,calls=f.nativeCalls.length;
  f.sessions.updateApprovalPolicy(fresh.executionRoomId,'workspace_full');
  f.db.query("UPDATE work_item_runs SET state='preparing',command_id=NULL WHERE id=?").run(accepted.id);
  await f.workItemLaunch.start(item.id,acceptedInput);
  expect(f.workItems.get(item.id)!.currentRun!.commandId).toBe(accepted.commandId);expect(f.nativeCalls.length).toBe(calls);
  f.db.query("UPDATE work_item_runs SET state='preparing',command_id=NULL WHERE id=?").run(accepted.id);
  const {WorkItemLaunchService}=await import('./work-item-launch');
  new WorkItemLaunchService(f.db,f.workItems,f.sessions,f.squads,f.quotes,f.commands);
  expect(f.workItems.get(item.id)!.currentRun!.commandId).toBe(accepted.commandId);expect(f.nativeCalls.length).toBe(calls);
 }finally{await f.close();}
});
