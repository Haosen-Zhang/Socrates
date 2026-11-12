import { AgentLifecycleService } from "./agent-lifecycle";
import { DEFAULT_COLLABORATION_SETTINGS } from '@socrates/core';
import { SessionStore } from '../store/session-store';
import { toAgent, type AgentRow } from '../agents';
import type { Database } from 'bun:sqlite';
import type { SquadTemplate, SquadMember, WorkItem } from '@socrates/core';
export type SquadInput = Pick<SquadTemplate, 'workspaceId'|'name'|'leaderAgentId'|'description'|'instructions'|'avatar'|'members'|'routingPreset'>;
export class SquadConflict extends Error {}
export class SquadService {
  constructor(readonly db: Database, readonly sessions = new SessionStore(db), private workItems:(workspaceId:string)=>WorkItem[] = ()=>[], private lifecycle = new AgentLifecycleService(db)) {}
  list(workspaceId: string): SquadTemplate[] {
    const items=this.workItems(workspaceId);
    return this.db.query<{id:string},[string]>('SELECT id FROM squad_templates WHERE workspace_id = ? ORDER BY name').all(workspaceId).map(r => this.get(r.id,items)!);
  }
  get(id: string, items?: WorkItem[]): SquadTemplate | null {
    const r = this.db.query<Record<string, unknown>,[string]>('SELECT * FROM squad_templates WHERE id = ?').get(id);
    if (!r) return null;
    const members = this.db.query<{agent_id:string;responsibility:string},[string]>('SELECT agent_id, responsibility FROM squad_members WHERE squad_id = ? ORDER BY rowid').all(id).map(m=>({agentId:m.agent_id,responsibility:m.responsibility}));
    return {id,workspaceId:String(r.workspace_id),name:String(r.name),avatar:r.avatar as string|null,leaderAgentId:String(r.leader_agent_id),description:String(r.description),instructions:String(r.instructions),routingPreset:r.routing_preset as SquadTemplate["routingPreset"],revision:Number(r.revision),archived:!!r.archived,createdAt:String(r.created_at),updatedAt:String(r.updated_at),members,activeWorkItemCount:this.activeItems(id,String(r.workspace_id),items).length};
  }
  private validate(input: SquadInput) {
    if (!['manual','economy','balanced','quality','custom'].includes(input.routingPreset??'manual')) throw new Error('Invalid routing preset');
    if (!input.name.trim()) throw new Error('Squad name is required');
    if (!input.members.some(m=>m.agentId===input.leaderAgentId)) throw new Error('Leader must remain a member; change Leader before removal');
    if (new Set(input.members.map(m=>m.agentId)).size !== input.members.length) throw new Error('Duplicate member');
    for (const member of input.members) {
      const agent=this.db.query<{provider_id:string},[string]>('SELECT provider_id FROM agents WHERE id = ?').get(member.agentId);
      if (!agent) throw new Error('Agent does not exist');
      if (!this.db.query('SELECT id FROM providers WHERE id = ? ').get(agent.provider_id)) throw new Error('Agent provider does not exist');
    }
  }
  private members(id:string, members:SquadMember[]) {
    this.db.query('DELETE FROM squad_members WHERE squad_id = ?').run(id);
    for (const m of members) this.db.query('INSERT INTO squad_members(squad_id,agent_id,responsibility) VALUES(?,?,?)').run(id,m.agentId,m.responsibility);
  }
  create(input:SquadInput):SquadTemplate {
    this.validate(input);
    const id=crypto.randomUUID(), now=new Date().toISOString();
    this.db.transaction(()=>{
      this.db.query('INSERT INTO squad_templates(id,workspace_id,name,avatar,leader_agent_id,description,instructions,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,input.workspaceId,input.name.trim(),input.avatar,input.leaderAgentId,input.description,input.instructions,now,now);
      this.members(id,input.members);
      this.db.query('UPDATE squad_templates SET routing_preset=? WHERE id=?').run(input.routingPreset??'manual',id);
    })();
    return this.get(id)!;
  }
  update(id:string, revision:number, input:SquadInput):SquadTemplate {
    this.validate(input);
    this.db.transaction(()=>{
      const current=this.get(id);
      if (!current || current.revision!==revision || current.archived) throw new SquadConflict('Squad changed or was archived; refresh before editing');
      if(current.leaderAgentId!==input.leaderAgentId) {
        const row=this.db.query<AgentRow,[string]>('SELECT * FROM agents WHERE id=?').get(input.leaderAgentId)!;
        if(toAgent(row).modelCapabilities?.toolCalling!==true)throw new Error('Leader requires verified tool capability');
      }
      if (current.workspaceId!==input.workspaceId) throw new Error('Squad project cannot change');
      this.db.query('UPDATE squad_templates SET name=?,avatar=?,leader_agent_id=?,description=?,instructions=?,revision=revision+1,updated_at=? WHERE id=?').run(input.name.trim(),input.avatar,input.leaderAgentId,input.description,input.instructions,new Date().toISOString(),id);
      this.members(id,input.members);
      this.db.query('UPDATE squad_templates SET routing_preset=? WHERE id=?').run(input.routingPreset??'manual',id);
    })();
    return this.get(id)!;
  }
  private activeItems(id:string,workspaceId:string,items=this.workItems(workspaceId)){return items.filter(item=>item.ownerKind==='squad'&&item.ownerId===id&&item.workflow!=='done');}
  detail(id:string) {
    const squad=this.get(id); if(!squad)return null;
    const rooms=this.references(id);
    const members=squad.members.map(m=>{
      const presence=this.lifecycle.presence(m.agentId);
      return {agentId:m.agentId,availability:presence?.availability.state??'unavailable',reason:presence?.availability.reason??'agent_missing',availabilityProjection:presence?.availability??null,workload:presence?.workload??null,activeRuns:presence?.workload.items.length??0};
    });
    const recentRuns=this.db.query("SELECT DISTINCT r.* FROM agent_runs r LEFT JOIN squad_room_bindings b ON b.room_id=r.session_id LEFT JOIN work_item_runs w ON w.execution_room_id=r.session_id WHERE b.squad_id=? OR (json_extract(w.frozen_owner_json, '$.ownerKind')='squad' AND json_extract(w.frozen_owner_json, '$.ownerId')=?) ORDER BY r.created_at DESC LIMIT 20").all(id,id);
    return {squad,members,rooms,recentRuns:recentRuns.map(raw=>{const r=raw as Record<string,unknown>;return {id:r.id,roomId:r.session_id,status:r.status,createdAt:r.created_at,completedAt:r.completed_at};}),activeWorkItems:this.activeItems(id,squad.workspaceId),recentRunsScope:"bound_rooms_and_frozen_work_item_runs"};
  }
  references(id:string) { return this.db.query<{room_id:string;revision:number},[string]>('SELECT room_id,revision FROM squad_room_bindings WHERE squad_id=?').all(id).map(r=>({roomId:r.room_id,revision:r.revision})); }
  archive(id:string,revision:number) {
    const result=this.db.query('UPDATE squad_templates SET archived=1,revision=revision+1,updated_at=? WHERE id=? AND revision=? AND archived=0').run(new Date().toISOString(),id,revision);
    if (!result.changes) throw new SquadConflict('Squad changed; refresh before archiving');
    return this.get(id)!;
  }
  private busy(roomId:string) {
    return !!this.db.query(`SELECT c.id FROM room_commands c WHERE c.room_id=? AND c.status IN ('dispatching','running')
      AND NOT EXISTS(SELECT 1 FROM agent_runs original JOIN agent_runs latest ON latest.turn_id=original.turn_id WHERE original.id=c.run_id AND latest.id=(SELECT id FROM agent_runs WHERE turn_id=original.turn_id ORDER BY attempt_no DESC,created_at DESC LIMIT 1) AND latest.status IN ('completed','failed','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM multi_tasks t WHERE t.id=c.task_id AND t.state IN ('completed','failed','cancelled'))
      AND NOT EXISTS(SELECT 1 FROM adaptive_workflows w WHERE w.root_task_id=c.id AND w.status IN ('completed','failed','blocked','cancelled')) LIMIT 1`).get(roomId)
      || !!this.db.query("SELECT root_task_id FROM adaptive_workflows WHERE room_id=? AND status NOT IN ('completed','failed','blocked','cancelled') LIMIT 1").get(roomId)
      || !!this.db.query("SELECT id FROM multi_tasks WHERE session_id=? AND completed_at IS NULL LIMIT 1").get(roomId);
  }
  detach(roomId:string,expectedBindingVersion:number) {
    return this.db.transaction(()=>{
      const room=this.sessions.get(roomId);
      if(!room || !['idle','completed','failed','cancelled','interrupted'].includes(room.status) || this.busy(roomId))throw new SquadConflict('Room must be inactive');
      if(this.binding(roomId)?.bindingVersion!==expectedBindingVersion)throw new SquadConflict('Room binding changed');
      this.db.query('DELETE FROM squad_room_bindings WHERE room_id=?').run(roomId);
      return {roomId,detached:true};
    })();
  }
  binding(roomId:string) {
    const row=this.db.query<{room_id:string;squad_id:string;revision:number;binding_version:number;snapshot_json:string},[string]>('SELECT * FROM squad_room_bindings WHERE room_id=?').get(roomId);
    return row ? {roomId:row.room_id,squadId:row.squad_id,revision:row.revision,bindingVersion:row.binding_version,snapshot:JSON.parse(row.snapshot_json) as SquadTemplate} : null;
  }
  prepareForStart(id:string, expectedRevision:number) {
    const squad=this.get(id);
    if (!squad || squad.archived || squad.revision!==expectedRevision) throw new SquadConflict('Squad missing, archived or changed');
    this.validate(squad);
    // Presence is observational; an old failed probe must not block an explicit retry.
    if(squad.members.some(m=>!this.db.query<{enabled:number},[string]>('SELECT p.enabled FROM providers p JOIN agents a ON a.provider_id=p.id WHERE a.id=?').get(m.agentId)?.enabled))throw new Error('Squad provider unavailable');
    const agents=squad.members.map(member=>{
      const row=this.db.query<AgentRow,[string]>('SELECT * FROM agents WHERE id=?').get(member.agentId)!;
      const agent=toAgent(row);
      if (agent.modelCapabilities?.toolCalling !== true) throw new Error('Squad member requires verified tool capability');
      return {agentId:member.agentId,executionEligible:true,snapshot:{...agent,systemPrompt:agent.systemPrompt+(member.agentId===squad.leaderAgentId ? '\n\nSquad instructions: '+squad.instructions+'\nRoster: '+JSON.stringify(squad.members) : '')}};
    });
    const collaborationDefaults:import('@socrates/core').RoomCollaborationSettings={...DEFAULT_COLLABORATION_SETTINGS,strategy: 'team' as const,assignment:{...DEFAULT_COLLABORATION_SETTINGS.assignment,coordinatorAgentId:squad.leaderAgentId,callableAgentIds:squad.members.map(m=>m.agentId)}};
    if(squad.routingPreset && squad.routingPreset!=='manual') {
      collaborationDefaults.strategy=squad.routingPreset==='custom'?'team':'adaptive';
      collaborationDefaults.assignment.routing={...collaborationDefaults.assignment.routing,mode:squad.routingPreset==='custom'?'manual':'automatic',automaticPolicy:squad.routingPreset==='economy'?'cost':squad.routingPreset==='quality'?'quality':'balanced'};
    }
    return {squad,agents,collaborationDefaults};
  }
  createRoom(id:string, expectedRevision:number,title:string) {
    const p=this.prepareForStart(id,expectedRevision);
    const room=this.sessions.create({title,kind:'cowork',mode:p.agents.length>1?'multi_agent':'single_agent',workspaceId:p.squad.workspaceId,primaryAgentId:p.squad.leaderAgentId,agents:p.agents,collaborationDefaults:p.collaborationDefaults}, roomId=>this.saveBinding(roomId,p.squad));
    return {room,binding:this.binding(room.id)};
  }
  saveBinding(roomId:string,squad:SquadTemplate) {
    this.db.query('INSERT INTO squad_binding_versions(room_id,version) VALUES(?,1) ON CONFLICT(room_id) DO UPDATE SET version=version+1').run(roomId);
    this.db.query('INSERT INTO squad_room_bindings(room_id,squad_id,revision,snapshot_json,binding_version) VALUES(?,?,?,?,(SELECT version FROM squad_binding_versions WHERE room_id=?)) ON CONFLICT(room_id) DO UPDATE SET squad_id=excluded.squad_id,revision=excluded.revision,binding_version=excluded.binding_version,snapshot_json=excluded.snapshot_json').run(roomId,squad.id,squad.revision,JSON.stringify(squad),roomId);
  }
  bind(id:string,expectedRevision:number,roomId:string,expectedBindingVersion:number|null) {
    return this.sessions.applySquadBinding(()=>this.db.transaction(()=>{
      const p=this.prepareForStart(id,expectedRevision), room=this.sessions.get(roomId);
      if (!room || room.kind!=='cowork' || room.workspaceId!==p.squad.workspaceId) throw new Error('Work Room must belong to Squad project');
      if (!['idle','completed','failed','cancelled','interrupted'].includes(room.status) || this.busy(roomId)) throw new SquadConflict('Room must be idle before applying Squad');
      if ((this.binding(roomId)?.bindingVersion ?? null)!==expectedBindingVersion) throw new SquadConflict('Room binding changed');
      for(const a of p.agents) {
        if(room.agents.some(m=>m.agentId===a.agentId)) this.sessions.updateAgentSnapshot(roomId,a.agentId,a.snapshot);
        else this.sessions.addAgent(roomId,a.agentId,a.snapshot);
      }
      this.sessions.updatePrimaryAgent(roomId,p.squad.leaderAgentId);
      for(const a of room.agents) if(!p.agents.some(m=>m.agentId===a.agentId)) this.sessions.removeAgent(roomId,a.agentId);
      this.sessions.updateCollaboration(roomId,p.collaborationDefaults,p.squad.leaderAgentId);
      this.saveBinding(roomId,p.squad);
      return {room:this.sessions.get(roomId),binding:this.binding(roomId)};
    })());
  }

}
