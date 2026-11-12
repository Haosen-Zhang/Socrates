import {expect,test} from 'bun:test';
import {setupCostFlowFixture,untilCostFlow} from './cost-flow-fixture';
import {WorkInteractionService} from './work-interactions';
import {type WorkInteractionInput} from '@socrates/core';
const input=(id:string,extra:Partial<WorkInteractionInput>={}):WorkInteractionInput=>({clientRequestId:id,action:'message',content:'Controlled final regression',mentions:[],...extra});

test.each(['note','completed message'])('ordinary room deletion after %s removes interactions and actionable Inbox while preserving costs',async(kind)=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const room=f.sessions.get(f.roomIds.work)!;f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});
  const result=await f.interactions.submit({roomId:room.id},input('delete-first',{action:kind==='note'?'note':'message'}));
  if(result.commandId)await untilCostFlow(()=>f.commands.get(result.commandId!)?.status==='completed','message completion');
  await f.interactions.submit({roomId:room.id},input('review',{action:'request_human_review'}));
  expect(f.inbox.list().items.some(i=>i.link.roomId===room.id)).toBe(true);
  const costs=f.broker.ledger.list({roomId:room.id});expect(costs.length).toBe(kind==='note'?0:1);
  await f.interactions.shutdown();
  // A durable next-round instruction must disappear with its explicitly deleted room, never recover later.
  const now=new Date().toISOString();f.db.query("INSERT INTO work_interactions VALUES('waiting',?,NULL,?,'waiting',?,'queued',NULL,NULL,?,?)").run('room:'+room.id,room.id,JSON.stringify(input('waiting')),now,now);
  await f.sessions.remove(room.id);
  expect(f.sessions.get(room.id)).toBeNull();expect(f.db.query('SELECT * FROM work_interactions WHERE room_id=?').all(room.id)).toHaveLength(0);
  expect(f.inbox.list().items.some(i=>i.link.roomId===room.id)).toBe(false);expect(f.inbox.list().notifications).toHaveLength(0);
  expect(f.db.query('SELECT * FROM inbox_delivery').all()).toHaveLength(0);expect(f.db.query('SELECT * FROM inbox_notifications').all()).toHaveLength(0);
  expect(f.broker.ledger.list({roomId:room.id})).toEqual(costs);
  const recovered=new WorkInteractionService(f.db,f.workItems,f.sessions,f.commands,f.coordinator,f.tasks,f.team,f.packages);recovered.recover();await recovered.pump();await recovered.shutdown();
  expect(f.nativeCalls).toHaveLength(kind==='note'?0:1);expect(f.db.query('PRAGMA foreign_key_check').all()).toHaveLength(0);
 }finally{await f.close();}
});

test('WorkItem execution history still prevents deletion including its interaction and billing history',async()=>{
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[]});try{
  const item=f.workItems.create({workspaceId:f.workspace.id,title:'Retain history',objective:'Controlled work',acceptanceCriteria:['Review'],ownerKind:'agent',ownerId:'fixture-a',priority:'normal'});
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'agent',ownerId:'fixture-a'});await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'retained'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.workflow==='in_review','work complete');
  const note=await f.interactions.submit({workItemId:item.id},input('retained-note',{action:'note'}));
  const costs=f.broker.ledger.list({roomId:preview.executionRoomId});await expect(f.sessions.remove(preview.executionRoomId)).rejects.toThrow('work_item_execution_history_retained');
  expect(f.interactions.get(note.id)).toBeTruthy();expect(f.broker.ledger.list({roomId:preview.executionRoomId})).toEqual(costs);
 }finally{await f.close();}
});

