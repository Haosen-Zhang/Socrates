import {timelineGroups} from "./timelineGroups";
import {useStorePick} from "../selectors";
import {useEffect,useRef,useState} from 'react';
import type {FlightArtifactDiff,FlightPage,FlightRecord,VerificationView,WorkspaceGitDiff,WorkspaceGitStatus} from '@socrates/core';
import {sidecarFetch,requireOk,streamSseEvents,type Handshake} from '../transport';
import {ErrorNotice} from '../foundation';
import VerificationResultView from '../verification/VerificationResultView';

export interface TimelineTarget {roomId:string;rootTaskId:string;runId?:string|null;workPackageId?:string|null;workspaceId?:string|null;}
export default function RunTimeline({target,handshake,en,onOpenRoom}:{target:TimelineTarget;handshake:Handshake;en:boolean;onOpenRoom:(roomId:string)=>void}){
 const {agents}=useStorePick('agents');
 const [page,setPage]=useState<FlightPage|null>(null),[after,setAfter]=useState(0),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const [selected,setSelected]=useState<FlightRecord|null>(null),[verification,setVerification]=useState<VerificationView|null>(null),[diff,setDiff]=useState<WorkspaceGitDiff|null>(null);
 const evidenceRequest=useRef<AbortController|null>(null),diffRequest=useRef<AbortController|null>(null);
 useEffect(()=>{if(!verification)return;const timer=setInterval(()=>void loadEvidence(),4000);return()=>clearInterval(timer);},[verification!==null,handshake,target.roomId,target.rootTaskId,target.workPackageId]);
 const [artifactDiff,setArtifactDiff]=useState<FlightArtifactDiff|null>(null);
 useEffect(()=>setArtifactDiff(null),[selected?.id]);
 const [changes,setChanges]=useState<WorkspaceGitStatus|null>(null);
 useEffect(()=>()=>{evidenceRequest.current?.abort();diffRequest.current?.abort();},[]);
 const tr=(zh:string,english:string)=>en?english:zh;
 useEffect(()=>{setAfter(0);setSelected(null);setPage(null);setVerification(null);setDiff(null);setError('');},[target.roomId,target.rootTaskId]);
 useEffect(()=>{
  const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const q=new URLSearchParams({rootTaskId:target.rootTaskId,after:String(after),limit:'50'});const value=await sidecarFetch(handshake,`/flight-recorder/rooms/${encodeURIComponent(target.roomId)}?${q}`,{signal:c.signal}).then(requireOk<FlightPage>);if(!c.signal.aborted){setPage(value);if(value.records.length===0){setArtifactDiff(null);setVerification(null);setDiff(null);setChanges(null);}setSelected(old=>old?value.records.find(r=>r.id===old.id)??null:null);setError('');}}catch(e){if(!c.signal.aborted){setPage(null);setSelected(null);setError(String(e));}}finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),4000);}};
  void load();return()=>{c.abort();clearTimeout(timer);};
 },[handshake,target.roomId,target.rootTaskId,after,revision]);
 useEffect(()=>{
  if(!target.runId)return;
  const c=new AbortController();let cursor=0,timer:ReturnType<typeof setTimeout>|undefined;
  const observe=async()=>{while(!c.signal.aborted){try{
   const response=await sidecarFetch(handshake,`/flight-recorder/rooms/${encodeURIComponent(target.roomId)}/runs/${encodeURIComponent(target.runId!)}/events?afterSeq=${cursor}`,{signal:c.signal});
   if(!response.ok)return;
   for await(const event of streamSseEvents(response)){if(c.signal.aborted)return;if(event.runId===target.runId&&typeof event.seq==='number'&&event.seq>cursor){cursor=event.seq;if(!timer)timer=setTimeout(()=>{timer=undefined;if(!c.signal.aborted)setRevision(n=>n+1);},350);if(event.terminal===true)return;}}
  }catch{if(c.signal.aborted)return;}
  await new Promise<void>(resolve=>{const finish=()=>{clearTimeout(id);c.signal.removeEventListener('abort',finish);resolve();};const id=setTimeout(finish,1500);c.signal.addEventListener('abort',finish,{once:true});if(c.signal.aborted)finish();});
 }};void observe();return()=>{c.abort();if(timer)clearTimeout(timer);};
 },[handshake,target.roomId,target.runId]);
 const loadArtifactDiff=async(toolCallId:string)=>{diffRequest.current?.abort();const c=new AbortController();diffRequest.current=c;try{const value=await sidecarFetch(handshake,`/flight-recorder/rooms/${encodeURIComponent(target.roomId)}/tools/${encodeURIComponent(toolCallId)}/diff`,{signal:c.signal}).then(requireOk<FlightArtifactDiff>);if(!c.signal.aborted)setArtifactDiff(value);}catch(e){if(!c.signal.aborted){setArtifactDiff(null);setError(String(e));}}};
 const loadEvidence=async()=>{evidenceRequest.current?.abort();const c=new AbortController();evidenceRequest.current=c;try{const q=new URLSearchParams({roomId:target.roomId,rootTaskId:target.rootTaskId,...(target.workPackageId?{workPackageId:target.workPackageId}:{})});const value=await sidecarFetch(handshake,`/verification/view?${q}`,{signal:c.signal}).then(requireOk<VerificationView>);if(!c.signal.aborted){setVerification(value);}}catch(e){if(!c.signal.aborted){setVerification(null);setError(String(e));}}};
 const loadChanges=async()=>{if(!target.workspaceId)return;diffRequest.current?.abort();const c=new AbortController();diffRequest.current=c;try{const value=await sidecarFetch(handshake,`/content/workspaces/${encodeURIComponent(target.workspaceId)}/git/status`,{signal:c.signal}).then(requireOk<WorkspaceGitStatus>);if(!c.signal.aborted){setChanges(value);setDiff(null);}}catch(e){if(!c.signal.aborted)setError(String(e));}};
 const loadDiff=async(path:string)=>{if(!target.workspaceId)return;diffRequest.current?.abort();const c=new AbortController();diffRequest.current=c;try{const value=await sidecarFetch(handshake,`/content/workspaces/${encodeURIComponent(target.workspaceId)}/git/diff?${new URLSearchParams({path})}`,{signal:c.signal}).then(requireOk<WorkspaceGitDiff>);if(!c.signal.aborted)setDiff(value);}catch(e){if(!c.signal.aborted){setDiff(null);setError(String(e));}}};
 return <section className="space-y-3 min-w-0" data-run-timeline>
  <h3 className="font-bold">{tr('运行时间线','Run timeline')}</h3><p className="break-all text-xs">{target.rootTaskId}</p>
  <div className="flex flex-wrap gap-2"><button className="pixel-button px-2 py-1" onClick={()=>onOpenRoom(target.roomId)}>{tr('打开关联房间','Open related room')}</button><button className="pixel-button px-2 py-1" onClick={()=>void loadEvidence()}>{tr('查看当前测试证据','View current test evidence')}</button>{target.workspaceId&&<button className="pixel-button px-2 py-1" onClick={()=>void loadChanges()}>{tr('查看当前工作区变更','View current workspace changes')}</button>}</div>
  {error&&<ErrorNotice message={error}/>}<p className="text-xs">{tr('事件按持久序号分页。状态快照与不可变事件分别显示；工具仅展示参数类型、长度和 hash。','Paged by durable sequence. State snapshots and immutable events are distinct; tool arguments show types, lengths and hashes only.')}</p>
  {timelineGroups(page?.records??[]).map(group=><section key={group.id} className="space-y-2 border-t pt-2" data-timeline-group={group.id}>
   <h4 className="font-bold break-all">{group.id}{group.attemptNo&&` · attempt ${group.attemptNo}`}</h4>{group.workPackageId&&<p className="text-xs break-all">WorkPackage · {group.workPackageId}</p>}
   {group.snapshots.map(r=><button className="pixel-button block w-full px-2 py-1 text-left text-xs break-all" key={r.id} data-run-status-snapshot onClick={()=>setSelected(r)}>{tr('当前快照','Current snapshot')}: {r.type} · {r.agentId?agents.find(a=>a.id===r.agentId)?.nickname??r.agentId:'—'}</button>)}
   <ol className="space-y-2">{group.events.map(r=><li key={r.id}><button className="pixel-button w-full text-left px-2 py-2 break-all" onClick={()=>setSelected(r)} aria-pressed={selected?.id===r.id}>
    <strong>{r.type}</strong><small className="block">#{r.sequence} · {r.agentId?agents.find(a=>a.id===r.agentId)?.nickname??r.agentId:'—'} · {r.occurredAt?new Date(r.occurredAt).toLocaleString():'—'}{r.fields.attemptNo!=null&&` · ${r.source==='invocation'?'invocation ':''}attempt ${r.fields.attemptNo}`}{r.fields.providerAttemptNo!=null&&` · provider attempt ${r.fields.providerAttemptNo}`}</small>
    <small className="block">{r.fields.errorCode??r.fields.status??''} {r.fields.willRetry===true?tr('将重试','Will retry'):''}</small>
   </button></li>)}</ol>
  </section>)}
  {page?.records.length===0&&<p>{tr('此任务暂无可见记录。','No visible records for this task.')}</p>}
  <div className="flex gap-2"><button className="pixel-button px-2 py-1" disabled={after===0} onClick={()=>setAfter(0)}>{tr('第一页','First page')}</button><button className="pixel-button px-2 py-1" disabled={page?.next==null} onClick={()=>setAfter(page!.next!)}>{tr('下一页','Next page')}</button></div>
  {selected&&<details open><summary>{tr('安全诊断详情','Safe diagnostic detail')} · {selected.type}</summary><p className="break-all">{tr('父级','Parent')}: {selected.parentId??'—'}</p><pre className="whitespace-pre-wrap break-all text-xs">{JSON.stringify({source:selected.source,sourceSequence:selected.sourceSequence,...selected.fields},null,2)}</pre>{selected.type==='tool.write_file'&&typeof selected.fields.toolCallId==='string'&&<button className="pixel-button px-2 py-1" onClick={()=>void loadArtifactDiff(String(selected.fields.toolCallId))}>{tr('查看此次写入的历史 Diff','View recorded write diff')}</button>}</details>}
  {verification&&<><VerificationResultView view={verification}/>{target.workspaceId&&verification.plan?.artifactPaths.map(path=><button key={path} className="pixel-button px-2 py-1 break-all" onClick={()=>void loadDiff(path)}>{tr('查看当前产物 Diff','View current artifact diff')}: {path}</button>)}</>}
  {artifactDiff&&<details open><summary>{tr('此次写入的历史 Diff','Recorded write diff')} · {artifactDiff.relativePath}</summary><p className="break-all text-xs">{artifactDiff.oldSha256??'new file'} → {artifactDiff.newSha256}</p><pre className="whitespace-pre-wrap break-all text-xs">{artifactDiff.patch||tr('无差异','No diff')}</pre>{artifactDiff.truncated&&<p>{tr('原始 Diff 已截断；hash 指向完整产物','Recorded diff is truncated; hashes identify the complete artifact')}</p>}</details>}
  {changes&&<details open><summary>{tr('当前工作区变更（不代表全部由此 Run 产生）','Current workspace changes (not necessarily produced by this run)')}</summary>{changes.state==='not_git'?<p>{tr('工作区未启用 Git；没有可用的 Git Diff。','This workspace has no Git baseline for a diff.')}</p>:changes.files.map(file=><button key={file.relativePath} className="pixel-button block w-full px-2 py-1 break-all text-left" onClick={()=>void loadDiff(file.relativePath)}>{file.status} · {file.relativePath}</button>)}{changes.truncated&&<p>{tr('变更列表已截断','Change list truncated')}</p>}</details>}
  {diff&&<details open><summary>{tr('当前工作区 Diff（相对 Git 基线，可能包含后续编辑）','Current workspace diff (against Git baseline; may include later edits)')}</summary><pre className="whitespace-pre-wrap break-all text-xs">{diff.patch||tr('无差异','No diff')}</pre>{diff.truncated&&<p>{tr('内容已截断','Content truncated')}</p>}</details>}
  {!!page?.gaps.length&&<details><summary>{tr('记录范围','Record scope')}</summary>{page.gaps.map(g=><p className="text-xs" key={g}>{g}</p>)}</details>}
 </section>;
}
