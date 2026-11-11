import type { Database } from 'bun:sqlite';
import { resolveRoomCommand, LEADER_LIMITS, type WorkInteraction, type WorkInteractionInput, type TriggerPreview, type RoomCommandInput } from '@socrates/core';
import { commandRoom } from './command-room';
import { SessionStore } from '../store/session-store';
import { ConversationMemoryStore } from '../store/conversation-memory-store';
import { WorkItemService } from './work-items';
import { RoomCommandService } from './room-command-service';
import { MultiAgentCoordinator } from '../multi-agent/coordinator';
import { MultiTaskStore } from '../multi-agent/task-store';
import { TeamRunner } from '../multi-agent/team-runner';
import { WorkPackageStore } from '../multi-agent/work-package-store';
import { EventStore } from '../store/event-store';
export type InteractionScope={workItemId:string}|{roomId:string};
type Row={id:string;scope_key:string;work_item_id:string|null;room_id:string|null;input_json:string;status:WorkInteraction['status'];command_id:string|null;reason:string|null;created_at:string;updated_at:string};
const terminal=new Set(['completed','failed','cancelled','interrupted','revoked']);
export function unknownRoomEffects(db:Database,roomId:string):boolean {
 return !!db.query("SELECT id FROM tool_calls WHERE session_id=? AND status IN ('outcome_unknown','running') LIMIT 1").get(roomId);
}
export function unsettledRoomModelCost(db:Database,roomId:string,includeActive=true):boolean {
 return !!db.query(`SELECT i.id FROM cost_invocations i WHERE i.room_id=? AND
  ((?=1 AND i.state IN ('created','sent')) OR
   ((i.state='outcome_unknown' OR i.state='finished' AND i.status NOT IN ('priced','estimated'))
    AND NOT EXISTS(SELECT 1 FROM cost_adjustments a WHERE a.invocation_id=i.id AND a.actual_total_atomic IS NOT NULL))) LIMIT 1`).get(roomId,includeActive?1:0);
}
export class WorkInteractionService {
 private timer:ReturnType<typeof setInterval>|null=null;
 private pumping:Promise<void>|null=null;
 private stopped=false;
 private evaluationControllers=new Map<string,AbortController>();
 constructor(private db:Database,private items:WorkItemService,private sessions:SessionStore,private commands:RoomCommandService,private coordinator:MultiAgentCoordinator,private tasks:MultiTaskStore,private team:TeamRunner,private packages:WorkPackageStore,private refreshInbox?:()=>void){}
 start(pollMs=500):void {
  if(this.timer)return;
  this.recover();this.timer=setInterval(()=>{void this.pump().catch(()=>{});},pollMs);this.timer.unref();
 }
 recover():void {
  for(const row of this.db.query<Row,[]>("SELECT * FROM work_interactions WHERE status='dispatching'").all()){
   const cmd=this.db.query<{id:string},[string]>('SELECT id FROM room_commands WHERE client_request_id=?').get('interaction:'+row.id);
   this.update(row.id,cmd?'dispatched':'blocked',cmd?null:'interrupted_dispatch_requires_review',cmd?.id);
  }
  for(const evaluation of this.db.query<{id:string;task_id:string},[]>("SELECT id,task_id FROM leader_evaluations WHERE status='running'").all())this.settleEvaluation(evaluation,'blocked','interrupted_evaluation_requires_review',null);
 }
 private scope(scope:InteractionScope){
  if('workItemId'in scope){const item=this.items.get(scope.workItemId);if(!item)throw new Error('work_item_not_found');return {key:'item:'+item.id,item,roomId:item.currentRun?.executionRoomId??item.roomId};}
  const room=this.sessions.get(scope.roomId);if(!room||room.archived)throw new Error('room_not_found');
  // The room route derives the current owner link; callers never supply an authorization run ID.
  if(this.db.query("SELECT id FROM work_item_previews WHERE json_extract(preview_json,'$.executionRoomId')=?").get(room.id)){
   const linked=this.db.query<{work_item_id:string},[string]>('SELECT work_item_id FROM work_item_runs WHERE execution_room_id=? ORDER BY rowid DESC LIMIT 1').get(room.id);
   const item=linked?this.items.get(linked.work_item_id):null;
   if(!item||item.currentRun?.executionRoomId!==room.id||!item.currentRun.commandId)throw new Error('work_item_interaction_required');
   return {key:'item:'+item.id,item,roomId:room.id};
  }
  return {key:'room:'+room.id,item:null,roomId:room.id};
 }
 private validate(input:WorkInteractionInput):void {
  if(!input||typeof input.clientRequestId!=='string'||!input.clientRequestId.trim()||input.clientRequestId.length>150||typeof input.content!=='string'||!input.content.trim()||input.content.length>100000||!Array.isArray(input.mentions)||input.mentions.some(m=>!m||typeof m!=='object')||!['message','note','request_human_review','reevaluate','delegate_package'].includes(input.action)||input.delivery!==undefined&&!['now','queue','stop_restart'].includes(input.delivery))throw new Error('invalid_interaction');
  if(input.intent!==undefined&&!['respond','discuss','execute'].includes(input.intent)||input.mentions.length>100||input.mentions.some(m=>!['agent','squad','all','file'].includes(m.type)||m.type==='agent'&&(typeof m.agentId!=='string'||!m.agentId)||m.type==='squad'&&(typeof m.squadId!=='string'||!m.squadId)||m.type==='file'&&(typeof m.refId!=='string'||!m.refId))||[input.attachmentIds,input.workspaceRefIds].some(ids=>ids!==undefined&&(!Array.isArray(ids)||ids.length>100||ids.some(id=>typeof id!=='string'||!id))))throw new Error('invalid_interaction_targets');
  if(input.packageId!==undefined&&typeof input.packageId!=='string')throw new Error('invalid_package');
 }
 private command(input:WorkInteractionInput,roomId:string,id:string):RoomCommandInput {
  return {roomId,clientRequestId:'interaction:'+id,content:input.content,mentions:input.mentions,intent:input.intent??(this.sessions.get(roomId)?.kind==='chat'?'respond':'execute'),
   ...Object.fromEntries(['quoteId','budget','attachmentIds','workspaceRefIds','verificationPlanId','routingCandidateId','maxOutputTokens'].filter(k=>(input as any)[k]!==undefined).map(k=>[k,(input as any)[k]]))};
 }
 private active(roomId:string|null){return roomId?this.commands.list(roomId).find(c=>!terminal.has(c.status)||c.status==='interrupted'&&!!c.error&&c.error.includes('budget')||this.commands.isSettling(c.commandId)):undefined;}
 preview(scope:InteractionScope,input:WorkInteractionInput):TriggerPreview {
  this.validate(input);const target=this.scope(scope), reasons:string[]=[];let agentIds:string[]=[],rule=input.action as string;
  const active=this.active(target.roomId);const delivery=input.delivery??'now';
  const createsRun=!['note','request_human_review'].includes(input.action);
  if(createsRun){
   if(!target.roomId||target.item&&!target.item.currentRun)reasons.push('Start this work item with an approved owner preview before requesting execution');
   else if(this.db.query("SELECT id FROM tool_calls WHERE session_id=? AND status='outcome_unknown' LIMIT 1").get(target.roomId))reasons.push('unknown_side_effect_requires_review');
   if(target.roomId&&unsettledRoomModelCost(this.db,target.roomId,!active))reasons.push('model_cost_settlement_required');
   if(active&&delivery==='now'&&input.action==='message')reasons.push('Choose queue or stop_restart while a run is active');
   try{
    if(input.action==='message'&&target.roomId){const resolved=this.commands.preview(this.command(input,target.roomId,'preview'));agentIds=resolved.agentIds;rule=input.mentions.some(m=>m.type==='agent')?'explicit_agent':input.mentions.some(m=>m.type==='squad')?'explicit_squad_leader':resolved.resolved.kind;}
    else if(input.action==='reevaluate'||input.action==='delegate_package'){
     const taskId=target.item?.currentRun?.commandId?this.commands.get(target.item.currentRun.commandId)?.taskId:undefined;
     const task=taskId?this.tasks.get(taskId):null;
     if(!task)reasons.push('An existing Squad execution is required');
     else {
      this.evaluationAuthority({work_item_id:target.item!.id,task_id:task.id});
      agentIds=[task.config.synthesizerId];
      if(delivery==='stop_restart')reasons.push('leader_stop_restart_unavailable');
      if(delivery==='now'&&this.leaderBusy(task.id))reasons.push('leader_execution_in_flight_choose_queue');
      if(this.evaluationCount(target.item!.id)>=LEADER_LIMITS.maxEvaluations)reasons.push('leader_evaluation_limit');
     }
    }
   }catch(e){reasons.push(e instanceof Error?e.message:String(e));}
  }
  const pending=this.db.query<{client_request_id:string;input_json:string},[string]>("SELECT client_request_id,input_json FROM work_interactions WHERE scope_key=? AND status='queued'").all(target.key);
  const queued=pending.some(p=>p.client_request_id===input.clientRequestId);
  const queuedAgents=new Set(pending.flatMap(p=>{try{const room=target.roomId?this.sessions.get(target.roomId):null;return room?resolveRoomCommand(commandRoom(this.db,room),this.command(JSON.parse(p.input_json),room.id,'preview')).agentIds:[];}catch{return [];}}));
  return {agentIds,rule,changesOwner:false,queued,available:!reasons.length,reasons,roomId:target.roomId,workItemId:target.item?.id??null,
   inRunInjection:{supported:false,reason:'Native Runtime does not provide durable in-run instruction delivery receipts'},limits:LEADER_LIMITS,
   targets:agentIds.map(agentId=>({agentId,label:String(this.sessions.get(target.roomId!)?.agents.find(m=>m.agentId===agentId)?.snapshot.nickname??agentId),reason:rule,alreadyQueued:queuedAgents.has(agentId),...(reasons[0]?{blockedReason:reasons[0]}:{})})),createsRun,canSubmit:!reasons.length,delivery,...(active?{activeCommandId:active.commandId}:{}),supportsInRun:false};
 }
 list(scope:InteractionScope):WorkInteraction[]{const {key}=this.scope(scope);return this.db.query<Row,[string]>('SELECT * FROM work_interactions WHERE scope_key=? ORDER BY rowid').all(key).map(r=>this.view(r));}
 get(id:string):WorkInteraction|null {const row=this.db.query<Row,[string]>('SELECT * FROM work_interactions WHERE id=?').get(id);return row?this.view(row):null;}
 private view(r:Row):WorkInteraction{const evaluation=this.db.query<{evaluation_id:string|null},[string]>('SELECT evaluation_id FROM leader_report_receipts WHERE event_id=?').get('user:'+r.id);return {...(evaluation?.evaluation_id?{evaluationId:evaluation.evaluation_id}:{}),id:r.id,workItemId:r.work_item_id,roomId:r.room_id,input:JSON.parse(r.input_json),status:r.status,commandId:r.command_id,reason:r.reason,createdAt:r.created_at,updatedAt:r.updated_at};}
 async submit(scope:InteractionScope,input:WorkInteractionInput):Promise<WorkInteraction>{
  this.validate(input);const target=this.scope(scope),serialized=JSON.stringify(input);
  const prior=this.db.query<Row,[string,string]>('SELECT * FROM work_interactions WHERE scope_key=? AND client_request_id=?').get(target.key,input.clientRequestId);
  if(prior){if(prior.input_json!==serialized)throw new Error('client_request_conflict');return this.view(prior);}
  const preview=this.preview(scope,input);if(!preview.canSubmit)throw new Error(preview.reasons.join('; '));
  const id=crypto.randomUUID(),now=new Date().toISOString(),status=input.action==='note'?'saved':input.action==='request_human_review'?'awaiting_review':'queued';
  this.db.query('INSERT INTO work_interactions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,target.key,target.item?.id??null,target.roomId,input.clientRequestId,serialized,status,null,null,now,now);
  if(!preview.createsRun&&target.roomId){
   const memory=new ConversationMemoryStore(this.db),thread=memory.ensureDefaultThread(target.roomId);
   await memory.appendMessage({roomId:target.roomId,threadId:thread.id,runId:null,turnId:null,agentId:null,role:'user',kind:'text',content:input.content,parts:[{type:'text',text:input.content}],status:'completed',idempotencyKey:'interaction:'+id});
  }
  await this.pump();return this.get(id)!;
 }
 resolve(scope:InteractionScope,id:string,decision:string):WorkInteraction {
  const target=this.scope(scope),row=this.db.query<Row,[string,string]>('SELECT * FROM work_interactions WHERE id=? AND scope_key=?').get(id,target.key);
  if(!row)throw new Error('interaction_not_found');if(row.status==='resolved')return this.view(row);
  if(!['awaiting_review','blocked'].includes(row.status)||typeof decision!=='string'||!decision.trim()||decision.length>4000)throw new Error('invalid_review_resolution');
  const evaluation=this.view(row).evaluationId;if(evaluation&&row.work_item_id)this.resolveEvaluation(row.work_item_id,evaluation,decision);
  this.update(id,'resolved',decision);return this.get(id)!;
 }
 private update(id:string,status:WorkInteraction['status'],reason:string|null,commandId?:string){this.db.query('UPDATE work_interactions SET status=?,reason=?,command_id=COALESCE(?,command_id),updated_at=? WHERE id=?').run(status,reason,commandId??null,new Date().toISOString(),id);}
 pump():Promise<void>{if(this.stopped)return Promise.resolve();if(this.pumping)return this.pumping;const promise=this.tick().finally(()=>{this.refreshInbox?.();if(this.pumping===promise)this.pumping=null;});this.pumping=promise;return promise;}
 private async tick(){
  for(const row of this.db.query<Row,[]>("SELECT * FROM work_interactions WHERE status='queued' ORDER BY rowid").all()){
   if(this.stopped)return;
   const input:WorkInteractionInput=JSON.parse(row.input_json);
   try{
    const scope:InteractionScope=row.work_item_id?{workItemId:row.work_item_id}:{roomId:row.room_id!};
    const target=this.scope(scope);
    if(target.roomId!==row.room_id)throw new Error('execution_changed_requires_new_instruction');
    const active=this.active(row.room_id);
    const leader=input.action==='reevaluate'||input.action==='delegate_package';
    if(leader&&input.delivery==='stop_restart')throw new Error('leader_stop_restart_unavailable');
    if(active&&(input.delivery==='queue'||input.action==='message'&&input.delivery!=='stop_restart'))continue;
    if(active&&input.action==='message'){await this.commands.cancel(active.commandId);if(this.active(row.room_id))throw new Error('cancellation_not_settled');}
    if(row.room_id&&unknownRoomEffects(this.db,row.room_id))throw new Error('unknown_side_effect_requires_review');
    if(row.room_id&&unsettledRoomModelCost(this.db,row.room_id))throw new Error('model_cost_settlement_required');
    if(input.action==='reevaluate'||input.action==='delegate_package'){
     const taskId=target.item?.currentRun?.commandId?this.commands.get(target.item.currentRun.commandId)?.taskId:undefined;
     if(!target.item||!taskId)throw new Error('squad_execution_required');
     this.evaluationAuthority({work_item_id:target.item.id,task_id:taskId});
     if(this.leaderBusy(taskId))throw new Error('leader_execution_in_flight_choose_queue');
     this.requestEvaluation(target.item.id,taskId,'user:'+row.id,input);
     this.update(row.id,'dispatched','leader_evaluation_requested');continue;
    }
    const command=this.command(input,row.room_id!,row.id);
    this.commands.preview(command);
    this.update(row.id,'dispatching',null);
    const accepted=await this.commands.submit(command,target.item?.runs.find(run=>run.executionRoomId===row.room_id)?.id);
    this.update(row.id,'dispatched',null,accepted.commandId);
   }catch(error){this.update(row.id,'blocked',error instanceof Error?error.message:String(error));}
  }
  this.collectReports();
  for(const evaluation of this.db.query<{id:string;work_item_id:string;task_id:string},[]>("SELECT * FROM leader_evaluations WHERE status='pending' ORDER BY rowid").all()){
   if(this.stopped)return;
   try{this.evaluationAuthority(evaluation);}catch(error){this.settleEvaluation(evaluation,'blocked',error instanceof Error?error.message:String(error),null);continue;}
   if(this.leaderBusy(evaluation.task_id))continue;
   await this.evaluate(evaluation);
  }
 }
 private evaluationAuthority(evaluation:{work_item_id:string;task_id:string}) {
  const item=this.items.get(evaluation.work_item_id),task=this.tasks.get(evaluation.task_id);
  const command=item?.currentRun?.commandId?this.commands.get(item.currentRun.commandId):null;
  if(!item||!task||!command||command.taskId!==task.id||item.currentRun?.executionRoomId!==task.sessionId)throw new Error('leader_execution_obsolete');
  if(task.state==='cancelled'||['cancelled','revoked'].includes(command.status))throw new Error('leader_execution_cancelled');
  return {item,task};
 }
 private leaderBusy(taskId:string):boolean {
  const task=this.tasks.get(taskId);if(!task)return false;
  const active=this.active(task.sessionId);
  return this.coordinator.isActive(taskId)||this.team.isActive(taskId)||['preparing','discussing','synthesizing'].includes(task.state)||!!active&&active.taskId!==taskId;
 }
 private evaluationCount(id:string){return this.db.query<{n:number},[string]>('SELECT COUNT(*) n FROM leader_evaluations WHERE work_item_id=?').get(id)!.n;}
 private requestEvaluation(workItemId:string,taskId:string,eventId:string,request?:WorkInteractionInput){
  if(this.db.query('SELECT event_id FROM leader_report_receipts WHERE event_id=?').get(eventId))return;
  let pending=this.db.query<{id:string;task_id:string},[string]>("SELECT id,task_id FROM leader_evaluations WHERE work_item_id=? AND status IN ('pending','running')").get(workItemId);
  if(pending&&pending.task_id!==taskId){this.settleEvaluation(pending,'blocked','leader_execution_obsolete',null);pending=null;}
  if(!pending){
   if(this.evaluationCount(workItemId)>=LEADER_LIMITS.maxEvaluations){this.db.query('INSERT INTO leader_report_receipts VALUES(?,NULL)').run(eventId);return;}
   const id=crypto.randomUUID(),now=new Date().toISOString();
   this.db.query("INSERT INTO leader_evaluations VALUES(?,?,?,'pending',?,NULL,?,?)").run(id,workItemId,taskId,request?JSON.stringify(request):'member_report',now,now);pending={id,task_id:taskId};
  }
  this.db.query('INSERT INTO leader_report_receipts VALUES(?,?)').run(eventId,pending.id);
 }
 private collectReports(){
  const reports=this.db.query<{event_id:string;task_id:string;work_item_id:string;payload_json:string},[]>(`SELECT e.event_id,e.task_id,e.payload_json,r.work_item_id FROM task_events e JOIN room_commands c ON c.task_id=e.task_id JOIN work_item_runs r ON r.command_id=c.id WHERE r.rowid=(SELECT MAX(latest.rowid) FROM work_item_runs latest WHERE latest.work_item_id=r.work_item_id) AND e.type IN ('multi.package_finished','multi.package_reviewed') AND NOT EXISTS(SELECT 1 FROM leader_report_receipts x WHERE x.event_id=e.event_id) ORDER BY e.seq`).all();
  for(const report of reports){
   if(this.tasks.get(report.task_id)?.state==='cancelled'){this.db.query('INSERT OR IGNORE INTO leader_report_receipts VALUES(?,NULL)').run(report.event_id);continue;}
   const p=JSON.parse(report.payload_json);const key='package-report:'+report.work_item_id+':'+report.task_id+':'+String(p.id??p.packageId)+':'+String(p.attemptNo??0)+':'+String(p.state);
   if(this.db.query('SELECT event_id FROM leader_report_receipts WHERE event_id=?').get(key)){this.db.query('INSERT OR IGNORE INTO leader_report_receipts VALUES(?,NULL)').run(report.event_id);continue;}
   this.requestEvaluation(report.work_item_id,report.task_id,key);this.db.query('INSERT OR IGNORE INTO leader_report_receipts VALUES(?,NULL)').run(report.event_id);
  }
 }
 private async evaluate(evaluation:{id:string;work_item_id:string;task_id:string}){
  const controller=new AbortController();this.evaluationControllers.set(evaluation.id,controller);
  this.db.query("UPDATE leader_evaluations SET status='running' WHERE id=?").run(evaluation.id);
  let status='no_action',reason='',decision:unknown=null;
  try{
   const {item,task}=this.evaluationAuthority(evaluation);
   if(unknownRoomEffects(this.db,task.sessionId))throw new Error('unknown_side_effect_requires_review');
   if(unsettledRoomModelCost(this.db,task.sessionId))throw new Error('model_cost_settlement_required');
   const packages=this.packages.list(task.id);
   decision=await this.coordinator.evaluateLeader(task.id,evaluation.id,{title:item.title,objective:item.objective,taskState:task.state,packages:packages.map(p=>({id:p.id,state:p.state,result:p.result?.slice(0,2000),executorAgentId:p.executorAgentId})),request:this.db.query<{reason:string},[string]>('SELECT reason FROM leader_evaluations WHERE id=?').get(evaluation.id)?.reason,limits:LEADER_LIMITS},AbortSignal.any([controller.signal,AbortSignal.timeout(LEADER_LIMITS.maxDurationMs)]));
   this.evaluationAuthority(evaluation);
   const answer=decision as {action:string;reason:string;packageId?:string};reason=answer.reason;
   if(answer.action==='human_review')status='awaiting_review';
   if(answer.action==='delegate_package'){
    const count=this.db.query<{n:number},[string]>("SELECT COUNT(*) n FROM leader_evaluations WHERE work_item_id=? AND json_extract(decision_json,'$.dispatchAttempted')=1").get(item.id)!.n;
    if(count>=LEADER_LIMITS.maxDelegations)throw new Error('leader_delegation_limit');
    if(!answer.packageId||!this.packages.ready(task.id).some(p=>p.id===answer.packageId)||task.state!=='executing'||!task.approvedPlanVersion) {status='awaiting_review';reason='New or changed plans require explicit approval. '+reason;}
    else {status='delegated';Object.assign(answer,{dispatchAttempted:true});this.db.query("UPDATE leader_evaluations SET status='delegated',decision_json=? WHERE id=?").run(JSON.stringify(answer),evaluation.id);await this.team.run(task.id);}
   }
  }catch(error){status='blocked';reason=error instanceof Error?error.message:String(error);}
  finally{this.evaluationControllers.delete(evaluation.id);}
  this.settleEvaluation(evaluation,status,reason,decision);
 }
 private settleEvaluation(evaluation:{id:string;task_id:string},status:string,reason:string,decision:unknown){
  const now=new Date().toISOString();this.db.query('UPDATE leader_evaluations SET status=?,reason=?,decision_json=?,updated_at=? WHERE id=?').run(status,reason,JSON.stringify(decision),now,evaluation.id);
  for(const receipt of this.db.query<{event_id:string},[string]>("SELECT event_id FROM leader_report_receipts WHERE evaluation_id=? AND event_id LIKE 'user:%'").all(evaluation.id))this.update(receipt.event_id.slice(5),status==='delegated'?'dispatched':status as WorkInteraction['status'],reason);
  const task=this.tasks.get(evaluation.task_id);if(task)new EventStore(this.db).append({eventId:'leader-result:'+evaluation.id,sessionId:task.sessionId,taskId:task.id,type:'multi.leader_settled',payload:{evaluationId:evaluation.id,status,reason,limits:LEADER_LIMITS}});
 }
 resolveEvaluation(workItemId:string,id:string,decision:string){
  if(typeof decision!=='string'||!decision.trim()||decision.length>4000)throw new Error('invalid_review_resolution');
  const row=this.db.query<{status:string},[string,string]>('SELECT status FROM leader_evaluations WHERE id=? AND work_item_id=?').get(id,workItemId);
  if(!row)throw new Error('evaluation_not_found');
  if(row.status!=='resolved'&&!['awaiting_review','blocked'].includes(row.status))throw new Error('evaluation_not_awaiting_review');
  this.db.query("UPDATE leader_evaluations SET status='resolved',reason=?,updated_at=? WHERE id=?").run(decision,new Date().toISOString(),id);
  for(const receipt of this.db.query<{event_id:string},[string]>("SELECT event_id FROM leader_report_receipts WHERE evaluation_id=? AND event_id LIKE 'user:%'").all(id))this.update(receipt.event_id.slice(5),'resolved',decision);
  return {id,status:'resolved'};
 }
 async shutdown(){this.stopped=true;if(this.timer)clearInterval(this.timer);this.timer=null;for(const c of this.evaluationControllers.values())c.abort('shutdown');await this.pumping;}
}
