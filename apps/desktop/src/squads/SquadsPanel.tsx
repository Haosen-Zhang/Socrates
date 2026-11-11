import AgentDetailPanel from "../agent-lifecycle/AgentDetailPanel";
import AgentPresence from "../agent-lifecycle/AgentPresence";
import type { AgentAvailabilityProjection, AgentWorkloadProjection } from "@socrates/core";
import { useEffect, useState } from "react";
import { AGENT_AVATARS, type SquadTemplate, type SquadRoomBinding } from "@socrates/core";
import { ActorPicker, ConfirmationDialog, DetailPanel, EmptyState, ErrorNotice, ObjectPage } from "../foundation";
import { useStorePick } from "../selectors";
import { requireOk, sidecarFetch, type Handshake } from "../transport";
import AgentAvatar from "../AgentAvatar";
import AgentEditor from "../AgentEditor";
import "./squads.css";

type Detail = {
  squad: SquadTemplate;
  members: Array<{agentId:string; availability:string; reason:string; activeRuns:number;availabilityProjection:AgentAvailabilityProjection|null;workload:AgentWorkloadProjection|null}>;
  rooms: Array<{roomId:string; revision:number}>;
  recentRuns: Array<{id:string; agentId?:string; status:string}>;
  activeWorkItems: Array<{id:string; title:string}>;
};
type Draft = Pick<SquadTemplate,"workspaceId"|"name"|"avatar"|"leaderAgentId"|"description"|"instructions"|"members">;
export default function SquadsPanel({workspaceId,handshake,onOpenRoom,onAssign}:{workspaceId:string;handshake:Handshake;onOpenRoom:()=>void;onAssign?:(squadId:string)=>void}) {
  const {agents,providers,sessions,loadSessions,selectAgentSession,lang}=useStorePick("agents","providers","sessions","loadSessions","selectAgentSession","lang");
  const tr=(zh:string,en:string)=>lang!=="en"?zh:en;
  const [agentDetail,setAgentDetail]=useState<string|null>(null);
  const [rows,setRows]=useState<SquadTemplate[]>([]),[detail,setDetail]=useState<Detail|null>(null);
  const [selected,updateSelected]=useState(()=>sessionStorage.getItem(`socrates.squad.${workspaceId}`)??"");
  const setSelected=(id:string)=>{sessionStorage.setItem(`socrates.squad.${workspaceId}`,id);updateSelected(id);};
  const [query,setQuery]=useState(""),[archived,setArchived]=useState(false),[revision,setRevision]=useState(0),[error,setError]=useState("");
  const [draft,setDraft]=useState<Draft|null>(null),[editing,setEditing]=useState<SquadTemplate|null>(null),[newAgent,setNewAgent]=useState(false),[busy,setBusy]=useState(false);
  const [archiveOpen,setArchiveOpen]=useState(false),[roomTitle,setRoomTitle]=useState(""),[bindRoom,setBindRoom]=useState(""),[binding,setBinding]=useState<SquadRoomBinding|null>(null);
  const request=<T,>(path:string,body?:unknown,method="POST")=>sidecarFetch(handshake,`/squads${path}`,body===undefined?undefined:{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(requireOk<T>);
  useEffect(()=>{
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{
      const result=await sidecarFetch(handshake,`/squads?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:controller.signal}).then(requireOk<SquadTemplate[]>);
      const current=selected?await sidecarFetch(handshake,`/squads/${encodeURIComponent(selected)}`,{signal:controller.signal}).then(requireOk<Detail>):null;
      if(!controller.signal.aborted){setRows(result);setDetail(current);setError("");}
    }catch(e){if(!controller.signal.aborted){setError(String(e));setDetail(null);}}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void load(),4000);}};
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[handshake,workspaceId,selected,revision]);
  useEffect(()=>{
    setBinding(null);if(!bindRoom)return;
    const c=new AbortController();void sidecarFetch(handshake,`/squads/rooms/${encodeURIComponent(bindRoom)}/binding`,{signal:c.signal}).then(requireOk<SquadRoomBinding|null>).then(value=>{if(!c.signal.aborted)setBinding(value);}).catch(e=>{if(!c.signal.aborted)setError(String(e));});return()=>c.abort();
  },[bindRoom,handshake,revision]);
  const act=async(operation:()=>Promise<void>)=>{if(busy)return;setBusy(true);setError("");try{await operation();setRevision(v=>v+1);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}};
  const actors=agents.map(a=>({id:a.id,label:a.nickname,description:`${providers.find(p=>p.id===a.providerId)?.name??a.providerId} · ${a.modelId}`,avatar:<AgentAvatar src={a.avatar} label={a.nickname} size={24} lively={false}/>}));
  const begin=(s?:SquadTemplate)=>{setEditing(s??null);setDraft(s?structuredClone(s):{workspaceId,name:"",avatar:null,leaderAgentId:"",description:"",instructions:"",members:[]});setError("");};
  const chooseLeader=(id:string|null)=>{if(!id||!draft)return;setDraft({...draft,leaderAgentId:id,members:draft.members.some(m=>m.agentId===id)?draft.members:[...draft.members,{agentId:id,responsibility:""}]});};
  const unavailable=(s:SquadTemplate)=>s.members.some(m=>{const a=agents.find(a=>a.id===m.agentId);return !a||!providers.find(p=>p.id===a.providerId)?.enabled;});
  const visible=rows.filter(s=>(archived||!s.archived)&&`${s.name} ${s.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const current=detail?.squad.id===selected?detail:null;
  return <div className="work-project-hub squad-hub" data-squads>
    <ObjectPage title={tr("Squad 团队","Squads")} description={tr("复用团队配置；更新模板不会改变已开始的任务。","Reusable teams. Template edits do not change started tasks.")} actions={<button className="pixel-button px-3 py-2" onClick={()=>begin()}>{tr("新建 Squad","New squad")}</button>}>
      <div className="work-task-filters"><input type="search" className="pixel-input px-3 py-2" aria-label={tr("搜索 Squad","Search squads")} value={query} onChange={e=>setQuery(e.target.value)}/><label><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/> {tr("包含归档","Include archived")}</label></div>
      {error&&<ErrorNotice message={error}/>} {!visible.length&&<EmptyState title={tr("暂无匹配的团队","No matching squads")}/>}
      <ul className="work-task-list">{visible.map(s=><li key={s.id}><button className="work-task-row" aria-pressed={selected===s.id} onClick={()=>{setSelected(s.id);setDetail(null);setBindRoom("");}}>
        <AgentAvatar src={s.avatar??agents.find(a=>a.id===s.leaderAgentId)?.avatar} label={s.name} size={36} lively={false}/><span className="work-task-row__main"><strong>{s.name}</strong><small>Leader: {agents.find(a=>a.id===s.leaderAgentId)?.nickname??s.leaderAgentId} · v{s.revision}{s.archived?` · ${tr("已归档","Archived")}`:""}</small><small>{unavailable(s)?tr("成员或供应商不可用，请查看详情","Member or provider unavailable; see details"):tr("查看成员可用性与当前工作","View member availability and current work")}</small><small>{tr("活跃工作事项","Active work items")}: {s.activeWorkItemCount??0} · {new Date(s.updatedAt).toLocaleString()}</small><small>{s.members.map(m=>agents.find(a=>a.id===m.agentId)?.nickname??m.agentId).join(" · ")}</small></span>
      </button></li>)}</ul>
    </ObjectPage>
    {current&&!draft&&<DetailPanel drawer open title={current.squad.name} closeLabel={tr("关闭团队详情","Close squad detail")} onClose={()=>setSelected("")}>
      <div className="squad-form"><p>{current.squad.description}</p><p>v{current.squad.revision} · {new Date(current.squad.updatedAt).toLocaleString()}</p>
      {error&&<ErrorNotice message={error}/>}
      <h3>{tr("成员与职责","Members and responsibilities")}</h3>
      {current.squad.members.map(m=>{const a=agents.find(a=>a.id===m.agentId),status=current.members.find(a=>a.agentId===m.agentId);return <article key={m.agentId} className="squad-member"><AgentAvatar src={a?.avatar} label={a?.nickname??m.agentId} size={32} lively={false}/><div><strong>{a?.nickname??m.agentId}{m.agentId===current.squad.leaderAgentId?" · Leader":""}</strong><p>{m.responsibility||tr("未填写职责","No responsibility specified")}</p><small>{a?.modelId}</small><div>{status?.availabilityProjection&&status.workload?<AgentPresence availability={status.availabilityProjection} workload={status.workload} en={lang==="en"}/>:<p>{status?.reason}</p>}</div><button className="pixel-button px-2 py-1" aria-label={`${tr("查看 Agent","View agent")} ${a?.nickname??m.agentId}`} onClick={()=>setAgentDetail(m.agentId)}>{tr("Agent 详情与时间线","Agent detail and timeline")}</button></div></article>;})}
      <h3>{tr("Leader 协作指令","Leader instructions")}</h3><p className="work-task-objective">{current.squad.instructions||"—"}</p>
      <h3>{tr("活跃工作事项","Active work items")} ({current.activeWorkItems.length})</h3>{current.activeWorkItems.map(item=><p key={item.id}>{item.title}</p>)}
      <h3>{tr("当前绑定房间中的运行","Runs in currently bound rooms")}</h3>{current.recentRuns.map(run=><p key={run.id}>{run.agentId&& (agents.find(a=>a.id===run.agentId)?.nickname??run.agentId)} · {run.status} <small>{run.id}</small></p>)}
      <h3>{tr("使用此模板的房间","Rooms using this template")}</h3>{current.rooms.map(r=><p key={r.roomId}>{sessions.find(s=>s.id===r.roomId)?.title??r.roomId} · v{r.revision} <button className="pixel-button px-2" disabled={busy} onClick={()=>void act(async()=>{const bound=await request<SquadRoomBinding>(`/rooms/${r.roomId}/binding`);await request(`/rooms/${r.roomId}/detach`,{expectedBindingVersion:bound.bindingVersion});await loadSessions();})}>{tr("保留快照并解除绑定","Keep snapshot and detach")}</button>{r.revision!==current.squad.revision?` · ${tr("有新版本","Update available")}`:""}</p>)}
      {!current.squad.archived&&<><div className="squad-actions"><button className="pixel-button px-3 py-2" onClick={()=>begin(current.squad)}>{tr("编辑团队","Edit squad")}</button>{onAssign&&<button className="pixel-button px-3 py-2" onClick={()=>onAssign(current.squad.id)}>{tr("分配任务","Assign task")}</button>}<button className="pixel-button px-3 py-2" onClick={()=>setArchiveOpen(true)}>{tr("归档团队","Archive squad")}</button></div>
      <label>{tr("新 Work 房间名称","New Work room title")}<input className="pixel-input" value={roomTitle} onChange={e=>setRoomTitle(e.target.value)}/></label><button className="pixel-button px-3 py-2" disabled={busy} onClick={()=>void act(async()=>{const result=await request<{room:{id:string}}>(`/${selected}/rooms`,{title:roomTitle||current.squad.name,expectedRevision:current.squad.revision});await loadSessions();await selectAgentSession(result.room.id);setSelected("");onOpenRoom();})}>{tr("从 Squad 新建 Work 房间","Create Work room from squad")}</button>
      <label>{tr("绑定或更新已有房间","Bind or update existing room")}<select className="pixel-input" value={bindRoom} onChange={e=>setBindRoom(e.target.value)}><option value="">{tr("选择房间","Choose room")}</option>{sessions.filter(s=>s.kind==="cowork"&&s.workspaceId===workspaceId&&!s.archived).map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      {bindRoom&&<><p>{binding?`${tr("已绑定版本","Bound revision")}: v${binding.revision}`:tr("此房间未绑定团队","This room has no squad binding")}</p><p>{tr("显式应用当前模板。正在执行的房间需先结束任务。","Explicitly apply this revision. A running room must finish first.")}</p><button disabled={busy} className="pixel-button px-3 py-2" onClick={()=>void act(async()=>{await request(`/${selected}/bind`,{roomId:bindRoom,expectedRevision:current.squad.revision,expectedBindingVersion:binding?.bindingVersion??null});await loadSessions();})}>{tr("应用当前版本","Apply current revision")}</button></>}
      </>}
      {current.squad.archived&&<p>{tr("已归档：保留历史引用，不接受新绑定或新任务。","Archived: historical references remain; new bindings and tasks are unavailable.")}</p>}
      </div>
    </DetailPanel>}
    {draft&&<DetailPanel drawer open title={editing?tr("编辑团队","Edit squad"):tr("新建 Squad","New squad")} closeLabel={tr("取消编辑","Cancel editing")} onClose={()=>{if(!busy){setDraft(null);setEditing(null);}}}><div className="squad-form">
      <ActorPicker label="Leader" actors={actors} value={draft.leaderAgentId} onChange={chooseLeader}/>
      <button className="pixel-button px-3 py-2" onClick={()=>setNewAgent(true)}>{tr("新建角色并加入","Create and add agent")}</button>
      <label>{tr("团队名称","Squad name")}<input className="pixel-input" value={draft.name} onChange={e=>setDraft({...draft,name:e.target.value})}/></label>
      <label>{tr("团队头像","Squad avatar")}<select className="pixel-input" value={draft.avatar??""} onChange={e=>setDraft({...draft,avatar:e.target.value||null})}><option value="">{tr("使用 Leader 头像","Use Leader avatar")}</option>{AGENT_AVATARS.map((avatar,index)=><option key={avatar} value={avatar}>{tr("头像","Avatar")} {index+1}</option>)}</select></label>
      <label>{tr("说明","Description")}<textarea className="pixel-input" value={draft.description} onChange={e=>setDraft({...draft,description:e.target.value})}/></label>
      <label>{tr("Leader 协作指令","Leader instructions")}<textarea className="pixel-input" value={draft.instructions} onChange={e=>setDraft({...draft,instructions:e.target.value})}/></label>
      <ActorPicker label={tr("添加成员","Add member")} actors={actors.filter(a=>!draft.members.some(m=>m.agentId===a.id))} value={null} onChange={id=>{if(id)setDraft({...draft,members:[...draft.members,{agentId:id,responsibility:""}]});}}/>
      {draft.members.map(m=><div key={m.agentId} className="squad-member-edit"><label>{agents.find(a=>a.id===m.agentId)?.nickname??m.agentId}{m.agentId===draft.leaderAgentId?" · Leader":""}<input className="pixel-input" aria-label={`${tr("职责","Responsibility")} ${agents.find(a=>a.id===m.agentId)?.nickname??m.agentId}`} value={m.responsibility} onChange={e=>setDraft({...draft,members:draft.members.map(v=>v.agentId===m.agentId?{...v,responsibility:e.target.value}:v)})}/></label>{m.agentId!==draft.leaderAgentId?<button className="pixel-button px-2" onClick={()=>setDraft({...draft,members:draft.members.filter(v=>v.agentId!==m.agentId)})}>{tr("移除","Remove")}</button>:<small>{tr("需先更换 Leader 才能移除","Change Leader before removing")}</small>}</div>)}
      {error&&<ErrorNotice message={error}/>}<button className="pixel-button pixel-button--primary px-3 py-2" disabled={busy||!draft.name.trim()||!draft.leaderAgentId} onClick={()=>void act(async()=>{const saved=await request<SquadTemplate>(editing?`/${editing.id}`:"",{...draft,...(editing?{expectedRevision:editing.revision}:{})},editing?"PUT":"POST");setDraft(null);setEditing(null);setSelected(saved.id);})}>{tr("保存团队","Save squad")}</button>
    </div></DetailPanel>}
    {newAgent&&<AgentEditor onClose={()=>setNewAgent(false)} onSaved={agent=>{if(draft)setDraft({...draft,leaderAgentId:draft.leaderAgentId||agent.id,members:[...draft.members,{agentId:agent.id,responsibility:agent.role}]});}}/>}
    {agentDetail&&<AgentDetailPanel agentId={agentDetail} handshake={handshake} onClose={()=>setAgentDetail(null)} onOpenRoom={()=>{setSelected("");onOpenRoom();}}/>}
    <ConfirmationDialog open={archiveOpen} onOpenChange={setArchiveOpen} title={tr("归档团队","Archive squad")} description={tr("保留现有房间与任务的冻结配置；后续可在房间显式改用其他团队，历史不删除。","Keep frozen room and task references. Rebind rooms explicitly later; history is retained.")} confirmLabel={tr("保留引用并归档","Keep references and archive")} cancelLabel={tr("取消","Cancel")} pending={busy} error={error} onConfirm={()=>act(async()=>{await request(`/${selected}/archive`,{expectedRevision:current!.squad.revision,referencePolicy:"keep_frozen"});setArchiveOpen(false);})}>
      <p>{tr("受影响房间","Affected rooms")}: {current?.rooms.length??0} · {tr("活跃任务","Active tasks")}: {current?.activeWorkItems.length??0}</p>
    </ConfirmationDialog>
  </div>;
}
