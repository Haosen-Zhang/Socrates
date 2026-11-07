import type { Database } from "bun:sqlite";
import { normalizeCollaborationSettings, StructuredExecutionError, type AdaptiveAttempt, type GatewayInvocationContext, type RouteDecision } from "@socrates/core";
import type { InvocationRequest } from "./model-invocation-broker";

const reject=(reason:string):never=>{throw new StructuredExecutionError({code:reason,message:reason,category:"invalid_request",phase:"provider_connect",retryable:false});};
export function frozenInvocationRoute(db:Database, context:GatewayInvocationContext, request:InvocationRequest):RouteDecision|null {
  const row=db.query<{decision_json:string},[string]>("SELECT decision_json FROM routing_decisions WHERE root_task_id=?").get(context.rootTaskId);
  if(!row){if(context.routeAttemptId)reject("routing_decision_missing");return null;}
  const route=JSON.parse(row.decision_json) as RouteDecision;
  if(route.roomId!==context.roomId||!context.routeAttemptId)reject("routing_attempt_missing");
  const saved=db.query<{attempt_json:string},[string,string]>("SELECT attempt_json FROM adaptive_attempts WHERE id=? AND root_task_id=?").get(context.routeAttemptId!,context.rootTaskId);
  if(!saved)reject("routing_attempt_missing");
  const attempt=JSON.parse(saved!.attempt_json) as AdaptiveAttempt;
  if(attempt.decisionId!==route.id)reject("routing_frozen_identity_mismatch");
  if(!["dispatching","running"].includes(attempt.status))reject("routing_attempt_not_active");
  const role=attempt.assignments;
  const customDiscussion=route.preset==="custom"&&attempt.workflow==="team"&&route.collaboration.discussion.enabled;
  const roleIds=context.purpose==="execute"?role.executorIds:context.purpose==="plan"?[role.managerId]:context.purpose==="review"?[role.reviewerId]
    :context.purpose==="compact"?[role.managerId,...role.executorIds,role.reviewerId]
    :customDiscussion&&context.purpose==="respond"?route.collaboration.discussion.speakerOrder
    :customDiscussion&&context.purpose==="summarize"?[route.collaboration.discussion.summaryAgentId ?? role.managerId]:[];
  if(!roleIds.includes(context.agentId)||!route.allowedAgentIds.includes(context.agentId))reject("routing_assignment_mismatch");
  const member=route.members[context.agentId];
  if(!member||member.profile.providerId!==context.providerConnectionId||member.profile.modelId!==request.modelId||member.profile.configurationVersion!==context.runProfileVersion
    ||member.provider.baseUrl!==request.baseUrl||member.provider.type!==request.providerType||!route.allowedProviderIds.includes(context.providerConnectionId))reject("routing_frozen_identity_mismatch");
  assertFrozenRouteAvailable(db,route,[context.agentId]);
  return route;
}

/** A frozen choice preserves identities and prices, never a revoked permission. */
export function assertFrozenRouteAvailable(db:Database,route:RouteDecision,agentIds:string[]):void {
  const room=db.query<{collaboration_json:string|null;workspace_id:string|null;archived:number},[string]>("SELECT collaboration_json,workspace_id,archived FROM sessions WHERE id=?").get(route.roomId);
  if(!room||room.archived)reject("routing_room_unavailable");
  const workspace=room!.workspace_id?db.query<{identity_hash:string;archived:number},[string]>("SELECT identity_hash,archived FROM workspaces WHERE id=?").get(room!.workspace_id):null;
  if(!workspace||workspace.archived||workspace.identity_hash!==route.workspaceIdentity)reject("routing_workspace_changed");
  const current=normalizeCollaborationSettings(room!.collaboration_json?JSON.parse(room!.collaboration_json):null);
  const memberRows=db.query<{agent_id:string;execution_eligible:number},[string]>("SELECT agent_id,execution_eligible FROM session_agents WHERE session_id=?").all(route.roomId);
  const members=memberRows.map(member=>member.agent_id);
  const pool=current.assignment.callableAgentIds.length?current.assignment.callableAgentIds:members;
  for(const agentId of agentIds){
    if(!members.includes(agentId)||!pool.includes(agentId)||!route.allowedAgentIds.includes(agentId))reject("routing_member_revoked");
    if(!memberRows.find(member=>member.agent_id===agentId)?.execution_eligible)reject("routing_member_revoked");
    const frozen=route.members[agentId];
    if(!frozen||!route.allowedProviderIds.includes(frozen.profile.providerId))reject("routing_frozen_identity_mismatch");
    if(current.assignment.routing.allowedProviderIds&&!current.assignment.routing.allowedProviderIds.includes(frozen.profile.providerId))reject("routing_egress_revoked");
    const provider=db.query<{enabled:number;base_url:string;type:string},[string]>("SELECT enabled,base_url,type FROM providers WHERE id=?").get(frozen.profile.providerId);
    if(!provider?.enabled||provider.base_url!==frozen.provider.baseUrl||provider.type!==frozen.provider.type)reject("routing_provider_unavailable");
  }
}

/** Call inside the same immediate transaction as ledger.begin. Created rows
 * reserve a physical-call slot, so concurrent requests cannot over-admit. */
export function assertRoutingCallSlot(db:Database, route:RouteDecision):void {
  const count=db.query<{n:number},[string]>("SELECT COUNT(*) AS n FROM cost_invocations WHERE root_task_id=? AND (outcome IS NULL OR outcome!='not_sent')").get(route.rootTaskId)!.n;
  if(count>=route.limits.maxTotalModelCalls)reject("routing_model_call_limit");
}
