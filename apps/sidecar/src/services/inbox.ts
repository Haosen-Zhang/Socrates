import type { Database } from 'bun:sqlite';
import type { InboxItem, InboxLink, InboxNotification } from '@socrates/core';
import { WorkItemService } from './work-items';
import { RoomCommandService } from './room-command-service';
import type { VerificationService } from './verification-service';
import {resolveExecutionRoot} from './execution-root';
type Source=Omit<InboxItem,'revision'|'unread'>;
export class InboxService {
 constructor(private db:Database,private items:WorkItemService,private commands:RoomCommandService,private verification?:VerificationService){}
 private link(roomId:string|null,extra:Partial<InboxLink>={}):InboxLink {
  const item=roomId?this.db.query<{work_item_id:string},[string]>('SELECT work_item_id FROM work_item_runs WHERE execution_room_id=? ORDER BY rowid DESC LIMIT 1').get(roomId):null;
  const room=roomId?this.db.query<{workspace_id:string|null},[string]>('SELECT workspace_id FROM sessions WHERE id=?').get(roomId):null;
  const identity=extra.commandId??extra.taskId??extra.runId;
  const rootTaskId=roomId&&identity?resolveExecutionRoot(this.db,roomId,identity):undefined;
  const commandId=roomId&&rootTaskId&&this.db.query('SELECT id FROM room_commands WHERE room_id=? AND id=?').get(roomId,rootTaskId)?rootTaskId:undefined;
  return {...(rootTaskId?{rootTaskId}:{}),...(commandId?{commandId}:{}),workspaceId:room?.workspace_id??null,...(roomId?{roomId}:{}),...(item?{workItemId:item.work_item_id}:{}),...extra};
 }
 list(workspaceId?:string):{items:InboxItem[];notifications:InboxNotification[]}{
  const sources:Source[]=[];
  for(const row of this.db.query<{id:string;session_id:string;task_id:string;kind:string;subject_id:string},[]>("SELECT * FROM approval_requests WHERE status='pending' AND (expires_at IS NULL OR expires_at>datetime('now'))").all()){
   if(!row.session_id||!this.db.query('SELECT id FROM sessions WHERE id=?').get(row.session_id))continue;
   const operation=this.db.query<{task_id:string},[string]>('SELECT task_id FROM tool_calls WHERE id=?').get(row.subject_id);
   const native=this.db.query<{id:string},[string,string]>('SELECT id FROM agent_runs WHERE session_id=? AND id=?').get(row.session_id,operation?.task_id??row.task_id);
   const pkg=this.db.query<{id:string;task_id:string;run_id:string},[string]>('SELECT id,task_id,run_id FROM work_packages WHERE run_id=?').get(operation?.task_id??row.task_id);
   sources.push({id:'approval:'+row.id,kind:'approval',title:'Approval required',reason:row.kind,link:this.link(row.session_id,{approvalId:row.id,taskId:pkg?.task_id??row.task_id,...(native?{runId:native.id}:operation?{runId:operation.task_id}:{}),...(pkg?{packageId:pkg.id,runId:pkg.run_id}:{})})});
  }
  for(const row of this.db.query<{id:string;session_id:string;task_id:string;name:string},[]>("SELECT * FROM tool_calls WHERE status='outcome_unknown' AND EXISTS(SELECT 1 FROM sessions WHERE sessions.id=tool_calls.session_id)").all())sources.push({id:'unknown:'+row.id,kind:'unknown_side_effect',title:'Tool outcome needs review',reason:row.name,link:this.link(row.session_id,{runId:row.task_id,toolOperationId:row.id})});
  for(const row of this.db.query<{id:string;room_id:string},[]>("SELECT id,room_id FROM room_commands WHERE status!='revoked'").all()){
   const cmd=this.commands.get(row.id)!;
   if(this.db.query("SELECT 1 FROM room_commands newer WHERE newer.room_id=? AND newer.rowid>(SELECT rowid FROM room_commands WHERE id=?) AND newer.status!='revoked' LIMIT 1").get(row.room_id,row.id))continue;
   if(['completed','cancelled','revoked'].includes(cmd.status))continue;
   const budget=!!cmd.error&&(/budget/.test(cmd.error));
   const awaiting=cmd.status==='awaiting_plan_approval';
   if(!budget&&!awaiting&&!(cmd.status==='failed'||cmd.status==='interrupted'))continue;
   const pkg=cmd.taskId?this.db.query<{id:string;run_id:string|null},[string]>("SELECT id,run_id FROM work_packages WHERE task_id=? AND state IN ('failed','budget_stopped','awaiting_verification') LIMIT 1").get(cmd.taskId):null;
   sources.push({id:'command:'+cmd.commandId,kind:budget?'budget':awaiting?'approval':'blocked',title:budget?'Budget paused':awaiting?'Plan approval required':'Execution needs attention',reason:cmd.error??cmd.status,link:this.link(cmd.roomId,{commandId:cmd.commandId,...(cmd.runId?{runId:cmd.runId}:{}),...(cmd.taskId?{taskId:cmd.taskId}:{}),...(pkg?{packageId:pkg.id,...(pkg.run_id?{runId:pkg.run_id}:{})}:{})})});
  }
  for(const row of this.db.query<{id:string;workspace_id:string},[]>('SELECT id,workspace_id FROM work_items').all()){
   const item=this.items.get(row.id)!;
   if(item.workflow==='in_review')sources.push({id:'review:'+item.id+':'+item.currentRun!.id,kind:'human_review',title:item.title,reason:'Work item awaits human review',link:{workspaceId:item.workspaceId,workItemId:item.id,...(item.currentRun?.executionRoomId?{roomId:item.currentRun.executionRoomId}:{}),...(item.currentRun?.commandId?{commandId:item.currentRun.commandId}:{})}});
  }
  for(const row of this.db.query<{id:string;room_id:string|null;work_item_id:string|null;status:string;reason:string|null;input_json:string;command_id:string|null},[]>("SELECT * FROM work_interactions WHERE status IN ('awaiting_review','blocked')").all()){
   const item=row.work_item_id?this.items.get(row.work_item_id):null;
   const evaluation=this.db.query<{evaluation_id:string|null;task_id:string|null},[string]>('SELECT r.evaluation_id,e.task_id FROM leader_report_receipts r LEFT JOIN leader_evaluations e ON e.id=r.evaluation_id WHERE event_id=?').get('user:'+row.id);
   sources.push({id:'interaction:'+row.id,kind:row.status==='awaiting_review'?'human_review':'blocked',title:JSON.parse(row.input_json).content.slice(0,120),reason:row.reason??'Human review requested',link:this.link(row.room_id,{interactionId:row.id,...(row.command_id?{commandId:row.command_id}:{}),...(evaluation?.evaluation_id?{evaluationId:evaluation.evaluation_id,...(evaluation.task_id?{taskId:evaluation.task_id}:{})}:{}),...(item?{workItemId:item.id,workspaceId:item.workspaceId}:{})})});
  }
  for(const row of this.db.query<{id:string;task_id:string;work_item_id:string;status:string;reason:string},[]>("SELECT * FROM leader_evaluations e WHERE status IN ('awaiting_review','blocked') AND NOT EXISTS(SELECT 1 FROM leader_report_receipts r JOIN work_interactions i ON r.event_id='user:'||i.id WHERE r.evaluation_id=e.id)").all()){
   const item=this.items.get(row.work_item_id);if(!item)continue;
   sources.push({id:'evaluation:'+row.id,kind:row.status==='awaiting_review'?'human_review':row.reason.includes('budget')?'budget':'blocked',title:'Leader evaluation needs review',reason:row.reason,link:this.link(this.db.query<{session_id:string},[string]>('SELECT session_id FROM multi_tasks WHERE id=?').get(row.task_id)?.session_id??null,{workspaceId:item.workspaceId,workItemId:item.id,taskId:row.task_id,evaluationId:row.id})});
  }
  if(this.verification)for(const target of this.db.query<{room_id:string;root_task_id:string;package_id:string},[]>('SELECT DISTINCT room_id,root_task_id,package_id FROM verification_plans').all()){
   const view=this.verification.view({roomId:target.room_id,rootTaskId:target.root_task_id,...(target.package_id?{packageId:target.package_id}:{})});
   if(view.gatePassed||!view.plan)continue;
   sources.push({id:'verification:'+view.plan.id,kind:'verification',title:'Verification required',reason:view.verificationStatus,link:this.link(target.room_id,{commandId:target.root_task_id,...(target.package_id?{packageId:target.package_id}:{}),...(view.run?{runId:view.run.id}:{})})});
  }
  for(const source of sources)if(source.link.roomId)source.link=this.link(source.link.roomId,source.link);
  const result:InboxItem[]=[];
  this.db.transaction(()=>{
   const active=new Set(sources.map(s=>s.id));
   for(const row of this.db.query<{id:string},[]>('SELECT id FROM inbox_delivery WHERE active=1').all())if(!active.has(row.id))this.db.query('UPDATE inbox_delivery SET active=0 WHERE id=?').run(row.id);
   for(const source of sources){
    const fingerprint=JSON.stringify(source);
    const prior=this.db.query<{fingerprint:string;revision:number;read_revision:number;active:number},[string]>('SELECT * FROM inbox_delivery WHERE id=?').get(source.id);
    const changed=!prior||prior.fingerprint!==fingerprint||!prior.active;
    const revision=prior?prior.revision+(changed?1:0):1;
    this.db.query('INSERT INTO inbox_delivery VALUES(?,?,?,0,1) ON CONFLICT(id) DO UPDATE SET fingerprint=excluded.fingerprint,revision=excluded.revision,active=1').run(source.id,fingerprint,revision);
    if(changed)this.db.query('INSERT INTO inbox_notifications VALUES(?,?,?,?,?)').run(crypto.randomUUID(),source.id,revision,source.kind,new Date().toISOString());
    result.push({...source,revision,unread:(prior?.read_revision??0)<revision});
   }
  })();
  const items=workspaceId?result.filter(i=>i.link.workspaceId===workspaceId):result;
  const ids=new Set(items.filter(i=>i.unread).map(i=>i.id));
  const notifications=this.db.query<InboxNotification,[]>('SELECT id,item_id AS itemId,revision,kind,created_at AS createdAt FROM inbox_notifications ORDER BY rowid DESC LIMIT 200').all().filter(n=>ids.has(n.itemId)&&items.some(i=>i.id===n.itemId&&i.revision===n.revision));
  return {items,notifications};
 }
 read(id:string,revision:number):void {
  if(!Number.isSafeInteger(revision)||revision<1)throw new Error('invalid_revision');
  this.db.query('UPDATE inbox_delivery SET read_revision=MAX(read_revision,MIN(?,revision)) WHERE id=?').run(revision,id);
 }
}
