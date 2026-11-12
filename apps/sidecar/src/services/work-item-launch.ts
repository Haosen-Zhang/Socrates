import type { Database } from 'bun:sqlite';
import { DEFAULT_COLLABORATION_SETTINGS, type RoomCommandInput, type WorkItem, type WorkItemPreview, type WorkItemOwnerKind } from '@socrates/core';
import { toAgent, type AgentRow } from '../agents';
import { SessionStore } from '../store/session-store';
import { SquadService } from './squads';
import { TaskQuoteService } from './task-quotes';
import { RoomCommandService } from './room-command-service';
import { WorkItemConflict, WorkItemService } from './work-items';
type PreviewInput={expectedRevision:number;ownerKind:WorkItemOwnerKind;ownerId?:string|null;budget?:RoomCommandInput['budget']};
type StartInput={previewId:string;expectedRevision:number;clientRequestId:string};
type PreviewRow={preview_json:string;input_json:string;owner_json:string};
export class WorkItemLaunchService {
 private pending=new Map<string,Promise<ReturnType<WorkItemService['get']>>>();
 constructor(private db:Database,private items:WorkItemService,private sessions:SessionStore,private squads:SquadService,private quotes:TaskQuoteService,private commands:RoomCommandService,private cancelCommand:(id:string)=>Promise<void> = id=>commands.cancel(id)){this.recoverInterrupted();}
 private recoverInterrupted():void {
  this.db.transaction(()=>{
   const pending=this.db.query<{id:string;work_item_id:string;execution_room_id:string;frozen_owner_json:string},[]>("SELECT * FROM work_item_runs WHERE state='preparing'").all();
   for(const run of pending){
    const command=this.db.query<{id:string},[string,string]>('SELECT id FROM room_commands WHERE room_id=? AND client_request_id=?').get(run.execution_room_id,'work-item:'+run.id);
    if(command){
     const owner=JSON.parse(run.frozen_owner_json);
     this.db.query("UPDATE work_item_runs SET command_id=?,state='dispatched' WHERE id=?").run(command.id,run.id);
     this.db.query("UPDATE work_items SET owner_kind=?,owner_id=?,manual_state='todo',review_state='pending',updated_at=? WHERE id=?").run(owner.ownerKind,owner.ownerId,new Date().toISOString(),run.work_item_id);
    }else{
     // No accepted command exists: release the reservation without starting paid work.
     this.db.query('DELETE FROM work_item_runs WHERE id=?').run(run.id);
    }
   }
  })();
 }
 preview(id:string,input:PreviewInput):WorkItemPreview {
   const item=this.items.get(id);if(!item||item.revision!==input.expectedRevision)throw new WorkItemConflict('Work item changed');
   if(item.workflow==='in_progress'||item.runs.some(run=>run.state==='preparing'))throw new WorkItemConflict('Current execution must finish before starting another');
   if(!['agent','squad'].includes(input.ownerKind)||!input.ownerId)throw new Error('Choose an Agent or Squad to execute');
   let agents,primaryAgentId,collaboration=structuredClone(DEFAULT_COLLABORATION_SETTINGS),owner:unknown;
   if(input.ownerKind==='squad'){
    const squad=this.squads.get(input.ownerId);if(!squad||squad.workspaceId!==item.workspaceId)throw new Error('Squad not found in project');
    const prepared=this.squads.prepareForStart(squad.id,squad.revision);agents=prepared.agents;primaryAgentId=squad.leaderAgentId;collaboration=prepared.collaborationDefaults;owner=squad;
   }else{
    const row=this.db.query<AgentRow,[string]>('SELECT * FROM agents WHERE id=?').get(input.ownerId);if(!row)throw new Error('Agent not found');
    const agent=toAgent(row);if(agent.modelCapabilities?.toolCalling!==true)throw new Error('Agent requires verified tool capability');
    agents=[{agentId:agent.id,snapshot:{...agent},executionEligible:true}];primaryAgentId=agent.id;collaboration.strategy='single';owner=agent;
   }
   collaboration.discussion={...collaboration.discussion,enabled:false};
   let preview!:WorkItemPreview;
   this.sessions.create({title:item.title,kind:'cowork',mode:agents.length>1?'multi_agent':'single_agent',workspaceId:item.workspaceId,primaryAgentId,agents,collaborationDefaults:collaboration},roomId=>{
   const room=this.sessions.get(roomId)!;
   const command:RoomCommandInput={roomId:room.id,clientRequestId:'',intent:'execute',content:[item.title,item.objective,...item.acceptanceCriteria.map(c=>'Acceptance: '+c)].filter(Boolean).join('\n\n'),mentions:[],...(input.budget?{budget:input.budget}:{})};
   const quote=this.quotes.quote(command);command.quoteId=quote.id;
   const workspace=this.db.query<{id:string;canonical_path:string;identity_hash:string},[string]>('SELECT id,canonical_path,identity_hash FROM workspaces WHERE id=?').get(item.workspaceId)!;
   preview={id:crypto.randomUUID(),workItemId:id,expectedRevision:item.revision,ownerKind:input.ownerKind,ownerId:input.ownerId!,executionRoomId:room.id,executorAgentId:primaryAgentId,workspaceId:workspace.id,workspaceIdentityHash:workspace.identity_hash,workspacePath:workspace.canonical_path,approvalPolicy:room.approvalPolicy,quote,canStart:!quote.route||!!quote.route.selected,reason:quote.route&&!quote.route.selected?'routing_no_feasible_candidate':undefined,routing:quote.route?{preset:quote.route.preset,workflow:quote.route.selected?.workflow??null,agentIds:quote.route.selected?.resolved.agentIds??[],reasonCodes:quote.route.reasonCodes}:undefined};
   this.db.query('INSERT INTO work_item_previews VALUES(?,?,?,?,?)').run(preview.id,id,JSON.stringify(preview),JSON.stringify(command),JSON.stringify({ownerKind:input.ownerKind,ownerId:input.ownerId,snapshot:owner,sourceRoomId:item.roomId,members:room.agents}));
   });
   return preview;
 }
 requote(id:string,previewId:string,verificationPlanId?:string):WorkItemPreview {
  const row=this.db.query<PreviewRow,[string,string]>('SELECT * FROM work_item_previews WHERE id=? AND work_item_id=?').get(previewId,id);if(!row)throw new Error('Preview not found');
  const previous:WorkItemPreview=JSON.parse(row.preview_json),item=this.items.get(id);
  if(!item||item.revision!==previous.expectedRevision||item.workflow==='in_progress')throw new WorkItemConflict('Work item changed');
  this.assertPreviewAuthority(previous);
  if(verificationPlanId!==undefined){
   if(typeof verificationPlanId!=='string')throw new Error('Invalid verification plan');
   const plan=this.db.query<{room_id:string;approval_status:string},[string]>("SELECT room_id,json_extract(plan_json,'$.approvalStatus') AS approval_status FROM verification_plans WHERE id=?").get(verificationPlanId);
   if(!plan||plan.room_id!==previous.executionRoomId||plan.approval_status!=='approved')throw new Error('verification_plan_approval_required');
  }
  const command:RoomCommandInput={...JSON.parse(row.input_json),verificationPlanId};delete command.quoteId;
  const quote=this.quotes.quote(command);command.quoteId=quote.id;
  const preview={...previous,id:crypto.randomUUID(),quote,verificationPlanId,canStart:!quote.route||!!quote.route.selected,reason:quote.route&&!quote.route.selected?'routing_no_feasible_candidate':undefined,routing:quote.route?{preset:quote.route.preset,workflow:quote.route.selected?.workflow??null,agentIds:quote.route.selected?.resolved.agentIds??[],reasonCodes:quote.route.reasonCodes}:undefined};
  this.db.query('INSERT INTO work_item_previews VALUES(?,?,?,?,?)').run(preview.id,id,JSON.stringify(preview),JSON.stringify(command),row.owner_json);
  return preview;
 }
 start(id:string,input:StartInput):Promise<WorkItem|null>{
  if(typeof input.clientRequestId!=='string'||!input.clientRequestId.trim()||input.clientRequestId.length>150)throw new Error('Invalid request ID');
  input={previewId:input.previewId,expectedRevision:input.expectedRevision,clientRequestId:input.clientRequestId};
  const key=id+':'+input.clientRequestId;
  const prior=this.pending.get(key);
  if(prior)return prior.then(()=>this.start(id,input));
  const operation=this.dispatch(id,input);this.pending.set(key,operation);
  void operation.finally(()=>{if(this.pending.get(key)===operation)this.pending.delete(key);}).catch(()=>{});
  return operation;
 }
 private assertPreviewAuthority(preview:WorkItemPreview):void {
  const room=this.sessions.get(preview.executionRoomId);
  const workspace=room?.workspaceId ? this.db.query<{canonical_path:string;identity_hash:string},[string]>('SELECT canonical_path,identity_hash FROM workspaces WHERE id=?').get(room.workspaceId) : null;
  if(!room||room.workspaceId!==preview.workspaceId||!workspace||workspace.identity_hash!==preview.workspaceIdentityHash||workspace.canonical_path!==preview.workspacePath||room.approvalPolicy.mode!==preview.approvalPolicy.mode||room.approvalPolicy.version!==preview.approvalPolicy.version)throw new WorkItemConflict('Preview execution authority changed; create a new preview');
 }
 private async dispatch(id:string,input:StartInput){
  const row=this.db.query<PreviewRow,[string,string]>('SELECT * FROM work_item_previews WHERE id=? AND work_item_id=?').get(input.previewId,id);if(!row)throw new Error('Preview not found');
  const preview:WorkItemPreview=JSON.parse(row.preview_json), command:RoomCommandInput=JSON.parse(row.input_json);
  if(input.expectedRevision!==preview.expectedRevision)throw new WorkItemConflict('Preview revision changed');
  let run=this.db.query<{id:string;request_json:string;state:string},[string,string]>('SELECT * FROM work_item_runs WHERE work_item_id=? AND client_request_id=?').get(id,input.clientRequestId);
  if(run){if(run.request_json!==JSON.stringify(input))throw new WorkItemConflict('Request identity conflict');if(run.state==='dispatched')return this.items.get(id)!;}
  else{
   this.db.transaction(()=>{
    const item=this.items.get(id);if(!item||item.revision!==input.expectedRevision||item.workflow==='in_progress'||item.runs.some(run=>run.state==='preparing'))throw new WorkItemConflict('Work item changed');
    const frozen=JSON.parse(row.owner_json);
    if(frozen.ownerKind==='squad' && !this.db.query('SELECT id FROM squad_templates WHERE id=? AND archived=0').get(frozen.ownerId))throw new Error('Squad archived or missing');
    for(const member of frozen.members){
     if(!this.db.query('SELECT id FROM providers WHERE id=? AND enabled=1').get(member.snapshot.providerId))throw new Error('Provider unavailable');
    }
    this.assertPreviewAuthority(preview);
    this.quotes.validate(command);
    const runId=crypto.randomUUID();
    this.db.query("INSERT INTO work_item_runs VALUES(?,?,?,?,?,?, 'preparing',?,?)").run(runId,id,input.clientRequestId,null,preview.executionRoomId,row.owner_json,JSON.stringify(input),new Date().toISOString());
    this.db.query('UPDATE work_items SET revision=revision+1 WHERE id=?').run(id);
   })();
   run=this.db.query<{id:string;request_json:string;state:string},[string,string]>('SELECT * FROM work_item_runs WHERE work_item_id=? AND client_request_id=?').get(id,input.clientRequestId)!;
  }
  command.clientRequestId='work-item:'+run.id;
  try {
   const existing=this.db.query('SELECT id FROM room_commands WHERE room_id=? AND client_request_id=?').get(command.roomId,command.clientRequestId);
   if(!existing)this.assertPreviewAuthority(preview);
   const accepted=await this.commands.submit(command,run.id);
   this.db.transaction(()=>{
    this.db.query("UPDATE work_item_runs SET command_id=?,state='dispatched' WHERE id=?").run(accepted.commandId,run!.id);
    this.db.query("UPDATE work_items SET owner_kind=?,owner_id=?,review_state='pending',manual_state='todo',updated_at=? WHERE id=?").run(preview.ownerKind,preview.ownerId,new Date().toISOString(),id);
   })();
  }catch(error){
   const existing=this.db.query<{id:string},[string,string]>('SELECT id FROM room_commands WHERE room_id=? AND client_request_id=?').get(command.roomId,command.clientRequestId);
   if(existing)this.db.query("UPDATE work_item_runs SET command_id=?,state='dispatched' WHERE id=?").run(existing.id,run.id);
   else this.db.query('DELETE FROM work_item_runs WHERE id=?').run(run.id);
   throw error;
  }
  return this.items.get(id)!;
 }
 async assign(id:string,revision:number,input:PreviewInput & {runDisposition:'keep_current'|'stop_then_handoff'}){
  const item=this.items.get(id);if(!item||item.revision!==revision)throw new WorkItemConflict('Work item changed');
  this.items.validateOwner(item.workspaceId,input);
  if(!['keep_current','stop_then_handoff'].includes(input.runDisposition))throw new Error('Run disposition required');
  if(input.runDisposition==='stop_then_handoff'&&item.workflow==='in_progress'){
   if(!item.currentRun?.commandId)throw new WorkItemConflict('Launch is pending');
   await this.cancelCommand(item.currentRun.commandId);
   const status=this.commands.get(item.currentRun.commandId)?.status;
   if(!status||!['cancelled','failed','completed','interrupted'].includes(status))throw new WorkItemConflict('Execution has not settled');
  }
  return this.items.assign(id,revision,{...input,runDisposition:'keep_current'});
 }
}
