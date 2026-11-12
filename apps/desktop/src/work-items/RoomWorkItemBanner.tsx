import { useEffect, useState } from "react";
import type { WorkItemSummary } from "@socrates/core";
import { useStorePick } from "../selectors";
import { requireOk, sidecarFetch } from "../transport";
export default function RoomWorkItemBanner({roomId,workspaceId,onOpen}:{roomId:string;workspaceId:string;onOpen:()=>void}) {
  const {handshake,lang,agents}=useStorePick("handshake","lang","agents");
  const [items,setItems]=useState<WorkItemSummary[]>([]),[error,setError]=useState("");
  useEffect(()=>{if(!handshake)return;const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{try{const rows=await sidecarFetch(handshake,`/work-items?workspaceId=${encodeURIComponent(workspaceId)}`,{signal:c.signal}).then(requireOk<WorkItemSummary[]>);if(!c.signal.aborted){setItems(rows.filter(i=>i.roomId===roomId||i.runs.some(r=>r.executionRoomId===roomId)));setError("");}}catch(e){if(!c.signal.aborted)setError(String(e));}finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),2000);}};void load();return()=>{c.abort();clearTimeout(timer);};
  },[handshake,workspaceId,roomId]);
  if(!items.length&&!error)return null;
  return <div className="work-item-room-banner" data-room-work-items>{error?<span role="status">{lang==="en"?"Task status unavailable; open Tasks to retry.":"任务状态暂不可用，可前往任务中心重试。"}</span>:items.map(i=><button className="pixel-button px-2 py-1" key={i.id} onClick={()=>{sessionStorage.setItem(`socrates.workitem.${workspaceId}`,i.id);onOpen();}}>{i.title} · {i.workflow} · {i.ownerKind==="user"?(lang==="en"?"Me":"我"):agents.find(a=>a.id===i.ownerId)?.nickname??i.ownerId}</button>)}</div>;
}
