import {useEffect,useRef,useState} from 'react';
import type {WorkInteraction} from '@socrates/core';
import {requireOk,sidecarFetch,type Handshake} from '../transport';
import {useStore} from '../store';
import {DetailPanel} from '../foundation';
import RunTimeline from '../agent-lifecycle/RunTimeline';

export default function InteractionHistory({path,handshake,en,roomId,onOpenRoom,revision=0}:{path:string;handshake:Handshake;en:boolean;roomId?:string;onOpenRoom?:(id:string)=>void;revision?:number}) {
 const [rows,setRows]=useState<WorkInteraction[]>([]),[error,setError]=useState(''),[limit,setLimit]=useState(20),[selected,setSelected]=useState<WorkInteraction|null>(null);
 const commands=useRef(new Set<string>());
 useEffect(()=>{
  const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const value=await sidecarFetch(handshake,path,{signal:c.signal}).then(requireOk<WorkInteraction[]>);if(c.signal.aborted)return;setRows(value);setError('');
   const newCommands=value.filter(row=>row.commandId&&!commands.current.has(row.commandId));
   value.forEach(row=>{if(row.commandId)commands.current.add(row.commandId);});
   if(roomId&&newCommands.length&&useStore.getState().currentSessionId===roomId)void useStore.getState().selectAgentSession(roomId).catch(e=>{if(!c.signal.aborted)setError(String(e));});
  }catch(e){if(!c.signal.aborted)setError(String(e));}finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),1500);}};
  void load();return()=>{c.abort();clearTimeout(timer);};
 },[path,handshake,roomId,revision]);
 const tr=(zh:string,english:string)=>en?english:zh;
 return <details className="text-sm" data-interaction-history><summary>{tr('指示与备注','Instructions and notes')} · {rows.length}</summary>
  {error&&<p role="alert">{error}</p>}
  <ol className="max-h-64 overflow-y-auto space-y-3">{rows.slice(-limit).map(row=><li key={row.id} data-interaction-id={row.id} data-interaction-status={row.status}><p className="whitespace-pre-wrap break-words">{row.input.content}</p><small>{row.input.action} · {row.status} · {new Date(row.createdAt).toLocaleString()}</small>{row.reason&&<p>{row.reason}</p>}{row.commandId&&row.roomId&&<button type="button" className="pixel-button px-2 py-1" onClick={()=>setSelected(row)}>{tr('查看此轮运行','View this run')}</button>}</li>)}</ol>
  {rows.length>limit&&<button type="button" className="pixel-button px-2 py-1" onClick={()=>setLimit(n=>n+20)}>{tr('更早记录','Earlier records')}</button>}
  {selected?.roomId&&selected.commandId&&<DetailPanel open drawer title={tr('指示运行详情','Instruction run detail')} closeLabel={tr('关闭指示运行详情','Close instruction run detail')} onClose={()=>setSelected(null)}><RunTimeline key={selected.id} target={{roomId:selected.roomId,rootTaskId:selected.commandId}} handshake={handshake} en={en} onOpenRoom={id=>{if(onOpenRoom)onOpenRoom(id);else void useStore.getState().selectAgentSession(id);}}/></DetailPanel>}
 </details>;
}
