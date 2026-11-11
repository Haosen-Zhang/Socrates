import {useEffect,useState} from 'react';
import {atomicToDecimal,type AgentLifecycleDetail,type AgentRunSummary} from '@socrates/core';
import {DetailPanel,ErrorNotice} from '../foundation';
import {sidecarFetch,requireOk,type Handshake} from '../transport';
import {useStorePick} from '../selectors';
import AgentPresence,{stateLabel} from './AgentPresence';
import RunTimeline,{type TimelineTarget} from './RunTimeline';

export default function AgentDetailPanel({agentId,handshake,onClose,onOpenRoom}:{agentId:string;handshake:Handshake;onClose:()=>void;onOpenRoom?:()=>void}){
 const {lang,agents,sessions,selectAgentSession}=useStorePick('lang','agents','sessions','selectAgentSession');
 const en=lang==='en',tr=(zh:string,english:string)=>en?english:zh;
 const [detail,setDetail]=useState<AgentLifecycleDetail|null>(null),[error,setError]=useState(''),[after,setAfter]=useState<string|null>(null),[target,setTarget]=useState<TimelineTarget|null>(null);
 useEffect(()=>{setDetail(null);setAfter(null);setTarget(null);},[agentId]);
 useEffect(()=>{
  const c=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const q=new URLSearchParams({limit:'20',...(after?{after}:{})});const value=await sidecarFetch(handshake,`/agent-lifecycle/${encodeURIComponent(agentId)}?${q}`,{signal:c.signal}).then(requireOk<AgentLifecycleDetail>);if(!c.signal.aborted){setDetail(value);setError('');}}catch(e){if(!c.signal.aborted){setDetail(null);setError(String(e));}}finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),4000);}};
  void load();return()=>{c.abort();clearTimeout(timer);};
 },[agentId,handshake,after]);
 const openRoom=async(roomId:string)=>{await selectAgentSession(roomId);onClose();onOpenRoom?.();};
 const chooseRun=(run:AgentRunSummary)=>setTarget({roomId:run.roomId,rootTaskId:run.rootTaskId,runId:run.kind.startsWith('discussion')?null:run.id,workPackageId:run.workPackageId,workspaceId:run.workspaceId});
 return <DetailPanel open drawer title={`Agent · ${detail?.agent.nickname??agents.find(a=>a.id===agentId)?.nickname??agentId}`} closeLabel={tr('关闭 Agent 详情','Close agent detail')} onClose={onClose}>
  <div className="space-y-4 min-w-0" data-agent-detail>
   {error&&<ErrorNotice message={error}/>} {!detail&&!error&&<p>{tr('读取中…','Loading…')}</p>}
   {detail&&<>
    <AgentPresence availability={detail.availability} workload={detail.workload} en={en}/>
    <p className="text-sm">{detail.configuration.providerName??tr('供应商缺失','Provider missing')} · {detail.configuration.modelId}</p><p>{detail.agent.role||tr('未填写职责','No role specified')}</p>
    <details><summary>{tr('配置与连接证据','Configuration and connection evidence')}</summary>
     <p>{tr('配置','Configuration')}: {detail.configuration.configured?tr('已配置','Configured'):tr('不完整','Incomplete')} · {tr('工具调用','Tool calling')}: {String(detail.availability.toolCalling)} · Runtime: {detail.availability.runtime}</p>
     <p>{detail.availability.reason}</p><p>{tr('最近探测','Last checked')}: {detail.availability.checkedAt??'—'} · {tr('到期','Expires')}: {detail.availability.expiresAt??'—'}</p>
     <p>{tr('连接证据来自设置中的列模型端点探测，不证明生成能力；持有 Key 不等于在线。','Evidence comes from the settings models-endpoint probe; it does not verify generation. A stored key alone is not online status.')}</p>
    </details>
    <h3 className="font-bold">{tr('所属 Squad 与职责','Squads and responsibilities')}</h3>{detail.squads.length?detail.squads.map(s=><p key={s.id}>{s.name}{s.archived?` · ${tr('已归档','Archived')}`:''} · {s.responsibility||'—'}</p>):<p>—</p>}
    <h3 className="font-bold">{tr('当前队列与 Active Tasks','Current queue and active tasks')}</h3>
    <p className="text-xs">{Object.entries(detail.workload.counts).filter(([,n])=>n).map(([state,n])=>`${stateLabel(state,en)} ${n}`).join(' · ')||tr('没有正在执行或等待的任务','No active or waiting executions')}</p>
    {detail.workload.items.map(item=><button key={`${item.kind}:${item.id}`} className="pixel-button block w-full text-left px-2 py-2 break-all" onClick={()=>setTarget({roomId:item.roomId,rootTaskId:item.rootTaskId,runId:item.runId,workPackageId:item.workPackageId,workspaceId:sessions.find(s=>s.id===item.roomId)?.workspaceId})}>{stateLabel(item.state,en)} · {sessions.find(s=>s.id===item.roomId)?.title??item.roomId}<small className="block">{item.id} · attempt {item.attemptNo}</small></button>)}
    <details><summary>{tr('持续负责的工作事项（最多 100 项，不代表已排队）','Owned work items (up to 100; assignment is not a queued execution)')} · {detail.assignments.length}</summary>{detail.assignments.map(item=><p key={item.id}>{item.title}</p>)}</details>
    <h3 className="font-bold">{tr('最近执行','Recent runs')}</h3>{detail.recentRuns.runs.map(run=><button className="pixel-button block w-full px-2 py-2 text-left break-all" key={run.id} onClick={()=>chooseRun(run)}>{run.kind} · {run.status} · attempt {run.attemptNo}<small className="block">{run.id} · {new Date(run.createdAt).toLocaleString()}</small></button>)}
    {!detail.recentRuns.runs.length&&<p>{tr('暂无执行记录','No executions recorded')}</p>}
    <div className="flex gap-2"><button className="pixel-button px-2 py-1" disabled={!after} onClick={()=>setAfter(null)}>{tr('最新记录','Latest runs')}</button><button className="pixel-button px-2 py-1" disabled={!detail.recentRuns.next} onClick={()=>setAfter(detail.recentRuns.next)}>{tr('更早记录','Earlier runs')}</button></div>
    <details><summary>{tr('近 30 天统计与费用','Last 30 days: outcomes and cost')}</summary>
     <p>{new Date(detail.statistics.since).toLocaleString()} — {new Date(detail.statistics.until).toLocaleString()}</p>
     <p>{tr('Native / 工作包执行次数（每次 attempt 单独计数）','Native / package executions (each attempt counted separately)')}: {detail.statistics.totalRuns}</p>
     <p>{tr('完成','Completed')} {detail.statistics.completedRuns} / {detail.statistics.totalRuns} · {tr('失败','Failed')} {detail.statistics.failedRuns} / {detail.statistics.totalRuns} · {tr('取消','Cancelled')} {detail.statistics.cancelledRuns} · {tr('中断或预算暂停','Interrupted or budget paused')} {detail.statistics.interruptedRuns}</p>
     <p>{tr('讨论 / 规划 / 审核轮次','Discussion / planning / review turns')}: {detail.statistics.discussionTurns} · {tr('完成','Completed')} {detail.statistics.completedDiscussionTurns} · {tr('失败','Failed')} {detail.statistics.failedDiscussionTurns}</p>
     <p>{tr('房间讨论命令','Room discussion commands')}: {detail.statistics.discussionCommands}</p>
     <p>{tr('完成不等于通过独立测试；统计按开始时间归入窗口。','Completion does not mean independently verified success; the window uses start time.')}</p>
     <p>{tr('实际发出的计费调用','Sent model invocations')}: {detail.cost.invocations} · {tr('费用未确定','Unknown cost')}: {detail.cost.unknownCount} / {detail.cost.invocations}</p>
     <p>{tr('已计价','Priced')}: {detail.cost.totals.map(m=>`${atomicToDecimal(m.atomic)} ${m.currency}`).join(' · ')||'—'}</p><p>{tr('估算','Estimated')}: {detail.cost.estimatedTotals?.map(m=>`${atomicToDecimal(m.atomic)} ${m.currency}`).join(' · ')||'—'}</p>
     <p className="text-xs">{tr('费用基于此 Agent 在窗口内的逐调用账本，包含重试与账单调整，币种不合并。旧版未归属账目不计入。','Cost uses this agent’s invocation ledger in the window, including retries and invoice adjustments. Currencies remain separate; unattributed legacy usage is excluded.')}</p>
    </details>
    {target&&<RunTimeline key={`${target.roomId}:${target.rootTaskId}:${target.runId??''}:${target.workPackageId??''}`} target={target} handshake={handshake} en={en} onOpenRoom={id=>void openRoom(id)}/>}
   </>}
  </div>
 </DetailPanel>;
}
