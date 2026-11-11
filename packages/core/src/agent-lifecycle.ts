import type { Agent } from './chat';
import type { CostSummary } from './cost';

export type AgentAvailability = 'ready' | 'degraded' | 'unavailable' | 'unknown';
export interface AgentAvailabilityProjection {
  state: AgentAvailability;
  reason: string;
  checkedAt: string | null;
  expiresAt: string | null;
  toolCalling: boolean | 'unknown';
  runtime: 'ready' | 'unavailable' | 'unknown';
  evidenceScope: 'models_endpoint';
}
export interface AvailabilityFacts {
  configured: boolean;
  providerEnabled: boolean;
  credential: 'present' | 'missing' | 'unknown';
  runtime: AgentAvailabilityProjection['runtime'];
  toolCalling: boolean | 'unknown';
  evidence: { outcome: 'ok' | 'auth_failed' | 'network_error' | 'error'; checkedAt: string; expiresAt: string } | null;
  now: number;
}
/** Availability is connection evidence, never the outcome of the last task. */
export function projectAgentAvailability(f: AvailabilityFacts): AgentAvailabilityProjection {
  const fresh = f.evidence && Date.parse(f.evidence.expiresAt) > f.now && Date.parse(f.evidence.checkedAt) <= f.now;
  let state: AgentAvailability = 'unknown', reason = 'connection_unverified';
  if (!f.configured) { state = 'unavailable'; reason = 'configuration_incomplete'; }
  else if (!f.providerEnabled) { state = 'unavailable'; reason = 'provider_disabled'; }
  else if (f.credential === 'missing') { state = 'unavailable'; reason = 'credential_missing'; }
  else if (f.runtime === 'unavailable') { state = 'unavailable'; reason = 'runtime_unavailable'; }
  else if (fresh && f.evidence!.outcome !== 'ok') { state = 'unavailable'; reason = `connection_${f.evidence!.outcome}`; }
  else if (!fresh) reason = f.evidence ? 'connection_evidence_expired' : 'connection_unverified';
  else if (f.credential === 'unknown' || f.runtime === 'unknown') reason = 'runtime_or_credential_unverified';
  else if (f.toolCalling !== true) { state = 'degraded'; reason = f.toolCalling === false ? 'tools_unsupported' : 'tools_unverified'; }
  else { state = 'ready'; reason = 'recent_connection_verified'; }
  return {state, reason, checkedAt:f.evidence?.checkedAt??null, expiresAt:f.evidence?.expiresAt??null, toolCalling:f.toolCalling, runtime:f.runtime, evidenceScope:'models_endpoint'};
}
export type AgentWorkState = 'queued' | 'workspace_waiting' | 'running' | 'awaiting_approval' | 'paused' | 'awaiting_verification' | 'awaiting_review';
export interface AgentWorkItem {
  id: string; kind: 'run' | 'work_package' | 'task' | 'command' | 'discussion'; roomId: string; rootTaskId: string;
  runId: string | null; workPackageId: string | null; attemptNo: number; state: AgentWorkState; createdAt: string;
}
export interface AgentWorkloadProjection {
  state: AgentWorkState | 'idle';
  counts: Record<AgentWorkState, number>;
  items: AgentWorkItem[];
}
export function projectAgentWorkload(items: AgentWorkItem[]): AgentWorkloadProjection {
  const priority: AgentWorkState[] = ['awaiting_approval','paused','running','workspace_waiting','queued','awaiting_verification','awaiting_review'];
  const counts = Object.fromEntries(priority.map(state=>[state,items.filter(item=>item.state===state).length])) as AgentWorkloadProjection['counts'];
  return {state:priority.find(state=>counts[state]>0)??'idle',counts,items};
}
export interface AgentRunSummary {
  id:string; kind:'native'|'package'|'discussion'|'discussion_command'; roomId:string; workspaceId:string|null; rootTaskId:string; workPackageId:string|null;
  attemptNo:number; status:string; createdAt:string; completedAt:string|null;
}
export interface AgentLifecycleDetail {
  agent: Agent;
  configuration: {configured:boolean; providerId:string; providerName:string|null; modelId:string; credential:'present'|'missing'|'unknown'};
  availability: AgentAvailabilityProjection;
  workload: AgentWorkloadProjection;
  squads: Array<{id:string;name:string;workspaceId:string;responsibility:string;archived:boolean}>;
  assignments: Array<{id:string;title:string;workspaceId:string;ownerKind:string;ownerId:string|null}>;
  recentRuns: {runs:AgentRunSummary[];next:string|null};
  statistics: {since:string;until:string;totalRuns:number;completedRuns:number;failedRuns:number;cancelledRuns:number;interruptedRuns:number;discussionCommands:number;discussionTurns:number;completedDiscussionTurns:number;failedDiscussionTurns:number;scope:'native_runs_started_in_window';};
  cost: CostSummary;
}
