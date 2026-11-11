import { memo, useEffect, useMemo, useState } from "react";
import type { WorkActivityRecord, WorkActivityDetail } from "@socrates/core";
import { ActivityTimeline, DetailPanel, EmptyState, ErrorNotice, LoadingState, ObjectPage, StatusBadge, Tooltip } from "../foundation";
import { useT } from "../store";
import { WORK_PROJECT_KEYS, useStorePick } from "../selectors";
import { requireOk, sidecarFetch, type Handshake } from "../transport";
import { activityStatusKey, projectRoomIds, visibleActivities, type ActivityFilter, type WorkContext } from "./workNavigation";
import RoomTimeline from "../RoomTimeline";
import FlightRecorderPanel from "../flight-recorder/FlightRecorderPanel";
import { ProjectMemoryPanel } from "../project-memory/ProjectMemoryPanel";
import ArenaPanel from "../arena/ArenaPanel";
import SquadsPanel from "../squads/SquadsPanel";
import WorkItemsPanel from "../work-items/WorkItemsPanel";
import "./work.css";

const statusTone = (status: string) => ["failed", "outcome_unknown"].includes(status) ? "danger" as const
  : ["paused", "interrupted", "awaiting_plan_approval", "awaiting_approval", "awaiting_tool_approval"].includes(status) ? "warning" as const
  : status === "completed" ? "success" as const : "neutral" as const;
function statusLabel(status: string, t: (key: string) => string) {
  return t(activityStatusKey(status));
}
function ActivityDetail({handshake, selected, open, revision, onClose, onOpenRoom}: {handshake: Handshake; selected: WorkActivityRecord; open:boolean; revision:number; onClose:()=>void; onOpenRoom:()=>void}) {
  const t = useT();
  const [width,setWidth]=useState(390);
  const [showRecorder,setShowRecorder]=useState(false);
  const [detail,setDetail]=useState<WorkActivityDetail|null>(null), [error,setError]=useState("");
  useEffect(()=>{
    if(!open)return;
    const controller=new AbortController();
    setError("");
    void sidecarFetch(handshake,`/room-commands/rooms/${encodeURIComponent(selected.roomId)}/activity/${encodeURIComponent(selected.id)}`,{signal:controller.signal})
      .then(requireOk<WorkActivityDetail>).then(data=>{if(!controller.signal.aborted)setDetail(data);})
      .catch(cause=>{if(!controller.signal.aborted)setError(String(cause));});
    return ()=>controller.abort();
  },[handshake,selected.id,selected.roomId,selected.updatedAt,selected.status,revision,open]);
  const activity=detail?.activity ?? selected;
  return <DetailPanel open={open} title={t("work_detail")} description={t("work_read_only")} closeLabel={t("close")} onClose={onClose}
    resize={{size:width,min:300,max:560,label:t("resize_workspace_dock"),onResize:setWidth,onCommit:setWidth}}>
    <RoomTimeline roomId={`activity-${selected.id}`} className="h-full space-y-3 overflow-y-auto" followInitially={false}>
    <p className="work-task-objective">{activity.prompt}</p>
    <StatusBadge tone={statusTone(activity.status)} source={activity.status}>{statusLabel(activity.status,t)}</StatusBadge>
    <dl className="work-facts">
      <dt>{t("work_created")}</dt><dd>{new Date(activity.createdAt).toLocaleString()}</dd>
      <dt>{t("work_updated")}</dt><dd>{new Date(activity.updatedAt).toLocaleString()}</dd>
      {activity.runId && <><dt>{t("work_run")}</dt><dd>{activity.runId}</dd></>}
      {activity.taskId && <><dt>{t("work_team_task")}</dt><dd>{activity.taskId}</dd></>}
      {activity.attemptNo !== undefined && <><dt>{t("work_attempt")}</dt><dd>{activity.attemptNo}</dd></>}
    </dl>
    {activity.error && <ErrorNotice message={t(activity.error)}/>}
    {activity.status === "completed" && <p className="work-review-note">{t("work_review_separate")}</p>}
    <button className="pixel-button pixel-button--primary px-3 py-2" onClick={onOpenRoom}>{t("work_open_room")}</button>
    <button type="button" className="pixel-button px-3 py-2" aria-expanded={showRecorder} onClick={()=>setShowRecorder(value=>!value)}>{t("work_recorder")}</button>
    {showRecorder && <FlightRecorderPanel key={selected.id} roomId={selected.roomId} rootTaskId={selected.commandId ?? selected.taskId ?? selected.runId} handshake={handshake} onOpenRelated={onOpenRoom}/>}
    <h3 className="mt-6 mb-3 font-bold">{t("work_events")}</h3>
    {error ? <ErrorNotice message={t("work_activity_failed")}/> : !detail ? <LoadingState label={t("loading")}/> : detail.events.length ?
      <ActivityTimeline items={detail.events.map(event=>({id:event.id,title:t(event.type),description:[event.agentId,event.occurredAt ? undefined : t("work_time_unknown")].filter(Boolean).join(" · "),timestamp:event.occurredAt ?? undefined}))}/> : <EmptyState title={t("work_no_events")}/>}
    {detail?.truncated && <p>{t("work_events_truncated")}</p>}
    </RoomTimeline>
  </DetailPanel>;
}

