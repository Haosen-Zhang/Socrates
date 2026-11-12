import type {AgentAvailabilityProjection,AgentWorkloadProjection} from '@socrates/core';
import {StatusBadge} from '../foundation';
export const stateLabel=(state:string,en:boolean)=>en?state.replace(/_/g,' '):({ready:'可用',degraded:'能力受限',unavailable:'不可用',unknown:'连接未知',idle:'空闲',queued:'排队中',workspace_waiting:'等待工作区',running:'执行中',awaiting_approval:'等待审批',paused:'已暂停',awaiting_verification:'等待验证',awaiting_review:'等待审核'}[state]??state);
export default function AgentPresence({availability,workload,en=false}:{availability:AgentAvailabilityProjection;workload:AgentWorkloadProjection;en?:boolean}){
 return <div className="flex flex-wrap gap-2" data-agent-presence data-availability={availability.state} data-workload={workload.state}>
  <span>{en?'Availability':'可用性'}: <StatusBadge tone={availability.state==='ready'?'success':availability.state==='unavailable'?'danger':availability.state==='degraded'?'warning':'neutral'}>{stateLabel(availability.state,en)}</StatusBadge></span>
  <span>{en?'Current work':'当前工作'}: <StatusBadge tone={workload.state==='idle'?'neutral':workload.state==='awaiting_approval'?'warning':'info'}>{stateLabel(workload.state,en)}</StatusBadge> {workload.items.length>0&&`(${workload.items.length})`}</span>
 </div>;
}
