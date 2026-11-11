import { useEffect, useRef, useState } from "react";
import { atomicToDecimal, decimalToAtomic, type WorkItem, type WorkItemOwnerKind, type SquadTemplate, type WorkItemPreview } from "@socrates/core";
import { ActorPicker, DetailPanel, EmptyState, ErrorNotice, ObjectPage, StatusBadge } from "../foundation";
import { useStorePick } from "../selectors";
import { requireOk, sidecarFetch, type Handshake } from "../transport";
import AgentAvatar from "../AgentAvatar";
import FlightRecorderPanel from "../flight-recorder/FlightRecorderPanel";
import "../squads/squads.css";
import "./work-items.css";

type Preview=WorkItemPreview;
type ItemDetail=WorkItem;
const ownerValue=(item:Pick<WorkItem,"ownerKind"|"ownerId">)=>item.ownerKind==="user"?"user":`${item.ownerKind}:${item.ownerId}`;
function ownerFields(value:string):{ownerKind:WorkItemOwnerKind;ownerId:string|null} {if(value==="user")return {ownerKind:"user",ownerId:null};const split=value.indexOf(":");return {ownerKind:value.slice(0,split) as WorkItemOwnerKind,ownerId:value.slice(split+1)};}
function runIdentity(value:unknown):string {
  if(!value || typeof value!=="object")return "—";
  const owner=value as {ownerKind?:string;ownerId?:string;snapshot?:{name?:string;nickname?:string;displayName?:string;revision?:number;leaderAgentId?:string}};
  const s=owner.snapshot;
  return [s?.name??s?.nickname??s?.displayName??owner.ownerId??owner.ownerKind,s?.revision?`v${s.revision}`:null,s?.leaderAgentId?`Leader: ${s.leaderAgentId}`:null].filter(Boolean).join(" · ");
}
export default function WorkItemsPanel({workspaceId,handshake,onOpenRoom,onHistory,initialSquad,onConsumeSquad}:{workspaceId:string;handshake:Handshake;onOpenRoom:()=>void;onHistory:()=>void;initialSquad:string|null;onConsumeSquad:()=>void}) {
  const {agents,providers,sessions,workspaces,loadSessions,selectAgentSession,lang}=useStorePick("agents","providers","sessions","workspaces","loadSessions","selectAgentSession","lang");
  const tr=(zh:string,en:string)=>lang==="en"?en:zh;
  const [rows,setRows]=useState<WorkItem[]>([]),[squads,setSquads]=useState<SquadTemplate[]>([]),[detail,setDetail]=useState<ItemDetail|null>(null);
  const [selected,updateSelected]=useState(()=>sessionStorage.getItem(`socrates.workitem.${workspaceId}`)??""),[refresh,setRefresh]=useState(0),[query,setQuery]=useState(""),[filter,setFilter]=useState("all"),[error,setError]=useState("");
  const setSelected=(id:string)=>{sessionStorage.setItem(`socrates.workitem.${workspaceId}`,id);updateSelected(id);};
  const [creating,setCreating]=useState(false),[title,setTitle]=useState(""),[objective,setObjective]=useState(""),[criteria,setCriteria]=useState(""),[priority,setPriority]=useState<WorkItem["priority"]>("normal"),[roomId,setRoomId]=useState("");
  const [assigning,setAssigning]=useState(false),[owner,setOwner]=useState("user"),[disposition,setDisposition]=useState("keep_current"),[budget,setBudget]=useState(""),[budgetMode,setBudgetMode]=useState("soft_limit"),[preview,setPreview]=useState<Preview|null>(null),[busy,setBusy]=useState(false),[recorder,setRecorder]=useState<string|null>(null);
  const requestId=useRef(crypto.randomUUID()),locked=useRef(false);
  const request=<T,>(path:string,body?:unknown,method="POST")=>sidecarFetch(handshake,`/work-items${path}`,body===undefined?undefined:{method,headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(requireOk<T>);
  useEffect(()=>{if(initialSquad){setCreating(true);setOwner(`squad:${initialSquad}`);onConsumeSquad();}},[initialSquad,onConsumeSquad]);
  useEffect(()=>{
    const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const [items,teams,current]=await Promise.all([
      sidecarFetch(handshake,`/work-items?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:c.signal}).then(requireOk<WorkItem[]>),
      sidecarFetch(handshake,`/squads?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:c.signal}).then(requireOk<SquadTemplate[]>),
      selected?sidecarFetch(handshake,`/work-items/${selected}`,{signal:c.signal}).then(requireOk<ItemDetail>):Promise.resolve(null),
    ]);if(!c.signal.aborted){setRows(items);setSquads(teams);setDetail(current);}}catch(e){if(!c.signal.aborted)setError(String(e));}finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),2000);}};
    void load();return()=>{c.abort();clearTimeout(timer);};
  },[workspaceId,handshake,selected,refresh]);
  const act=async(operation:()=>Promise<void>)=>{if(locked.current)return;locked.current=true;setBusy(true);setError("");try{await operation();setRefresh(v=>v+1);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{locked.current=false;setBusy(false);}};
  const actors=[{id:"user",label:tr("本机用户（我）","Me (local user)"),description:tr("只负责与审核，不调用模型","Own and review; no model execution")},...agents.map(a=>({id:`agent:${a.id}`,label:a.nickname,description:`${providers.find(p=>p.id===a.providerId)?.name??a.providerId} · ${a.modelId}`,avatar:<AgentAvatar src={a.avatar} label={a.nickname} size={24} lively={false}/> })),...squads.filter(s=>!s.archived).map(s=>({id:`squad:${s.id}`,label:`Squad · ${s.name}`,description:`Leader: ${agents.find(a=>a.id===s.leaderAgentId)?.nickname??s.leaderAgentId} · v${s.revision}`}))];
  const name=(item:Pick<WorkItem,"ownerKind"|"ownerId">)=>actors.find(a=>a.id===ownerValue(item))?.label??(item.ownerKind==="squad"?squads.find(s=>s.id===item.ownerId)?.name:item.ownerId)??"—";
  const label=(state:string)=>({backlog:tr("待办","Backlog"),todo:tr("待开始","To Do"),in_progress:tr("进行中","In Progress"),in_review:tr("待审核","In Review"),done:tr("已完成","Done")}[state]??state);
  const openRoom=async(id:string)=>{await loadSessions();await selectAgentSession(id);setSelected("");onOpenRoom();};
  const item=detail?.id===selected?detail:null;
  const editOwner=()=>{if(item){setOwner(ownerValue(item));setAssigning(true);setPreview(null);setDisposition("keep_current");setError("");requestId.current=crypto.randomUUID();}};
  const visible=rows.filter(r=>(filter==="all"||r.workflow===filter)&&`${r.title} ${r.objective} ${name(r)}`.toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  const busyRun=item?.workflow==='in_progress';
  const proposed=ownerFields(owner),squad=proposed.ownerKind==="squad"?squads.find(s=>s.id===proposed.ownerId):null;
  const targetId=proposed.ownerKind==="agent"?proposed.ownerId:squad?.leaderAgentId;
  return <div className="work-project-hub" data-work-items><ObjectPage title={tr("工作事项","Work items")} description={tr("长期目标、负责人和审核状态，与每次执行分别保留。","Goals, owners and review remain separate from each execution.")} actions={<div className="squad-actions"><button className="pixel-button px-3 py-2" onClick={()=>{setCreating(true);setOwner("user");setError("");}}>{tr("新建任务","New task")}</button><button className="pixel-button px-3 py-2" onClick={onHistory}>{tr("历史执行","Execution history")}</button></div>}>
    <div className="work-task-filters"><input type="search" className="pixel-input px-3 py-2" aria-label={tr("搜索任务","Search tasks")} value={query} onChange={e=>setQuery(e.target.value)}/><select className="pixel-input" aria-label={tr("任务状态","Task status")} value={filter} onChange={e=>setFilter(e.target.value)}><option value="all">{tr("全部状态","All statuses")}</option>{['backlog','todo','in_progress','in_review','done'].map(s=><option key={s} value={s}>{label(s)}</option>)}</select></div>
    {error&&<ErrorNotice message={error}/>} {!visible.length&&<EmptyState title={tr("暂无工作事项","No work items")}/>}
    <ul className="work-task-list">{visible.map(r=><li key={r.id}><button className="work-task-row" aria-pressed={selected===r.id} onClick={()=>{setSelected(r.id);setDetail(null);setRecorder(null);}}><span className="work-task-row__main"><strong>{r.title}</strong><small>{name(r)} · {r.priority} · {sessions.find(s=>s.id===r.roomId)?.title??tr("项目任务","Project task")}</small><small>{new Date(r.updatedAt).toLocaleString()}{r.currentRun?` · ${tr("当前运行","Current run")}: ${r.currentRun.commandStatus??r.currentRun.state}`:""}{r.waitReason?` · ${r.waitReason}`:""}</small></span><StatusBadge tone={r.workflow==="done"?"success":r.waitReason?"warning":"neutral"}>{label(r.workflow)}</StatusBadge></button></li>)}</ul>
    </ObjectPage>
    {item&&!assigning&&!creating&&<DetailPanel drawer open title={item.title} closeLabel={tr("关闭任务详情","Close task detail")} onClose={()=>setSelected("")}><div className="squad-form">
      <StatusBadge>{label(item.workflow)}</StatusBadge><p>{tr("负责人","Owner")}: {name(item)} · v{item.revision}</p><p className="work-task-objective">{item.objective}</p>{item.waitReason&&<p>{tr("等待原因","Waiting for")}: {item.waitReason==="human_review"?tr("等待人工审核","Human review"):item.waitReason}</p>}
      <h3>{tr("验收标准","Acceptance criteria")}</h3><ul>{item.acceptanceCriteria.map((c,i)=><li key={i}>{c}</li>)}</ul>
      {error&&<ErrorNotice message={error}/>}<button className="pixel-button px-3 py-2" onClick={editOwner}>{tr("分配 / 开始","Assign / start")}</button>
      {item.workflow==="in_review"&&<><p>{tr("执行完成不等于通过验收，请核对产物后决定。","Execution completion is not acceptance. Check the artifacts before deciding.")}</p><button className="pixel-button px-3 py-2" disabled={busy} onClick={()=>void act(async()=>{setDetail(await request<ItemDetail>(`/${item.id}/review`,{expectedRevision:item.revision,decision:"accept"}));})}>{tr("审核通过并完成","Accept and mark Done")}</button><button className="pixel-button px-3 py-2" disabled={busy} onClick={()=>void act(async()=>{setDetail(await request<ItemDetail>(`/${item.id}/review`,{expectedRevision:item.revision,decision:"request_changes"}));})}>{tr("要求修改","Request changes")}</button></>}
      {item.roomId&&<button className="pixel-button px-3 py-2" onClick={()=>void act(()=>openRoom(item.roomId!))}>{tr("打开来源房间","Open source room")}{item.sourceMessageId?` · ${tr("消息","message")}`:""}</button>}
      <h3>{tr("对话消息","Conversation")}</h3>{item.messages?.map(m=><p className="work-task-objective" key={m.id}>{m.content}</p>)}
      <h3>{tr("工作包","Work packages")}</h3>{item.workPackages?.map(p=><article key={p.id}><strong>{p.title}</strong> · {p.state}<ul>{p.acceptanceCriteria?.map((c,i)=><li key={i}>{c}</li>)}</ul></article>)}
      <h3>{tr("产物","Artifacts")}</h3>{item.artifacts?.map((a,i)=><p key={i}>{a.path||`${tr("已保存产物","Stored artifact")}: ${a.id}`} · {a.mediaType}</p>)}
      <h3>{tr("运行记录","Runs")}</h3>{item.runs.map(run=><article key={run.id}><p>{run.commandStatus??run.state} · {new Date(run.createdAt).toLocaleString()}</p><p>{run.id}</p><p>{tr("当次执行身份","Execution identity")}: {runIdentity(run.frozenOwner)}</p>{run.executionRoomId&&<button className="pixel-button px-3 py-2" onClick={()=>void act(()=>openRoom(run.executionRoomId!))}>{tr("打开执行房间（审批、费用与恢复）","Open execution room (approvals, cost and resume)")}</button>}{run.commandId&&<button className="pixel-button px-3 py-2" onClick={()=>setRecorder(recorder===run.id?null:run.id)}>{tr("查看执行时间线","View run timeline")}</button>}{recorder===run.id&&run.executionRoomId&&<FlightRecorderPanel handshake={handshake} roomId={run.executionRoomId} rootTaskId={run.commandId??undefined}/>}</article>)}
      <h3>{tr("审核记录","Reviews")}</h3>{item.reviews?.map(r=><p key={r.id}>{r.decision} · {new Date(r.createdAt).toLocaleString()}</p>)}
    </div></DetailPanel>}
    {creating&&<DetailPanel drawer open title={tr("新建任务","New task")} closeLabel={tr("取消新建任务","Cancel new task")} onClose={()=>{if(!busy)setCreating(false);}}><div className="squad-form">
      <label>{tr("任务标题","Task title")}<input className="pixel-input" value={title} onChange={e=>setTitle(e.target.value)}/></label><label>{tr("任务目标","Objective")}<textarea className="pixel-input" value={objective} onChange={e=>setObjective(e.target.value)}/></label><label>{tr("验收标准（每行一项）","Acceptance criteria (one per line)")}<textarea className="pixel-input" value={criteria} onChange={e=>setCriteria(e.target.value)}/></label>
      <ActorPicker label={tr("负责人","Owner")} actors={actors} value={owner} onChange={id=>{if(id)setOwner(id);}}/>
      <label>{tr("优先级","Priority")}<select className="pixel-input" value={priority} onChange={e=>setPriority(e.target.value as WorkItem['priority'])}>{['low','normal','high'].map(p=><option key={p}>{p}</option>)}</select></label>
      <label>{tr("关联房间","Related room")}<select className="pixel-input" value={roomId} onChange={e=>setRoomId(e.target.value)}><option value="">{tr("仅关联项目","Project only")}</option>{sessions.filter(s=>s.kind==="cowork"&&s.workspaceId===workspaceId&&!s.archived).map(s=><option key={s.id} value={s.id}>{s.title}</option>)}</select></label>
      <p>{tr("先保存目标与负责人，不启动模型。保存后可预览并开始执行。","Save the goal and owner without model calls. Preview and start after saving.")}</p>{error&&<ErrorNotice message={error}/>}
      <button className="pixel-button pixel-button--primary px-3 py-2" disabled={busy||!title.trim()||!objective.trim()} onClick={()=>void act(async()=>{const saved=await request<ItemDetail>("",{workspaceId,roomId:roomId||null,title,objective,acceptanceCriteria:criteria.split("\n").map(c=>c.trim()).filter(Boolean),priority,...ownerFields(owner)});setSelected(saved.id);setDetail(saved);setCreating(false);setTitle("");setObjective("");setCriteria("");})}>{tr("保存任务，不启动","Save task without starting")}</button>
    </div></DetailPanel>}
    {assigning&&item&&<DetailPanel drawer open title={tr("分配与启动确认","Assignment and start")} closeLabel={tr("取消分配","Cancel assignment")} onClose={()=>{if(!busy)setAssigning(false);}}><div className="squad-form">
      <p>{item.title}</p><ActorPicker label={tr("负责人","Owner")} actors={actors} value={owner} onChange={id=>{if(id){setOwner(id);setPreview(null);}}}/>
      <p>{tr("实际执行者","Execution target")}: {targetId?agents.find(a=>a.id===targetId)?.nickname??targetId:tr("无模型调用","No model invocation")}{squad?` · ${tr("仅 Leader 首先规划","Only Leader plans initially")}`:""}</p>
      <p>{tr("工具调用能力","Tool calling")}: {targetId?(agents.find(a=>a.id===targetId)?.modelCapabilities?.toolCalling?tr("支持，仍需权限与审批","Supported; permissions and approval still apply"):tr("未知或不支持","Unknown or unsupported")):tr("不适用","Not applicable")}</p>
      <p>{tr("工作区","Workspace")}: {workspaces.find(w=>w.id===workspaceId)?.displayPath??workspaceId}</p>
      <p>{tr("执行沿用工作区权限、工具审批和费用预算；不会修改来源房间。","Execution retains workspace permissions, tool approval and cost budgets; source room settings remain intact.")}</p>
      {busyRun&&<label>{tr("对当前执行的处理","Current execution")}<select className="pixel-input" value={disposition} onChange={e=>{setDisposition(e.target.value);setPreview(null);}}><option value="keep_current">{tr("保留当前执行","Keep current execution")}</option><option value="stop_then_handoff">{tr("停止当前执行后移交","Stop current execution, then hand off")}</option></select></label>}
      {owner!=="user"&&<><label>{tr("本次执行预算（USD，可不填）","Run budget (USD, optional)")}<input className="pixel-input" inputMode="decimal" value={budget} onChange={e=>{setBudget(e.target.value);setPreview(null);}}/></label>{budget&&<label>{tr("预算模式","Budget mode")}<select className="pixel-input" value={budgetMode} onChange={e=>{setBudgetMode(e.target.value);setPreview(null);}}><option value="soft_limit">{tr("接近上限暂停","Pause near limit")}</option><option value="strict_admission">{tr("严格准入","Strict admission")}</option><option value="tracking_only">{tr("只记录","Track only")}</option></select></label>}
      <button className="pixel-button px-3 py-2" disabled={busy||Boolean(busyRun)} onClick={()=>void act(async()=>{setPreview(await request<Preview>(`/${item.id}/preview`,{expectedRevision:item.revision,...ownerFields(owner),...(budget?{budget:{mode:budgetMode,limitAtomic:decimalToAtomic(budget)}}:{})}));requestId.current=crypto.randomUUID();})}>{tr("预览执行与报价","Preview execution and quote")}</button>{busyRun&&<p>{tr("先处理当前执行，完成后再预览下一次。","Resolve the current execution before previewing another.")}</p>}</>}
      {preview&&<div className="work-review-note"><p>{tr("工具审批","Tool approval")}: {preview.approvalPolicy.mode}</p><p>{tr("执行工作区","Execution workspace")}: {preview.workspacePath}</p><p>{tr("预计费用","Estimated cost")}: {preview.quote.lowAtomic===null||preview.quote.highAtomic===null?tr("未知，不能视为免费","Unknown; not free"):`${atomicToDecimal(preview.quote.lowAtomic)} – ${atomicToDecimal(preview.quote.highAtomic)} ${preview.quote.currency}`}</p><p>{tr("估算包含不确定性；预算按实际调用执行。","Estimates include uncertainty; budgets govern actual calls.")}</p>{preview.reason&&<p>{preview.reason}</p>}</div>}
      {error&&<ErrorNotice message={error}/>}
      <button className="pixel-button px-3 py-2" disabled={busy} onClick={()=>void act(async()=>{setDetail(await request<ItemDetail>(`/${item.id}/assign`,{expectedRevision:item.revision,...ownerFields(owner),runDisposition:disposition},"PUT"));setAssigning(false);})}>{tr("只分配，稍后开始","Assign only, start later")}</button>
      {owner!=="user"&&<><button className="pixel-button pixel-button--primary px-3 py-2" disabled={busy||!preview?.canStart||preview.expectedRevision!==item.revision} onClick={()=>void act(async()=>{await request(`/${item.id}/start`,{previewId:preview!.id,expectedRevision:item.revision,clientRequestId:requestId.current});setDetail(await request<ItemDetail>(`/${item.id}`));await loadSessions();setAssigning(false);})}>{tr("分配并开始","Assign and start")}</button>{!preview&&<p>{tr("先预览执行目标、审批与费用，才能开始。","Preview the execution target, approvals and cost before starting.")}</p>}</>}
    </div></DetailPanel>}
  </div>;
}
