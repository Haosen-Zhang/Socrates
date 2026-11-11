import type { Database } from 'bun:sqlite';
import {projectAgentAvailability,projectAgentWorkload,type AgentLifecycleDetail,type AgentWorkItem,type AgentRunSummary,type AgentWorkState} from '@socrates/core';
import {toAgent,type AgentRow} from '../agents';
import type {SecretStore} from '../secrets';
import {providerFingerprint} from './provider-connection-evidence';
import {SessionStore} from '../store/session-store';
import {queuedMessageAgents} from './command-room';
import {resolveExecutionRoot} from './execution-root';
import {CostLedger} from './cost-ledger';

type ProviderRow={id:string;name:string;enabled:number;type:string;base_url:string;api_key_ref:string;updated_at:string};
type RunRow=AgentRunSummary & {agentId:string;error:string|null;turnId:string|null;cursor:string};
// Both direct Native Runs and TeamRunner package attempts are authoritative executions.
const runsSql=`WITH runs AS (
 SELECT r.id,'native' AS kind,r.session_id AS roomId,s.workspace_id AS workspaceId,
 COALESCE(t.agent_id,(SELECT agent_id FROM runtime_events e WHERE e.run_id=r.id ORDER BY e.seq LIMIT 1)) AS agentId,
 COALESCE((SELECT id FROM room_commands c WHERE c.room_id=r.session_id AND c.run_id=r.id),
 (SELECT root_task_id FROM cost_invocations i WHERE i.run_id=r.id LIMIT 1),(SELECT root_task_id FROM adaptive_attempts a WHERE json_extract(a.attempt_json,'$.child.id')=r.id LIMIT 1),r.id) AS rootTaskId,
 NULL AS workPackageId,r.attempt_no AS attemptNo,r.status,r.error,r.turn_id AS turnId,r.created_at AS createdAt,r.completed_at AS completedAt
 FROM agent_runs r JOIN sessions s ON s.id=r.session_id LEFT JOIN conversation_turns t ON t.id=r.turn_id
 UNION ALL
 SELECT a.run_id,'package',t.session_id,s.workspace_id,json_extract(p.definition_json,'$.executorAgentId'),
 COALESCE((SELECT id FROM room_commands c WHERE c.task_id=t.id AND c.room_id=t.session_id),json_extract(t.config_json,'$.costRootTaskId'),t.id),
 p.id,a.attempt_no,a.status,a.failure_reason,NULL,a.started_at,a.completed_at
 FROM work_package_attempts a JOIN work_packages p ON p.id=a.package_id JOIN multi_tasks t ON t.id=p.task_id JOIN sessions s ON s.id=t.session_id
 WHERE NOT EXISTS(SELECT 1 FROM agent_runs r WHERE r.id=a.run_id)
 UNION ALL
 SELECT v.id,'discussion',t.session_id,s.workspace_id,v.agent_id,COALESCE(c.id,NULLIF(json_extract(t.config_json,'$.costRootTaskId'),''),t.id),NULL,a.attempt_no,CASE WHEN v.status='running' AND t.state IN ('completed','failed','cancelled') AND NOT EXISTS(SELECT 1 FROM leader_evaluations e WHERE e.task_id=t.id AND e.status='running' AND v.phase='leader_evaluation' AND v.stable_key='leader-evaluation:'||e.id) THEN 'interrupted' ELSE v.status END,v.error,NULL,v.started_at,v.completed_at
 FROM multi_turns v JOIN multi_tasks t ON t.id=v.task_id JOIN multi_task_attempts a ON a.id=v.attempt_id JOIN sessions s ON s.id=t.session_id LEFT JOIN room_commands c ON c.task_id=t.id AND c.room_id=t.session_id
 UNION ALL
 SELECT c.id||':'||json_extract(profile.value,'$.agentId'),'discussion_command',c.room_id,s.workspace_id,json_extract(profile.value,'$.agentId'),c.id,NULL,1,c.status,c.error,NULL,c.created_at,CASE WHEN c.status IN ('completed','failed','cancelled','interrupted') THEN c.updated_at END
 FROM room_commands c JOIN sessions s ON s.id=c.room_id JOIN room_command_events e ON e.command_id=c.id AND e.type='participants_resolved',json_each(e.payload_json,'$.profiles') profile WHERE c.kind='discussion'
) SELECT *,createdAt||'|'||id AS cursor FROM runs WHERE agentId=?
 AND NOT EXISTS(SELECT 1 FROM room_commands c WHERE c.id=runs.rootTaskId AND c.status='revoked')`;