/** Bounded read projection only: no model dispatch and no second task authority. */
export default memo(function WorkProjectHub({workspaceId,context,onOpenRoom,onChangeContext}: {workspaceId:string|null;context:WorkContext;onOpenRoom:()=>void;onChangeContext:(context:WorkContext)=>void}) {
  const {sessions,handshake,selectAgentSession}=useStorePick(...WORK_PROJECT_KEYS);
  const t=useT();
  const [showHistory,setShowHistory]=useState(false),[assignmentSquad,setAssignmentSquad]=useState<string|null>(null);
  const rooms=useMemo(()=>projectRoomIds(sessions,workspaceId),[sessions,workspaceId]);
  const roomKey=JSON.stringify(rooms);
  const [rows,setRows]=useState<WorkActivityRecord[]>([]),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const [refresh,setRefresh]=useState(0),[revision,setRevision]=useState(0),[query,setQuery]=useState(""),[filter,setFilter]=useState<ActivityFilter>("all"),[selectedId,setSelectedId]=useState<string|null>(null);
  useEffect(()=>{
    if(context !== "tasks" || !showHistory || !handshake || !workspaceId)return;
    const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      setLoading(true);
      try {
        const results=await Promise.allSettled((JSON.parse(roomKey) as string[]).map(id=>sidecarFetch(handshake,`/room-commands/rooms/${encodeURIComponent(id)}/activity`,{signal:controller.signal}).then(requireOk<WorkActivityRecord[]>)));
        if(!controller.signal.aborted){
          setRows(results.flatMap(result=>result.status === "fulfilled" ? result.value : []).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)));
          setRevision(value=>value+1);
          setError(results.flatMap(result=>result.status === "rejected" ? [String(result.reason)] : []).join("; "));
        }
      } catch(cause){if(!controller.signal.aborted)setError(String(cause));}
      finally {if(!controller.signal.aborted){setLoading(false);timer=setTimeout(()=>void load(),4000);}}
    };
    void load();return()=>{controller.abort();clearTimeout(timer);};
  },[context,showHistory,handshake,roomKey,workspaceId,refresh]);
  const [projectRoom,setProjectRoom]=useState("");
  const availableRooms=sessions.filter(room=>room.kind==="cowork" && room.workspaceId===workspaceId && !room.archived);
  const featureRoom=availableRooms.find(room=>room.id===projectRoom) ?? availableRooms[0];
  const selected=rows.find(row=>row.id === selectedId);
  const visible=visibleActivities(rows,query,filter);
  if(!workspaceId)return context === "rooms" ? null : <EmptyState title={t("work_choose_project")} description={t("work_choose_project_hint")}/>;
  return <>
    {(context === "memory" || context === "arena") && <div className="work-project-hub"><ObjectPage title={t(`work_${context}`)}>
      <label>{t("work_room")} <select className="pixel-input p-2" value={featureRoom?.id ?? ""} onChange={event=>setProjectRoom(event.target.value)}>{availableRooms.map(room=><option key={room.id} value={room.id}>{room.title}</option>)}</select></label>
      {!featureRoom ? <EmptyState title={t("work_choose_project")} description={t("work_choose_project_hint")}/> : context === "memory" ? <ProjectMemoryPanel key={featureRoom.id} roomId={featureRoom.id}/> : handshake && <ArenaPanel key={featureRoom.id} roomId={featureRoom.id} handshake={handshake}/>}
    </ObjectPage></div>}
    {context === "squads" && handshake && <SquadsPanel workspaceId={workspaceId} handshake={handshake} onOpenRoom={onOpenRoom} onAssign={id=>{setAssignmentSquad(id);setShowHistory(false);onChangeContext("tasks");}}/> }
    {context === "tasks" && !showHistory && handshake && <WorkItemsPanel workspaceId={workspaceId} handshake={handshake} onOpenRoom={onOpenRoom} onHistory={()=>setShowHistory(true)} initialSquad={assignmentSquad} onConsumeSquad={()=>setAssignmentSquad(null)}/>}
    <div className="work-project-hub" data-work-task-list aria-busy={loading} style={context !== "tasks" || !showHistory ? {display:"none"} : undefined} inert={context !== "tasks" || !showHistory ? true : undefined}>
    <button className="pixel-button px-3 py-2" onClick={()=>setShowHistory(false)}>{t("work_tasks")}</button>
    <ObjectPage title={t("work_recent_tasks")} description={t("work_recent_hint")} actions={<Tooltip label={t("work_refresh")}><button type="button" className="pixel-button px-3 py-2" onClick={()=>setRefresh(value=>value+1)}>{t("work_refresh")}</button></Tooltip>}>
      <div className="work-task-filters"><input className="pixel-input px-3 py-2" type="search" value={query} onChange={event=>setQuery(event.target.value)} placeholder={t("work_search")} aria-label={t("work_search")}/>
        <select className="pixel-input px-3 py-2" aria-label={t("work_filter")} value={filter} onChange={event=>setFilter(event.target.value as ActivityFilter)}>
          <option value="all">{t("work_all")}</option><option value="attention">{t("work_attention")}</option><option value="completed">{t("work_completed")}</option>
        </select>
      </div>
      {error && <ErrorNotice message={t("work_activity_failed")} retryLabel={t("work_refresh")} onRetry={()=>setRefresh(value=>value+1)}/>}
      {loading && rows.length === 0 ? <LoadingState label={t("loading")}/> : visible.length === 0 ? !error && <EmptyState title={t(rows.length ? "work_no_matching_tasks" : "work_no_tasks")} description={rows.length ? undefined : t("work_no_tasks_hint")}/> :
        <ul className="work-task-list" aria-label={t("work_recent_tasks")}>{visible.map(row=><li key={row.id}><button type="button" className="work-task-row" aria-pressed={selectedId === row.id} onClick={()=>setSelectedId(row.id)}>
          <span className="work-task-row__main"><strong>{row.prompt}</strong><small>{sessions.find(room=>room.id === row.roomId)?.title ?? row.roomId} · {new Date(row.createdAt).toLocaleString()}</small></span>
          <StatusBadge tone={statusTone(row.status)} source={row.status}>{statusLabel(row.status,t)}</StatusBadge>
        </button></li>)}</ul>}
    </ObjectPage>
    {selected && handshake && <ActivityDetail key={selected.id} open={context === "tasks" && showHistory} revision={revision} handshake={handshake} selected={selected} onClose={()=>setSelectedId(null)} onOpenRoom={()=>{
      void selectAgentSession(selected.roomId).then(onOpenRoom).catch(cause=>setError(String(cause)));
    }}/>}
  </div></>;
});