test('durable message workload uses stable non-Run identity through recovery, dispatch, block and resolution',async()=>{
 const f=await setupCostFlowFixture({routingFixture:true,nativeToolCalls:()=>[]});let recovered:WorkInteractionService|undefined;try{
  const roomId=f.roomIds.work,command=await f.commands.submit({roomId,clientRequestId:'queue-plan',content:'Controlled plan',intent:'execute',mentions:[]});
  await untilCostFlow(()=>f.commands.get(command.commandId)?.status==='awaiting_plan_approval','plan');
  const first=await f.interactions.submit({roomId},input('queue',{delivery:'queue',mentions:[{type:'agent',agentId:'fixture-c'}]}));
  const workload=()=>f.agentLifecycle.workload('fixture-c');
  expect(workload()).toMatchObject({state:'queued',counts:{queued:1},items:[{id:first.id,kind:'instruction',rootTaskId:null,runId:null,roomId}]});
  const availability=f.agentLifecycle.presence('fixture-c')!.availability;
  await f.interactions.shutdown();recovered=new WorkInteractionService(f.db,f.workItems,f.sessions,f.commands,f.coordinator,f.tasks,f.team,f.packages);recovered.recover();
  expect(workload().items[0]!.id).toBe(first.id);await f.commands.cancel(command.commandId);await recovered.pump();
  const dispatched=recovered.get(first.id)!;expect(dispatched.status).toBe('dispatched');expect(workload().items.some(i=>i.id===first.id)).toBe(false);
  f.db.query("UPDATE work_interactions SET status='dispatching' WHERE id=?").run(first.id);expect(workload().items.some(i=>i.id===first.id)).toBe(false);recovered.recover();expect(recovered.get(first.id)!.status).toBe('dispatched');
  await untilCostFlow(()=>f.commands.get(dispatched.commandId!)?.status==='completed','queue complete');expect(workload().state).toBe('idle');
  const next=await f.commands.submit({roomId,clientRequestId:'queue-plan-2',content:'Controlled plan',intent:'execute',mentions:[]});await untilCostFlow(()=>f.commands.get(next.commandId)?.status==='awaiting_plan_approval','plan 2');
  const blocked=await recovered.submit({roomId},input('queue-blocked',{delivery:'queue',mentions:[{type:'agent',agentId:'fixture-c'}]}));
  f.db.query("UPDATE providers SET enabled=0 WHERE id='fixture-provider'").run();await f.commands.cancel(next.commandId);await recovered.pump();
  expect(recovered.get(blocked.id)!.status).toBe('blocked');expect(workload()).toMatchObject({state:'paused',counts:{queued:0},items:[{id:blocked.id,runId:null}]});
  f.db.query("UPDATE providers SET enabled=1 WHERE id='fixture-provider'").run();expect(f.agentLifecycle.presence('fixture-c')!.availability).toEqual(availability);
  const calls=f.nativeCalls.length;recovered.resolve({roomId},blocked.id,'Discard without replay');await recovered.pump();expect(workload().state).toBe('idle');expect(f.nativeCalls).toHaveLength(calls);
 }finally{await recovered?.shutdown();await f.close();}
});

test('HTTP Inbox opens actual Native tool approval and unknown effect at canonical command root',async()=>{
 const f=await setupCostFlowFixture({writeApprovalFlow:true});try{
  const room=f.sessions.get(f.roomIds.work)!;f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});
  const command=await f.commands.submit({roomId:room.id,clientRequestId:'actual-approval',content:'Controlled write',intent:'execute',mentions:[]});
  await untilCostFlow(()=>f.commands.get(command.commandId)?.status==='awaiting_approval','actual approval');
  const inbox=await (await f.app.request('/inbox',{headers:f.headers})).json();const approval=inbox.items.find((i:any)=>i.link.approvalId)!;
  expect(approval.link).toMatchObject({roomId:room.id,commandId:command.commandId,rootTaskId:command.commandId,runId:f.commands.get(command.commandId)!.runId});
  const page=await (await f.app.request(`/flight-recorder/rooms/${room.id}?rootTaskId=${approval.link.rootTaskId}`,{headers:f.headers})).json();
  expect(page.records.some((r:any)=>r.source==='runtime'&&r.fields.runId===approval.link.runId)).toBe(true);
  await f.commands.cancel(command.commandId);
  const now=new Date().toISOString();f.db.query("INSERT INTO tool_calls(id,stable_key,session_id,task_id,attempt_id,turn_id,agent_id,name,generation,input_json,input_hash,workspace_identity,policy_version,risk,idempotency,status,created_at,updated_at) VALUES('unknown-final','unknown-final',?,?,'attempt','turn','fixture-a','write_file',1,'{}','hash','workspace',1,'high','non_idempotent','outcome_unknown',?,?)").run(room.id,approval.link.runId,now,now);
  const unknown=f.inbox.list().items.find(i=>i.kind==='unknown_side_effect')!;expect(unknown.link).toMatchObject({rootTaskId:command.commandId,commandId:command.commandId,runId:approval.link.runId});
  expect(f.flightRecorder.list(room.id,{rootTaskId:unknown.link.rootTaskId}).records.some(r=>r.id==='tool:unknown-final')).toBe(true);
 }finally{await f.close();}
});

