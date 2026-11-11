import {useRef,useState} from 'react';
import type {SquadTemplate,WorkItem,WorkInteractionInput,WorkInteraction,RoomMention} from '@socrates/core';
import {ActorPicker,ErrorNotice,notify} from '../foundation';
import {useStorePick} from '../selectors';
import {requireOk,sidecarFetch,type Handshake} from '../transport';
import {reserveInteraction,type PendingInteraction} from './requestIdentity';
import WillTrigger,{useTriggerPreview} from './WillTrigger';
import InteractionHistory from './InteractionHistory';

export default function WorkItemDiscussion({item,squads,handshake,onOpenRoom}:{item:WorkItem;squads:SquadTemplate[];handshake:Handshake;onOpenRoom:(id:string)=>void}){
 const {agents,lang}=useStorePick('agents','lang'),en=lang==='en',tr=(zh:string,english:string)=>en?english:zh;
 const [content,setContent]=useState(''),[action,setAction]=useState<WorkInteractionInput['action']>('note'),[delivery,setDelivery]=useState<NonNullable<WorkInteractionInput['delivery']>>('queue');
 const [target,setTarget]=useState(''),[packageId,setPackageId]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[revision,setRevision]=useState(0);
 const request=useRef<PendingInteraction|null>(null);
 const leaderAction=action==='reevaluate'||action==='delegate_package';
 const path=`/work-items/${encodeURIComponent(item.id)}/interactions`;
 const mentions:RoomMention[]=target.startsWith('agent:')?[{type:'agent',agentId:target.slice(6)}]:target.startsWith('squad:')?[{type:'squad',squadId:target.slice(6)}]:[];
 const input:WorkInteractionInput={clientRequestId:'preview',action,content:content.trim(),mentions:action==='message'?mentions:[],delivery,...(action==='delegate_package'?{packageId}:{})};
 const {preview,error:previewError}=useTriggerPreview(handshake,path,content.trim()?input:null);
 const actors=[{id:'',label:tr('默认响应者（不改变负责人）','Default responder (owner unchanged)')},...agents.map(agent=>({id:'agent:'+agent.id,label:'@'+agent.nickname,description:agent.role})),...squads.filter(s=>!s.archived).map(s=>({id:'squad:'+s.id,label:'@'+s.name,description:'Squad · Leader'}))];
 const submit=async()=>{
  if(busy||!preview?.canSubmit)return;setBusy(true);setError('');
  request.current=reserveInteraction(request.current,input);
  try{const saved=await sidecarFetch(handshake,path,{method:'POST',body:JSON.stringify(request.current.input)}).then(requireOk<WorkInteraction>);
   setContent('');setRevision(n=>n+1);request.current=null;notify(saved.status==='saved'?tr('备注已保存，未调用模型','Note saved without a model call'):tr('指示已记录，可查看交付状态','Instruction recorded; delivery status is available'));
  }catch(e){setError(String(e));}finally{setBusy(false);}
 };
 return <section className="space-y-3 border-t pt-3" data-work-item-discussion>
  <h3>{tr('任务指示与备注','Task instructions and notes')}</h3>
  <label>{tr('操作','Action')}<select className="pixel-input w-full" value={action} onChange={e=>{const next=e.target.value as WorkInteractionInput['action'];setAction(next);if(next==='reevaluate'||next==='delegate_package')setDelivery('now');}}><option value="note">{tr('仅备注，不触发','Note only, no trigger')}</option><option value="message">{tr('发送指示 / @提及','Send instruction / @mention')}</option><option value="request_human_review">{tr('请求人工审核','Request human review')}</option><option value="reevaluate">{tr('请 Leader 重新评价','Ask Leader to reassess')}</option><option value="delegate_package">{tr('请 Leader 继续已批准的工作','Ask Leader to continue approved work')}</option></select></label>
  {action==='message'&&<ActorPicker label={tr('本轮调用对象','This message target')} actors={actors} value={target} onChange={id=>setTarget(id??'')}/>}
  {action==='delegate_package'&&<label>{tr('工作包','Work package')}<select className="pixel-input w-full" value={packageId} onChange={e=>setPackageId(e.target.value)}><option value="">{tr('选择工作包','Choose a package')}</option>{item.workPackages.map(p=><option key={p.id} value={p.id}>{p.title} · {p.state}</option>)}</select></label>}
  {!['note','request_human_review'].includes(action)&&<><label>{tr('交付方式','Delivery')}<select className="pixel-input w-full" value={delivery} onChange={e=>setDelivery(e.target.value as typeof delivery)}><option value="queue">{tr('排队到下一轮','Queue for the next round')}</option>{!leaderAction&&<option value="stop_restart">{tr('停止并重新执行','Stop and restart')}</option>}<option value="now">{leaderAction?tr('无执行中调用时立即评价','Reassess now when execution is quiescent'):tr('空闲时立即执行','Start when idle')}</option><option disabled value="in_run">{tr('当前运行插入（尚无可靠回执）','Insert into current run (no reliable receipt)')}</option></select></label>{leaderAction&&<p className="text-xs">{tr('立即评价可用于等待审批或暂停状态；排队会等当前执行结束。停止后须重新批准启动任务，不能重启旧 Leader 评价。','Reassess now supports approval waits and pauses; queue waits until execution settles. Restarting cancelled work requires a newly approved task start.')}</p>}<p className="text-xs">{tr('沿用当前工作事项的权限与预算；未设置金额预算时，额外执行仍会计费。','Uses the current work item permissions and budget; additional execution is still billable without a spending cap.')}</p></>}
  <label>{tr('内容','Instruction content')}<textarea className="pixel-input w-full min-h-24" value={content} disabled={busy} onChange={e=>setContent(e.target.value)}/></label>
  <WillTrigger preview={preview} error={previewError} loading={!!content.trim()} en={en}/>
  {error&&<ErrorNotice message={error}/>}
  <button className="pixel-button pixel-button--primary px-3 py-2" disabled={busy||!preview?.canSubmit} onClick={()=>void submit()}>{tr('提交此操作','Submit this action')}</button>
  <InteractionHistory path={path} handshake={handshake} en={en} revision={revision} onOpenRoom={onOpenRoom}/>
 </section>;
}
