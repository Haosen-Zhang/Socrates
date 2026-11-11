import { useState } from "react";
import type { WorkItem } from "@socrates/core";
import { DetailPanel, ErrorNotice, notify } from "../foundation";
import { useStorePick } from "../selectors";
import { requireOk, sidecarFetch } from "../transport";
export default function CreateWorkItemButton({messageId,content}:{messageId:string;content:string}) {
  const {handshake,currentSessionId,sessions,lang}=useStorePick("handshake","currentSessionId","sessions","lang");
  const room=sessions.find(s=>s.id===currentSessionId),en=lang==="en";
  const [open,setOpen]=useState(false),[title,setTitle]=useState(content.slice(0,100)),[busy,setBusy]=useState(false),[error,setError]=useState("");
  if(room?.kind!=="cowork"||!room.workspaceId||!handshake)return null;
  return <><button type="button" className="hover:underline" onClick={()=>setOpen(true)}>{en?"Create work item":"创建工作事项"}</button>
    <DetailPanel drawer open={open} onClose={()=>{if(!busy)setOpen(false);}} title={en?"Create from message":"从消息创建工作事项"} closeLabel={en?"Cancel":"取消"}><div className="squad-form">
      <label>{en?"Task title":"任务标题"}<input className="pixel-input" value={title} onChange={e=>setTitle(e.target.value)}/></label><p className="work-task-objective">{content}</p><p>{en?"Save to Backlog, owned by you. This does not start an agent.":"保存到待办，由本机用户负责，不启动模型。"}</p>{error&&<ErrorNotice message={error}/>}
      <button disabled={busy||!title.trim()} className="pixel-button px-3 py-2" onClick={()=>{setBusy(true);void sidecarFetch(handshake,"/work-items",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({workspaceId:room.workspaceId,roomId:room.id,sourceMessageId:messageId,title,objective:content,acceptanceCriteria:[],priority:"normal",ownerKind:"user",ownerId:null})}).then(requireOk<WorkItem>).then(()=>{setOpen(false);notify(en?"Saved in Tasks · Backlog":"已保存到任务 · 待办");}).catch(e=>setError(String(e))).finally(()=>setBusy(false));}}>{en?"Save to Backlog":"保存到待办"}</button>
    </div></DetailPanel></>;
}