test('pending Leader instructions/evaluations have durable workload, single running turn and recovery resolution',async()=>{
 let running:ReturnType<Awaited<ReturnType<typeof setupCostFlowFixture>>['agentLifecycle']['workload']>|undefined;
 const f=await setupCostFlowFixture({nativeToolCalls:()=>[],onGatewayRequest:request=>{if(JSON.stringify(request).includes('LEADER_EVALUATION:'))running=f.agentLifecycle.workload('fixture-a');}});try{
  const squad=f.squads.create({workspaceId:f.workspace.id,name:'Pending leader',avatar:null,description:'',instructions:'',leaderAgentId:'fixture-a',members:[{agentId:'fixture-a',responsibility:'Lead'},{agentId:'fixture-b',responsibility:'Build'}]});
  const item=f.workItems.create({workspaceId:f.workspace.id,title:'Leader workload',objective:'Controlled plan',acceptanceCriteria:['Review'],ownerKind:'squad',ownerId:squad.id,priority:'normal'});
  const preview=f.workItemLaunch.preview(item.id,{expectedRevision:item.revision,ownerKind:'squad',ownerId:squad.id});await f.workItemLaunch.start(item.id,{previewId:preview.id,expectedRevision:item.revision,clientRequestId:'leader-work'});
  await untilCostFlow(()=>f.workItems.get(item.id)?.currentRun?.commandStatus==='awaiting_plan_approval','leader plan');
  const command=f.commands.get(f.workItems.get(item.id)!.currentRun!.commandId!)!,taskId=command.taskId!;
  const queued=await f.interactions.submit({workItemId:item.id},input('leader-queued',{action:'reevaluate',delivery:'queue'}));
  expect(f.agentLifecycle.workload('fixture-a').items.find(i=>i.id===queued.id)).toMatchObject({kind:'instruction',state:'queued',runId:null,rootTaskId:null});
  await f.interactions.shutdown();
  const now=new Date().toISOString();f.db.query("INSERT INTO leader_evaluations VALUES('pending-leader',?,?,'pending','member_report',NULL,?,?)").run(item.id,taskId,now,now);
  f.db.query("INSERT INTO leader_report_receipts VALUES(?, 'pending-leader')").run('user:'+queued.id);f.db.query("UPDATE work_interactions SET status='dispatched' WHERE id=?").run(queued.id);
  let workload=f.agentLifecycle.workload('fixture-a');expect(workload.items.filter(i=>i.id===queued.id)).toHaveLength(0);expect(workload.items.find(i=>i.id==='pending-leader')).toMatchObject({kind:'leader_evaluation',state:'queued',rootTaskId:command.commandId,runId:null});
  const recovered=new WorkInteractionService(f.db,f.workItems,f.sessions,f.commands,f.coordinator,f.tasks,f.team,f.packages);recovered.recover();await recovered.pump();
  expect(running?.items.filter(i=>i.kind==='discussion'&&i.state==='running')).toHaveLength(1);expect(running?.items.some(i=>i.id==='pending-leader')).toBe(false);
  expect(f.agentLifecycle.workload('fixture-a').items.some(i=>i.id==='pending-leader'||i.id===queued.id)).toBe(false);
  f.db.query("INSERT INTO leader_evaluations VALUES('interrupted-leader',?,?,'running','member_report',NULL,?,?)").run(item.id,taskId,now,now);recovered.recover();
  expect(f.agentLifecycle.workload('fixture-a').items.find(i=>i.id==='interrupted-leader')).toMatchObject({state:'paused',kind:'leader_evaluation'});
  recovered.resolveEvaluation(item.id,'interrupted-leader','Discard interrupted work');await recovered.pump();expect(f.agentLifecycle.workload('fixture-a').items.some(i=>i.id==='interrupted-leader')).toBe(false);await recovered.shutdown();
  // The old planning and evaluation turns retain their recorder root when an adaptive command advances.
  const task=f.tasks.get(taskId)!;task.config.costRootTaskId=command.commandId;f.db.query('UPDATE multi_tasks SET config_json=? WHERE id=?').run(JSON.stringify(task.config),taskId);const next=await f.coordinator.create({sessionId:preview.executionRoomId,prompt:'Controlled later adaptive child',config:{...task.config,clientRequestId:'later-child'}});
  f.db.query('UPDATE room_commands SET task_id=? WHERE id=?').run(next.id,command.commandId);
  const detail=await (await f.app.request('/agent-lifecycle/fixture-a',{headers:f.headers})).json();
  const old=detail.recentRuns.runs.filter((r:any)=>r.kind==='discussion');expect(old.length).toBeGreaterThanOrEqual(2);expect(old.every((r:any)=>r.rootTaskId===command.commandId)).toBe(true);
  for(const run of old)expect(f.flightRecorder.list(run.roomId,{rootTaskId:run.rootTaskId,limit:200}).records.some(r=>r.id==='discussion:'+run.id)).toBe(true);
  f.db.query("UPDATE leader_evaluations SET status='blocked',reason='controlled adaptive review' WHERE id='pending-leader'").run();f.db.query("UPDATE work_interactions SET status='blocked' WHERE id=?").run(queued.id);
  const evaluationLink=f.inbox.list().items.find(i=>i.link.evaluationId==='pending-leader')!.link;expect(evaluationLink).toMatchObject({rootTaskId:command.commandId,taskId,commandId:command.commandId});
  expect(f.flightRecorder.list(preview.executionRoomId,{rootTaskId:evaluationLink.rootTaskId}).records.some(r=>r.id==='discussion:'+old[0].id)).toBe(true);
  f.db.query("INSERT INTO tool_calls(id,stable_key,session_id,task_id,attempt_id,turn_id,agent_id,name,generation,input_json,input_hash,workspace_identity,policy_version,risk,idempotency,status,created_at,updated_at) VALUES('old-unknown','old-unknown',?,?,'attempt','turn','fixture-a','write_file',1,'{}','hash','workspace',1,'high','non_idempotent','outcome_unknown',?,?)").run(preview.executionRoomId,taskId,now,now);
  const unknown=f.inbox.list().items.find(i=>i.link.toolOperationId==='old-unknown')!;expect(unknown.link).toMatchObject({rootTaskId:command.commandId,runId:taskId});const unknownPage=f.flightRecorder.list(preview.executionRoomId,{rootTaskId:unknown.link.rootTaskId,limit:200});expect(unknownPage.records.some(r=>r.id==='tool:old-unknown')).toBe(true);
 }finally{await f.close();}
});