export class AgentLifecycleService {
 constructor(private db:Database,private options:{secrets?:SecretStore;runtimeReady?:()=>boolean;now?:()=>number}={}){}
 private now(){return this.options.now?.()??Date.now();}
 presence(agentId:string) {
  const row=this.db.query<AgentRow,[string]>('SELECT * FROM agents WHERE id=?').get(agentId);
  if(!row)return null;
  const agent=toAgent(row),p=this.db.query<ProviderRow,[string]>('SELECT * FROM providers WHERE id=?').get(agent.providerId);
  let credential:'present'|'missing'|'unknown'='unknown';
  if(p&&this.options.secrets)try{credential=this.options.secrets.get(p.api_key_ref)?'present':'missing';}catch{credential='unknown';}
  const evidence=p?this.db.query<{fingerprint:string;outcome:'ok'|'auth_failed'|'network_error'|'error';checked_at:string;expires_at:string},[string]>('SELECT * FROM provider_connection_evidence WHERE provider_id=?').get(p.id):null;
  const configured=!!p&&!!agent.modelId.trim();
  const runtime=this.options.runtimeReady?(this.options.runtimeReady()?'ready':'unavailable'):'unknown';
  const availability=projectAgentAvailability({configured,providerEnabled:!!p?.enabled,credential,runtime,toolCalling:agent.modelCapabilities?.toolCalling??'unknown',now:this.now(),evidence:p&&evidence&&evidence.fingerprint===providerFingerprint(p)?{outcome:evidence.outcome,checkedAt:evidence.checked_at,expiresAt:evidence.expires_at}:null});
  return {agent,configuration:{configured,providerId:agent.providerId,providerName:p?.name??null,modelId:agent.modelId,credential},availability,workload:this.workload(agentId)};
 }
 private runRows(agentId:string,where='',args:(string|number)[]=[]):RunRow[]{return this.db.query<RunRow,[string,...(string|number)[]]>(runsSql+where).all(agentId,...args);}
 workload(agentId:string) {
  const items:AgentWorkItem[]=[];
  const runs=this.runRows(agentId," AND status NOT IN ('completed','failed','cancelled') ORDER BY createdAt,id");
  for(const run of runs){
   let state:AgentWorkState|undefined;
   if(run.status==='interrupted'){
    const newer=run.turnId&&this.db.query('SELECT id FROM agent_runs WHERE turn_id=? AND attempt_no>? LIMIT 1').get(run.turnId,run.attemptNo);
    if(!newer&&(run.error==='budget_exhausted'||run.error?.startsWith('cost_budget_')))state='paused';
   } else if(run.status==='budget_stopped')state='paused';
   else if(run.status==='preparing')state=this.db.query("SELECT 1 FROM runtime_events WHERE run_id=? AND type='run.workspace_waiting' LIMIT 1").get(run.id)?'workspace_waiting':'queued';
   else if(run.status==='running'||run.status==='awaiting_approval')state=run.status;
   if(run.kind==='discussion_command'){
    const last=this.db.query<{agentId:string},[string]>("SELECT json_extract(payload_json,'$.agentId') AS agentId FROM room_command_events WHERE command_id=? AND type='turn_started' ORDER BY seq DESC LIMIT 1").get(run.rootTaskId);
    if(last?.agentId!==agentId)continue;
    state=run.status==='paused'?'paused':run.status==='running'?'running':undefined;
   }
   if(!state)continue;
   // Package state owns approval/queue/review semantics; do not count the child twice.
   if(run.workPackageId)continue;
   items.push({id:run.id,kind:run.kind.startsWith('discussion')?'discussion':'run',roomId:run.roomId,rootTaskId:run.rootTaskId,runId:run.kind.startsWith('discussion')?null:run.id,workPackageId:null,attemptNo:run.attemptNo,state,createdAt:run.createdAt});
  }
  type Package={id:string;roomId:string;rootTaskId:string;runId:string|null;attemptNo:number;state:string;taskState:string;failureReason:string|null;createdAt:string};
  const packages=this.db.query<Package,[string,string]>(`SELECT p.id,t.session_id AS roomId,COALESCE(c.id,json_extract(t.config_json,'$.costRootTaskId'),t.id) AS rootTaskId,p.run_id AS runId,p.attempt_no AS attemptNo,p.state,t.state AS taskState,p.failure_reason AS failureReason,p.created_at AS createdAt
   FROM work_packages p JOIN multi_tasks t ON t.id=p.task_id LEFT JOIN room_commands c ON c.task_id=t.id AND c.room_id=t.session_id
   WHERE ((json_extract(p.definition_json,'$.executorAgentId')=? AND p.state!='awaiting_review') OR (json_extract(p.definition_json,'$.reviewerAgentId')=? AND p.state='awaiting_review'))
   AND p.state NOT IN ('completed','failed','cancelled') AND t.state NOT IN ('completed','failed','cancelled') AND COALESCE(c.status,'')!='revoked'`).all(agentId,agentId);
  for(const p of packages){const state:AgentWorkState=p.taskState==='paused'||p.state==='budget_stopped'?'paused':p.taskState==='awaiting_plan_approval'?'awaiting_approval':p.failureReason==='workspace_write_lease_busy'?'workspace_waiting':['ready','waiting'].includes(p.state)?'queued':p.state as AgentWorkState;items.push({id:p.id,kind:'work_package',roomId:p.roomId,rootTaskId:p.rootTaskId,runId:p.runId,workPackageId:p.id,attemptNo:p.attemptNo,state,createdAt:p.createdAt});}
  const tasks=this.db.query<{id:string;roomId:string;rootTaskId:string;state:string;attemptNo:number;createdAt:string},[string]>(`SELECT t.id,t.session_id AS roomId,COALESCE(c.id,json_extract(t.config_json,'$.costRootTaskId'),t.id) AS rootTaskId,t.state,t.attempt_no AS attemptNo,t.created_at AS createdAt FROM multi_tasks t LEFT JOIN room_commands c ON c.task_id=t.id AND c.room_id=t.session_id WHERE json_extract(t.config_json,'$.synthesizerId')=? AND t.state IN ('preparing','synthesizing','revising_plan','awaiting_plan_approval','awaiting_tool_approval','paused') AND COALESCE(c.status,'')!='revoked'`).all(agentId);
  for(const t of tasks){if(items.some(i=>i.rootTaskId===t.rootTaskId))continue;const state:AgentWorkState=t.state==='paused'?'paused':t.state.includes('approval')?'awaiting_approval':t.state==='preparing'?'queued':'running';items.push({id:t.id,kind:'task',roomId:t.roomId,rootTaskId:t.rootTaskId,runId:null,workPackageId:null,attemptNo:t.attemptNo,state,createdAt:t.createdAt});}
  const sessions=new SessionStore(this.db);
  const pending=this.db.query<{id:string;room_id:string;work_item_id:string|null;input_json:string;status:string;created_at:string},[]>("SELECT * FROM work_interactions WHERE status IN ('queued','dispatching','blocked') AND room_id IS NOT NULL AND (status!='dispatching' OR NOT EXISTS(SELECT 1 FROM room_commands c WHERE c.client_request_id='interaction:'||work_interactions.id)) AND NOT EXISTS(SELECT 1 FROM leader_report_receipts r WHERE r.event_id='user:'||work_interactions.id AND r.evaluation_id IS NOT NULL)").all();
  for(const instruction of pending){
   const room=sessions.get(instruction.room_id);if(!room)continue;
   const input=JSON.parse(instruction.input_json);
   let targets:string[]=[];
   try{
    if(input.action==='message')targets=queuedMessageAgents(this.db,room,input);
    else if(['reevaluate','delegate_package'].includes(input.action)&&instruction.work_item_id){
     const leader=this.db.query<{agent_id:string},[string,string]>("SELECT json_extract(t.config_json,'$.synthesizerId') AS agent_id FROM work_item_runs r JOIN room_commands c ON c.id=r.command_id JOIN multi_tasks t ON t.id=c.task_id WHERE r.work_item_id=? AND r.execution_room_id=? ORDER BY r.rowid DESC LIMIT 1").get(instruction.work_item_id,room.id);
     if(leader)targets=[leader.agent_id];
    }
   }catch{continue;}
   if(targets.includes(agentId))items.push({id:instruction.id,kind:'instruction',roomId:room.id,rootTaskId:null,runId:null,workPackageId:null,attemptNo:0,state:instruction.status==='blocked'?'paused':'queued',createdAt:instruction.created_at});
  }
  const evaluations=this.db.query<{id:string;roomId:string;taskId:string;status:string;createdAt:string},[string]>("SELECT e.id,t.session_id AS roomId,t.id AS taskId,e.status,e.created_at AS createdAt FROM leader_evaluations e JOIN multi_tasks t ON t.id=e.task_id WHERE json_extract(t.config_json,'$.synthesizerId')=? AND e.status IN ('pending','running','blocked','awaiting_review')").all(agentId);
  for(const evaluation of evaluations){
   // Terminal-parent normalization can omit the turn; deduplicate only work actually projected.
   const turn=evaluation.status==='running'?this.db.query<{id:string},[string,string]>("SELECT id FROM multi_turns WHERE task_id=? AND stable_key=? AND status='running'").get(evaluation.taskId,'leader-evaluation:'+evaluation.id):null;
   if(turn&&items.some(item=>item.kind==='discussion'&&item.id===turn.id&&item.state==='running'))continue;
   items.push({id:evaluation.id,kind:'leader_evaluation',roomId:evaluation.roomId,rootTaskId:resolveExecutionRoot(this.db,evaluation.roomId,evaluation.taskId),runId:null,workPackageId:null,attemptNo:0,state:evaluation.status==='pending'?'queued':evaluation.status==='blocked'?'paused':evaluation.status==='awaiting_review'?'awaiting_review':'running',createdAt:evaluation.createdAt});
  }
  return projectAgentWorkload(items.filter(item=>!item.rootTaskId||!this.db.query("SELECT 1 FROM room_commands WHERE id=? AND status='revoked'").get(item.rootTaskId)));
 }
 detail(agentId:string,after?:string,limit=20):AgentLifecycleDetail|null {
  const presence=this.presence(agentId);if(!presence)return null;
  const until=new Date(this.now()).toISOString(),since=new Date(this.now()-30*86400000).toISOString();
  const activity=this.runRows(agentId,' AND createdAt>=? AND createdAt<=?',[since,until]);
  const window=activity.filter(r=>!r.kind.startsWith('discussion')),discussion=activity.filter(r=>r.kind==='discussion'),discussionCommands=activity.filter(r=>r.kind==='discussion_command');
  const rows=this.runRows(agentId,(after?' AND createdAt||\'|\'||id<?':'')+' ORDER BY createdAt DESC,id DESC LIMIT ?',[...(after?[after]:[]),limit+1]);
  const squads=this.db.query<{id:string;name:string;workspaceId:string;responsibility:string;archived:number},[string]>(`SELECT s.id,s.name,s.workspace_id AS workspaceId,m.responsibility,s.archived FROM squad_members m JOIN squad_templates s ON s.id=m.squad_id WHERE m.agent_id=? ORDER BY s.name`).all(agentId).map(s=>({...s,archived:!!s.archived}));
  const assignments=this.db.query<AgentLifecycleDetail['assignments'][number],[string]>(`SELECT w.id,w.title,w.workspace_id AS workspaceId,w.owner_kind AS ownerKind,w.owner_id AS ownerId FROM work_items w WHERE w.owner_kind='agent' AND w.owner_id=? AND NOT EXISTS(SELECT 1 FROM work_item_reviews v JOIN work_item_runs r ON r.id=v.run_id WHERE r.work_item_id=w.id AND v.decision='accept' AND r.rowid=(SELECT MAX(rowid) FROM work_item_runs WHERE work_item_id=w.id) AND v.rowid=(SELECT MAX(rowid) FROM work_item_reviews WHERE work_item_id=w.id)) ORDER BY w.updated_at DESC LIMIT 100`).all(agentId);
  return {...presence,squads,assignments,recentRuns:{runs:rows.slice(0,limit).map(({agentId:_,error:__,turnId:___,cursor:____,...run})=>run),next:rows.length>limit?rows[limit-1]!.cursor:null},statistics:{since,until,totalRuns:window.length,completedRuns:window.filter(r=>r.status==='completed').length,failedRuns:window.filter(r=>r.status==='failed').length,cancelledRuns:window.filter(r=>r.status==='cancelled').length,interruptedRuns:window.filter(r=>r.status==='interrupted'||r.status==='budget_stopped').length,discussionCommands:discussionCommands.length,discussionTurns:discussion.length,completedDiscussionTurns:discussion.filter(r=>r.status==='completed').length,failedDiscussionTurns:discussion.filter(r=>r.status==='failed').length,scope:'native_runs_started_in_window'},cost:new CostLedger(this.db).summary({agentId,since,until})};
 }
}
