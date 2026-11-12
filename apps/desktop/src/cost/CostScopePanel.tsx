import { useEffect, useState } from 'react';
import { atomicToDecimal, type CostSummary, type InvocationRecord, type BudgetSummary } from '@socrates/core';
import { useStorePick } from '../selectors';
import { requireOk, sidecarFetch, type Handshake } from '../transport';
import { ErrorNotice } from '../foundation';
type Scope={workspaceId?:string;workItemId?:string;squadId?:string;workPackageId?:string;rootTaskId?:string;agentId?:string};
type View={summary:CostSummary;invocations:InvocationRecord[];tasks:Array<{rootTaskId:string;budget:BudgetSummary|null;blocked:{reason:string}|null;quote:{id:string;lowAtomic:string|null;highAtomic:string|null;unknowns:string[]}|null}>};
/** Read-only dimensions of the same physical invocation ledger; never sum dimensions. */
export default function CostScopePanel({handshake,scope}:{handshake:Handshake;scope:Scope}) {
 const {lang}=useStorePick('lang');const tr=(zh:string,en:string)=>lang==='en'?en:zh;
 const query=new URLSearchParams(Object.entries(scope).filter((entry):entry is [string,string]=>Boolean(entry[1]))).toString();
 const [view,setView]=useState<View|null>(null),[error,setError]=useState('');
 useEffect(()=>{setView(null);setError('');const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;
  const load=async()=>{try{const next=await sidecarFetch(handshake,`/cost/scopes?${query}`,{signal:controller.signal}).then(requireOk<View>);if(!controller.signal.aborted){setView(next);setError('');}}catch(e){if(!controller.signal.aborted)setError(String(e));}finally{if(!controller.signal.aborted)timer=setTimeout(()=>void load(),2500);}};
  void load();return()=>{controller.abort();clearTimeout(timer);};
 },[handshake,query]);
 const amount=(items:CostSummary['totals'])=>items.map(m=>`${atomicToDecimal(m.atomic)} ${m.currency}`).join(' · ');
 return <details className="space-y-2 text-xs" data-cost-scope={query}><summary><strong>{tr('成本与使用量','Cost and usage')}</strong> · {view?(view.summary.invocations?(amount(view.summary.totals)||tr('费用未知','Cost unknown')):tr('尚无模型调用','No model invocations')):tr('加载中','Loading')}{view&&view.summary.unknownCount>0?` · ${tr('部分费用未知','Some costs unknown')}`:''}</summary>
 {error&&<ErrorNotice message={error}/>}{view&&<div className="space-y-2 break-words">
 <p>{tr('计费调用','Billable invocations')}: {view.summary.invocations} · {tr('费用未知','Unknown cost')}: {view.summary.unknownCount} · {tr('旧版未归属用量','Unattributed legacy usage')}: {view.summary.historicalUnknownCount}</p>
 <p>{tr('已计价','Priced')}: {amount(view.summary.totals)||tr('未知 / 无已计价记录','Unknown / no priced records')} · {tr('估算','Estimated')}: {amount(view.summary.estimatedTotals??[])||'—'}</p>
 <p>{tr('输入 / 输出 tokens（已知部分）','Input / output tokens (known portion)')}: {view.summary.usage.inputTokens??tr('未知','Unknown')} / {view.summary.usage.outputTokens??tr('未知','Unknown')}</p>
 <p>{tr('所有视图查询同一逐调用账本，任务、团队、成员是重叠维度，不能相加。无报价或无预算不表示免费。','All views query one invocation ledger. Task, squad and agent are overlapping dimensions; do not add them. Missing quotes or budgets do not mean free.')}</p>
 {view.tasks.map(task=><article key={task.rootTaskId}><p>{tr('执行','Execution')}: {task.rootTaskId}</p><p>{tr('冻结报价','Frozen quote')}: {task.quote?.lowAtomic!=null&&task.quote.highAtomic!=null?`${atomicToDecimal(task.quote.lowAtomic)} – ${atomicToDecimal(task.quote.highAtomic)} USD`:tr('未知','Unknown')}{task.quote?` · ${task.quote.id}`:''}</p><p>{tr('预算','Budget')}: {task.budget?`${atomicToDecimal(task.budget.limitAtomic)} USD · ${task.budget.mode}`:tr('未设置 / 未知','Not configured / unknown')}{task.blocked?` · budget_stopped: ${task.blocked.reason}`:''}</p></article>)}
 <details><summary>{tr('逐次调用、模型与价格证据','Invocations, models and price evidence')}</summary>{view.invocations.map(i=><article key={i.invocationId} className="my-2"><p>{i.agentId} · {i.modelId} · {i.purpose} · attempt {i.attemptNo}</p><p>{i.invocationId} · {i.status} · {i.state}</p><p>{i.reconciliation?amount([i.reconciliation.amount]):i.amount?amount([i.amount]):tr('未知','Unknown')} · {tr('价格快照','Price snapshot')}: {i.priceSnapshotId??tr('未知','Unknown')}</p>{i.unknownItems.length>0&&<p>{i.unknownItems.join(' · ')}</p>}</article>)}</details>
 </div>}</details>;
}