test('deletion rechecks activity after awaited history staging and rolls back when a durable instruction starts',async()=>{
 const {SessionStore}=await import('../store/session-store'),{HistoryStore}=await import('../store/history-store');
 const f=await setupCostFlowFixture({writeApprovalFlow:true});let resume!:()=>void;const held=new Promise<void>(resolve=>resume=resolve);let staged!:()=>void;const staging=new Promise<void>(resolve=>staged=resolve);try{
  const room=f.sessions.get(f.roomIds.work)!;f.sessions.updateCollaboration(room.id,{...room.collaboration,strategy:'single'});
  const note=await f.interactions.submit({roomId:room.id},input('before-delete',{action:'note'}));
  const history=new HistoryStore(f.db,f.directory+'/history');await history.bootstrapSession(room.id);
  const original=history.stageSessionDeletion.bind(history);let rolledBack=false;
  history.stageSessionDeletion=async id=>{const stage=await original(id);staged();await held;return {commit:()=>stage.commit(),rollback:()=>{rolledBack=true;stage.rollback();}};};
  const deleting=new SessionStore(f.db,history).remove(room.id).then(()=>null,error=>error as Error);await staging;
  const instruction=await f.interactions.submit({roomId:room.id},input('starts-during-staging'));
  await untilCostFlow(()=>f.commands.get(instruction.commandId!)?.status==='awaiting_approval','started during staging');resume();expect((await deleting)?.message).toBe('active_session_delete_locked');
  expect(rolledBack).toBe(true);expect(f.sessions.get(room.id)).toBeTruthy();expect(f.interactions.get(note.id)).toBeTruthy();expect(f.interactions.get(instruction.id)).toBeTruthy();expect(f.agentLifecycle.workload('fixture-a').state).toBe('awaiting_approval');
  await f.commands.cancel(instruction.commandId!);
 }finally{resume();await f.close();}
});
