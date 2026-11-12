import type { WorkVerification } from './work-verification';
import { taskVerificationTarget } from './work-verification';
import { SessionStore } from '../store/session-store';
import { WorkPackageStore } from '../multi-agent/work-package-store';
import type { Database } from 'bun:sqlite';
import type { WorkItem, WorkItemOwnerKind, WorkItemSummary } from '@socrates/core';
import type { RoomCommandService } from './room-command-service';
type Owner = { ownerKind: WorkItemOwnerKind; ownerId?: string | null };
export type WorkItemInput = Owner & { workspaceId: string; roomId?: string | null; sourceMessageId?: string | null; title: string; objective: string; acceptanceCriteria: string[]; priority: 'low'|'normal'|'high' };
export class WorkItemConflict extends Error {}
export class WorkItemService {
  constructor(private db: Database, private commands: Pick<RoomCommandService, 'get'>, private verification?: Pick<WorkVerification,'view'>) {}
  validateOwner(workspaceId: string, input: Owner) {
    if (!['user','agent','squad'].includes(input.ownerKind)) throw new Error('Invalid owner');
    if (input.ownerKind === 'user') { if (input.ownerId != null) throw new Error('User owner must not have an ID'); return; }
    if (typeof input.ownerId !== 'string' || !input.ownerId) throw new Error('Owner ID required');
    const row = input.ownerKind === 'agent' ? this.db.query('SELECT id FROM agents WHERE id=?').get(input.ownerId) : this.db.query('SELECT id FROM squad_templates WHERE id=? AND workspace_id=? AND archived=0').get(input.ownerId, workspaceId);
    if (!row) throw new Error('Owner not found');
  }
  create(input: WorkItemInput): WorkItem {
    if (!input || typeof input.workspaceId !== 'string' || !this.db.query('SELECT id FROM workspaces WHERE id=?').get(input.workspaceId)) throw new Error('Workspace not found');
    if (typeof input.title !== 'string' || !input.title.trim() || typeof input.objective !== 'string' || !Array.isArray(input.acceptanceCriteria) || input.acceptanceCriteria.some(x=>typeof x !== 'string') || !['low','normal','high'].includes(input.priority)) throw new Error('Invalid work item');
    this.validateOwner(input.workspaceId,input);
    if (input.roomId != null && (typeof input.roomId !== 'string' || !this.db.query("SELECT id FROM sessions WHERE id=? AND workspace_id=? AND kind='cowork'").get(input.roomId,input.workspaceId))) throw new Error('Room not found in workspace');
    if (input.sourceMessageId != null && (!input.roomId || typeof input.sourceMessageId !== 'string' || !this.db.query('SELECT id FROM session_messages WHERE id=? AND session_id=?').get(input.sourceMessageId,input.roomId))) throw new Error('Source message not found in room');
    const id=crypto.randomUUID(), now=new Date().toISOString();
    this.db.query('INSERT INTO work_items VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(id,input.workspaceId,input.roomId??null,input.sourceMessageId??null,input.title.trim(),input.objective,JSON.stringify(input.acceptanceCriteria),input.ownerKind,input.ownerId??null,input.priority,input.ownerKind==='user'?'backlog':'todo','pending',1,now,now);
    return this.get(id)!;
  }
  list(workspaceId:string):WorkItemSummary[] { if (!workspaceId) throw new Error('Workspace required'); return this.db.query<{id:string},[string]>('SELECT id FROM work_items WHERE workspace_id=? ORDER BY updated_at DESC').all(workspaceId).map(x=>this.summary(x.id)!); }
  summary(id:string):WorkItemSummary|null { const item=this.project(id,false);if(!item)return null;const {messages,workPackages,reviews,artifacts,...summary}=item;return summary; }
  get(id:string):WorkItem|null { return this.project(id,true); }
  private project(id:string,includeHistory:boolean):WorkItem|null {
    const r=this.db.query<Record<string,any>,[string]>('SELECT * FROM work_items WHERE id=?').get(id); if (!r) return null;
    const runs=this.db.query<Record<string,any>,[string]>('SELECT * FROM work_item_runs WHERE work_item_id=? ORDER BY rowid').all(id).map(x=>{const command=x.command_id?this.commands.get(x.command_id):null;return {id:x.id,clientRequestId:x.client_request_id,commandId:x.command_id,executionRoomId:x.execution_room_id,frozenOwner:JSON.parse(x.frozen_owner_json),state:x.state,commandError:command?.error ?? null,commandStatus:command?.status ?? null,createdAt:x.created_at};});
    const last=runs.at(-1);
    const review=last ? this.db.query<{decision:string;verification_run_id:string|null;verification_revision:string|null},[string]>('SELECT decision,verification_run_id,verification_revision FROM work_item_reviews WHERE run_id=? ORDER BY rowid DESC LIMIT 1').get(last.id) : null;
    const verification=last?.commandId&&last.executionRoomId?this.verification?.view({roomId:last.executionRoomId,rootTaskId:last.commandId}):null;
    const invalidated=!!verification&&!verification.gatePassed;
    const changedEvidence=!!review?.verification_revision&&review.verification_revision!==verification?.evidenceRevision;
    const legacyVerifiedReview=!!review?.verification_run_id&&!review.verification_revision;
    const reviewState:WorkItem['reviewState']=review?.decision==='request_changes'?'changes_requested':review?.decision==='accept'&&!invalidated&&!changedEvidence&&!legacyVerifiedReview?'accepted':'pending';
    const workflow:WorkItem['workflow']=reviewState==='accepted'?'done':last?.commandStatus==='completed' && reviewState!=='changes_requested'?'in_review':last && (last.state==='preparing'||last.commandStatus==='interrupted'&&(last.commandError?.startsWith('cost_budget_')||last.commandError==='budget_exhausted')||!!last.commandStatus && !['completed','failed','cancelled','interrupted','revoked'].includes(last.commandStatus))?'in_progress':r.manual_state;
    const rooms=includeHistory?[...new Set(runs.flatMap(run=>run.executionRoomId?[run.executionRoomId]:[]))]:[];
    const sessions=new SessionStore(this.db), packages=new WorkPackageStore(this.db);
    const messages=rooms.flatMap(room=>sessions.listMessages(room));
    const workPackages=rooms.flatMap(room=>this.db.query<{id:string},[string]>('SELECT id FROM multi_tasks WHERE session_id=?').all(room).flatMap(task=>packages.list(task.id).map(p=>({...p,verificationTarget:taskVerificationTarget(this.db,task.id,p.id)}))));
    const reviews=includeHistory?this.db.query<{id:string;decision:'accept'|'request_changes';createdAt:string;runId:string|null},[string]>('SELECT id,decision,created_at AS createdAt,run_id AS runId FROM work_item_reviews WHERE work_item_id=? ORDER BY rowid').all(id):[];
    const artifacts=rooms.flatMap(room=>this.db.query<{id:string;roomId:string;path:string;mediaType:string},[string]>("SELECT id, session_id AS roomId, '' AS path, media_type AS mediaType FROM tool_result_artifacts WHERE session_id=?").all(room));
    return {messages,workPackages,reviews,artifacts,id:r.id,workspaceId:r.workspace_id,roomId:r.room_id,sourceMessageId:r.source_message_id,title:r.title,objective:r.objective,acceptanceCriteria:JSON.parse(r.acceptance_json),ownerKind:r.owner_kind,ownerId:r.owner_id,priority:r.priority,workflow,reviewState,revision:r.revision,createdAt:r.created_at,updatedAt:r.updated_at,runs,currentRun:last ?? null,waitReason:reviewState!=='changes_requested'&&(invalidated||changedEvidence||legacyVerifiedReview)?'verification_invalidated':workflow==='in_review'?'human_review':last?.commandStatus==='interrupted'&&(last.commandError?.startsWith('cost_budget_')||last.commandError==='budget_exhausted')?last.commandError:last?.commandStatus?.startsWith('awaiting')||last?.commandStatus==='paused'?last.commandStatus:null};
  }
  assign(id:string, revision:number, input:Owner & {runDisposition:'keep_current'|'stop_then_handoff'}) {
    return this.db.transaction(()=>{ const item=this.get(id); if(!item || item.revision!==revision) throw new WorkItemConflict('Work item changed'); this.validateOwner(item.workspaceId,input);
      if(item.runs.some(run=>run.state==='preparing')) throw new WorkItemConflict('Launch is pending');
      if (!['keep_current','stop_then_handoff'].includes(input.runDisposition)) throw new Error('Run disposition required');
      if (item.workflow==='in_progress' && input.runDisposition==='stop_then_handoff') throw new Error('Stopping execution is not yet supported');
      this.db.query("UPDATE work_items SET owner_kind=?,owner_id=?,manual_state='todo',revision=revision+1,updated_at=? WHERE id=? AND revision=?").run(input.ownerKind,input.ownerId??null,new Date().toISOString(),id,revision); return this.get(id)!; })();
  }
  review(id:string, revision:number, decision:'accept'|'request_changes') {
    return this.db.transaction(()=>{ const item=this.get(id); if(!item || item.revision!==revision) throw new WorkItemConflict('Work item changed'); if(item.workflow!=='in_review') throw new Error('Work item is not awaiting review'); if(!['accept','request_changes'].includes(decision)) throw new Error('Invalid decision');
      const view=item.currentRun?.commandId&&item.currentRun.executionRoomId?this.verification?.view({roomId:item.currentRun.executionRoomId,rootTaskId:item.currentRun.commandId}):null;
      if(decision==='accept'&&view&&!view.gatePassed)throw new Error('verification_required_before_acceptance');
      const now=new Date().toISOString(); this.db.query('INSERT INTO work_item_reviews(id,work_item_id,decision,revision,created_at,run_id,verification_run_id,verification_revision) VALUES (?,?,?,?,?,?,?,?)').run(crypto.randomUUID(),id,decision,revision+1,now,item.currentRun!.id,view?.run?.id??null,view?.evidenceRevision??null); this.db.query('UPDATE work_items SET review_state=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(decision==='accept'?'accepted':'changes_requested',now,id,revision); return this.get(id)!; })();
  }
}
