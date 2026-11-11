import {useEffect,useRef,useState} from 'react';
import type {InboxItem,InboxNotification} from '@socrates/core';
import {DetailPanel,EmptyState,ErrorNotice,ObjectPage,StatusBadge,notify} from '../foundation';
import {requireOk,sidecarFetch,type Handshake} from '../transport';
import {useStorePick} from '../selectors';
import RunTimeline from '../agent-lifecycle/RunTimeline';

type Inbox={items:InboxItem[];notifications:InboxNotification[]};
const labels:Record<string,[string,string]>={approval:['等待审批','Approval'],verification:['等待验证','Verification'],unknown_side_effect:['副作用结果未知','Unknown side effect'],budget:['预算暂停','Budget paused'],blocked:['需要处理','Blocked'],human_review:['人工审核','Human review']};
export default function InboxPanel({workspaceId,handshake,visible,onOpenRoom,onOpenItem}:{workspaceId:string;handshake:Handshake;visible:boolean;onOpenRoom:(id:string)=>Promise<void>;onOpenItem:(id:string)=>void}){
 const {lang}=useStorePick('lang'),en=lang==='en',tr=(zh:string,english:string)=>en?english:zh;
 const [items,setItems]=useState<InboxItem[]>([]),[selectedId,setSelectedId]=useState(''),[error,setError]=useState(''),[decision,setDecision]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
 const shown=useRef(new Set<string>());
 useEffect(()=>{
  const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const data=await sidecarFetch(handshake,`/inbox?${new URLSearchParams({workspaceId})}`,{signal:c.signal}).then(requireOk<Inbox>);if(c.signal.aborted)return;setItems(data.items);setError('');
   for(const n of data.notifications){if(shown.current.has(n.id))continue;shown.current.add(n.id);const item=data.items.find(i=>i.id===n.itemId);if(!item)continue;notify(`${tr('需要处理','Needs attention')}: ${item.title}`);await sidecarFetch(handshake,`/inbox/${encodeURIComponent(item.id)}/read`,{method:'POST',body:JSON.stringify({revision:item.revision}),signal:c.signal}).then(requireOk);}
  }catch(e){if(!c.signal.aborted)setError(String(e));}finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),2000);}};
  void load();return()=>{c.abort();clearTimeout(timer);};
 },[workspaceId,handshake,revision,en]);
 const selected=items.find(i=>i.id===selectedId);
 const resolve=async()=>{
  if(!selected||!decision.trim())return;setBusy(true);setError('');
  try{const link=selected.link;const base=link.workItemId?`/work-items/${encodeURIComponent(link.workItemId)}`:`/room-commands/rooms/${encodeURIComponent(link.roomId!)}`;
   const path=link.evaluationId?`${base}/evaluations/${encodeURIComponent(link.evaluationId)}/resolve`:`${base}/interactions/${encodeURIComponent(link.interactionId!)}/resolve`;
   await sidecarFetch(handshake,path,{method:'POST',body:JSON.stringify({decision:decision.trim()})}).then(requireOk);setDecision('');setSelectedId('');setRevision(n=>n+1);
  }catch(e){setError(String(e));}finally{setBusy(false);}
 };
 if(!visible)return null;
 return <div className="work-project-hub" data-inbox><ObjectPage title={tr('待处理','Inbox')} description={tr('审批、验证、预算与阻碍来自持久运行事实；解决后自动移除。','Approvals, verification, budget pauses and blockers come from durable facts and disappear when resolved.')}>
  {error&&<ErrorNotice message={error}/>} {!items.length&&!error&&<EmptyState title={tr('目前没有待处理事项','Nothing needs attention')}/>}
  <ul className="work-task-list">{items.map(item=><li key={item.id}><button className="work-task-row" data-inbox-id={item.id} onClick={()=>{setSelectedId(item.id);setDecision('');}}><span className="work-task-row__main"><strong>{item.title}</strong><small>{item.reason}</small></span><StatusBadge tone="warning">{labels[item.kind]?.[en?1:0]??item.kind}</StatusBadge></button></li>)}</ul>
 </ObjectPage>
 {selected&&<DetailPanel drawer open title={selected.title} closeLabel={tr('关闭待处理详情','Close inbox detail')} onClose={()=>setSelectedId('')}><div className="space-y-3" data-inbox-detail>
  <p>{selected.reason}</p><dl className="work-facts">{Object.entries(selected.link).filter(([,value])=>value).map(([key,value])=><div key={key}><dt>{key}</dt><dd className="break-all">{value}</dd></div>)}</dl>
  {selected.link.workItemId&&<button className="pixel-button px-3 py-2" onClick={()=>{onOpenItem(selected.link.workItemId!);setSelectedId('');}}>{tr('打开对应工作事项','Open linked work item')}</button>}
  {selected.link.roomId&&<button className="pixel-button px-3 py-2" onClick={()=>{void onOpenRoom(selected.link.roomId!).then(()=>setSelectedId('')).catch(e=>setError(String(e)));}}>{tr('打开对应房间处理','Open linked room to resolve')}</button>}
  {(selected.link.evaluationId||selected.link.interactionId&&selected.kind==='human_review')&&<><label>{tr('处理结论','Resolution')}<textarea className="pixel-input w-full" value={decision} onChange={e=>setDecision(e.target.value)}/></label><button className="pixel-button px-3 py-2" disabled={busy||!decision.trim()} onClick={()=>void resolve()}>{tr('记录结论并解决此提醒','Record resolution and resolve')}</button></>}
  {selected.link.roomId&&(selected.link.commandId||selected.link.taskId||selected.link.runId)&&<RunTimeline target={{roomId:selected.link.roomId,rootTaskId:selected.link.commandId??selected.link.taskId??selected.link.runId!,runId:selected.link.runId,workPackageId:selected.link.packageId,workspaceId:selected.link.workspaceId}} handshake={handshake} en={en} onOpenRoom={id=>void onOpenRoom(id)}/>}
 </div></DetailPanel>}
 </div>;
}
