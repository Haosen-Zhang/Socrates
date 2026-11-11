import { useEffect, useState } from 'react';
import type { TriggerPreview, WorkInteractionInput } from '@socrates/core';
import { requireOk, sidecarFetch, type Handshake } from '../transport';

export function useTriggerPreview(handshake: Handshake | null, path: string, input: WorkInteractionInput | null) {
  const identity = input ? JSON.stringify(input) : '';
  const requestKey=path+'|'+identity;
  const [result, setResult] = useState<{identity:string;preview:TriggerPreview|null;error:string}>({identity:'',preview:null,error:''});
  useEffect(() => {
    if (!handshake || !identity) return;
    const c = new AbortController();
    let timer:ReturnType<typeof setTimeout>;
    const load=async()=>{
      try{const preview=await sidecarFetch(handshake, `${path}/preview`, {method:'POST',body:identity,signal:c.signal}).then(requireOk<TriggerPreview>);
        if(!c.signal.aborted)setResult({identity:requestKey,preview,error:''});
      }catch(error){if(!c.signal.aborted)setResult({identity:requestKey,preview:null,error:String(error)});}
      finally{if(!c.signal.aborted)timer=setTimeout(()=>void load(),2000);}
    };
    timer=setTimeout(()=>void load(),250);
    return () => {clearTimeout(timer);c.abort();};
  }, [handshake,path,identity,requestKey]);
  return result.identity===requestKey ? result : {identity,preview:null,error:''};
}
export default function WillTrigger({preview,error,loading,en}:{preview:TriggerPreview|null;error:string;loading?:boolean;en:boolean}) {
  const tr=(zh:string,english:string)=>en?english:zh;
  return <details className="work-review-note text-sm" data-will-trigger open={!!error || !!preview?.reasons.length}>
    <summary>{tr('本次将触发','Will trigger')}: {preview ? preview.createsRun ? preview.targets.map(t=>t.label).join(' · ')||tr('等待可用目标','No available target') : tr('不调用模型','No model calls') : loading?tr('检查中…','Checking…'):'—'}</summary>
    {error&&<p role="alert">{error}</p>}
    {preview&&<><p>{tr('不改变持续负责人。','The persistent owner stays unchanged.')}</p>
      {preview.targets.map(target=><p key={target.agentId}>{target.label} · {target.reason}{target.alreadyQueued?` · ${tr('正在排队','Queued')}`:''}{target.blockedReason?` · ${target.blockedReason}`:''}</p>)}
      {preview.reasons.map(reason=><p key={reason} role="status">{reason}</p>)}
      <p>{preview.delivery==='queue'?tr('当前执行结束后开始下一轮；暂停与未知副作用需要先处理。','Starts after the current execution settles; pauses and unknown side effects require attention.'):preview.delivery==='stop_restart'?tr('等待停止确认与副作用结算后再开始。','Starts only after cancellation and side effects settle.'):tr('发送后按当前权限与预算准入。','Dispatch uses the current permission and budget checks.')}</p>
      <p>{tr('当前运行插入不可用：运行时尚无可靠的送达回执。','In-run insertion is unavailable: the runtime has no durable delivery receipt.')}</p>
      {preview.rule==='reevaluate'||preview.rule==='delegate_package'?<p>{tr('协调评价上限','Evaluation limit')}: {preview.limits.maxEvaluations} · {tr('委派上限','Delegation limit')}: {preview.limits.maxDelegations}</p>:null}
    </>}
  </details>;
}
