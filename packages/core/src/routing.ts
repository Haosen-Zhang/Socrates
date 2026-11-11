import { atomic, requestCostUpperBound, type BudgetMode, type PriceSnapshot } from "./cost";
import type { ModelCapabilities, ReasoningEffort } from "./model-capabilities";
import type { ResolvedRoomCommand, RoomCommandInput } from "./room-command";
import type { RoomCollaborationSettings, RoomKind } from "./room-kind";

export const ROUTING_POLICY_VERSION = "deterministic_workflows/1";
export type RoutingPreset = "economy" | "balanced" | "quality" | "custom";
export type RouteWorkflow = "direct" | "plan_execute" | "execute_review" | "team";
export interface RouteLimits { maxRetries: number; maxEscalations: number; maxTotalModelCalls: number }
export const DEFAULT_ROUTE_LIMITS: Readonly<RouteLimits> = Object.freeze({ maxRetries: 1, maxEscalations: 1, maxTotalModelCalls: 24 });
export interface TaskFeatures {
  selectedPaths: string[];
  fileCount: number;
  modulePaths: string[];
  independentModuleCount: number;
  dependencyEdges: Array<{ from: string; to: string }>;
  sharedStateCoupled: boolean;
  scripts: Array<{ path: string; names: string[] }>;
  risk: "ordinary" | "sensitive";
  riskReasons: string[];
  verification: "machine" | "manual" | "unconfigured";
  verificationCheckIds: string[];
  requiredCapabilities: { textInput: boolean; toolCalling: boolean; imageInput: boolean; fileInput: boolean };
  inputTokensEstimate: number;
  contextTokensRequired: number;
  scope: "local" | "multi_module" | "unknown";
  evidence: "workspace_metadata";
  unknowns: string[];
}
export interface RoutingMember {
  agentId: string; providerId: string; modelId: string;
  enabled: boolean; credentialAvailable: boolean; executionEligible: boolean; egressAllowed: boolean;
  capabilities: ModelCapabilities; contextWindowTokens: number | null;
  protocol: string; price: PriceSnapshot | null;
}
export interface RouteCostStage {
  stage: string; agentIds: string[]; lowCalls: number; highCalls: number;
  lowAtomic: string | null; highAtomic: string | null; assumptions: string[];
}
export interface RouteCandidate {
  id: string; workflow: RouteWorkflow; resolved: ResolvedRoomCommand;
  assignments: { managerId: string | null; executorIds: string[]; reviewerId: string | null };
  lowAtomic: string | null; highAtomic: string | null; currency: "USD";
  stages: RouteCostStage[]; priceSnapshotIds: string[];
  modelCalls: { low: number; high: number };
  reasonCodes: string[]; feasible: boolean; exclusionReasons: string[];
  evidence: "rules_only";
  costStatus: "known" | "reference_estimate" | "unknown";
  /** Explicitly authorized continuation, excluded from automatic initial selection. */
  fallbackOnly?: boolean;
}
export interface RoutingInput {
  preset: RoutingPreset; strategy: "single" | "adaptive" | "team";
  primaryAgentId: string; managerId: string | null; reviewerId: string | null;
  customExecutorId?: string | null;
  discussion?: RoomCollaborationSettings["discussion"];
  allowedAgentIds: string[]; lockedAgentIds: string[]; fallbackAgentIds: string[];
  members: RoutingMember[]; features: TaskFeatures; limits: RouteLimits;
  budget: { mode: BudgetMode; limitAtomic: string } | null;
  maxOutputTokens: number; at: string; selectedCandidateId?: string;
}
export interface RoutingSelection {
  candidates: RouteCandidate[]; selected: RouteCandidate | null; selectedCandidateId: string | null;
  exclusions: Array<{ agentId: string; reasonCodes: string[] }>; reasonCodes: string[];
  allowedAgentIds: string[]; fallbackAgentIds: string[];
}
/** Credential-free structural RunProfile shared with the sidecar and desktop. */
export interface FrozenRouteMember {
  snapshot: Record<string, unknown>;
  profile: { agentId: string; providerId: string; modelId: string; nickname: string; avatar?: string;
    role: string; systemPrompt: string; temperature?: number; reasoningEffort: ReasoningEffort;
    modelCapabilities: ModelCapabilities; contextWindowTokens: number | null; configurationVersion: string;
    overrides: { reasoningEffort?: ReasoningEffort } };
  provider: { id: string; type: "anthropic" | "openai_compatible"; baseUrl: string; protocol: string };
  price: PriceSnapshot | null;
}
export interface RoutePreview {
  roomId: string; bindingHash: string; inputHash: string; policyVersion: string; preset: RoutingPreset;
  features: TaskFeatures; featuresHash: string; metadataHash: string; workspaceIdentity: string;
  verification: { planId: string | null; planHash: string | null; hasChecks: boolean };
  members: Record<string, FrozenRouteMember>;
  allowedAgentIds: string[]; allowedProviderIds: string[]; lockedAgentIds: string[]; fallbackAgentIds: string[];
  limits: RouteLimits; collaboration: RoomCollaborationSettings; budget: RoomCommandInput["budget"] | null;
  candidates: RouteCandidate[]; selectedCandidateId: string | null; selected: RouteCandidate | null;
  exclusions: Array<{ agentId: string; reasonCodes: string[] }>; reasonCodes: string[];
}
export interface RouteDecision extends RoutePreview { id: string; rootTaskId: string; quoteId: string | null; createdAt: string }

export function isRoutingEnabled(room: {kind: RoomKind; collaboration: RoomCollaborationSettings}, command: Pick<RoomCommandInput,"intent"> & Partial<Pick<RoomCommandInput,"mentions">>): boolean {
  return room.kind === "cowork" && command.intent === "execute"
    && !command.mentions?.some(mention=>mention.type==="all")
    && !(room.collaboration.strategy!=="team"&&new Set(command.mentions?.flatMap(mention=>mention.type==="agent"?[mention.agentId]:[])).size>1)
    && (room.collaboration.strategy === "adaptive" || room.collaboration.assignment.routing.mode === "manual");
}

/** Cold-start policy. No model names, model-authored confidence or prompt-length complexity score. */
export function selectRoute(input: RoutingInput): RoutingSelection {
  const exclusions: RoutingSelection["exclusions"] = [];
  const at = Date.parse(input.at);
  if (!Number.isFinite(at)) throw new Error("routing_time_invalid");
  if (input.budget) atomic(input.budget.limitAtomic);
  const knownPrice = (member: RoutingMember) => {
    const price = member.price;
    return !!price && price.source !== "preset_estimate" && price.currency === "USD"
      && Date.parse(price.validFrom) <= at && (!price.validUntil || Date.parse(price.validUntil) > at)
      && requestCostUpperBound(price, 1, 1) !== null;
  };
  const allowed = new Set(input.allowedAgentIds), locked = new Set(input.lockedAgentIds);
  const explicitSingle=locked.size===1;
  const lockedWorkersOnly=!explicitSingle&&input.preset==="custom"&&input.strategy==="team";
  const fallbackAgentIds=input.fallbackAgentIds.filter(id=>!locked.size||locked.has(id));
  const eligible = [...input.members].sort((a,b)=>a.agentId.localeCompare(b.agentId)).filter(member => {
    const reasons: string[] = [];
    if (!allowed.has(member.agentId)) reasons.push("member_outside_allowed_pool");
    if (locked.size && !lockedWorkersOnly && !locked.has(member.agentId)) reasons.push("explicit_member_constraint");
    if (!member.enabled) reasons.push("provider_disabled");
    if (!member.credentialAvailable) reasons.push("provider_credentials_unavailable");
    if (!member.egressAllowed) reasons.push("provider_egress_disallowed");
    if (!member.executionEligible) reasons.push("member_execution_revoked");
    if(member.capabilities.runtimeKinds!=="unknown"&&!member.capabilities.runtimeKinds.includes("native"))reasons.push("native_runtime_unsupported");
    for (const key of ["textInput","toolCalling","imageInput","fileInput"] as const) {
      if (input.features.requiredCapabilities[key] && member.capabilities[key] !== true) reasons.push(`capability_missing:${key}`);
    }
    if (!member.contextWindowTokens) reasons.push("context_window_unknown");
    else if (member.contextWindowTokens < input.features.contextTokensRequired) reasons.push("context_window_insufficient");
    if (!["openai_chat_completions","openai_responses","anthropic_messages"].includes(member.protocol)) reasons.push("model_protocol_unsupported");
    if (input.budget?.mode === "strict_admission" && !knownPrice(member)) reasons.push("strict_price_unavailable");
    if (reasons.length) exclusions.push({agentId:member.agentId,reasonCodes:reasons});
    return reasons.length === 0;
  });
  const byId = new Map(eligible.map(member=>[member.agentId,member]));
  const costOrder = (a: RoutingMember,b: RoutingMember) => {
    if (knownPrice(a) !== knownPrice(b)) return knownPrice(a) ? -1 : 1;
    const left = requestCostUpperBound(a.price,input.features.inputTokensEstimate,input.maxOutputTokens);
    const right = requestCostUpperBound(b.price,input.features.inputTokensEstimate,input.maxOutputTokens);
    if (left?.currency === "USD" && right?.currency === "USD" && left.atomic !== right.atomic) return BigInt(left.atomic)<BigInt(right.atomic)?-1:1;
    if (!!left !== !!right) return left ? -1 : 1;
    return a.agentId.localeCompare(b.agentId);
  };
  const ordered = [...eligible].sort(costOrder);
  const primary = byId.get(input.primaryAgentId);
  const manager = byId.get(input.managerId ?? "") ?? primary ?? ordered[0];
  const complex = input.features.scope === "multi_module" && !input.features.sharedStateCoupled;
  const machine = input.features.verification === "machine";
  const candidates: RouteCandidate[] = [];
  const make = (workflow:RouteWorkflow,managerId:string|null,executorIds:string[],reviewerId:string|null,reasonCodes:string[],fallbackOnly=false) => {
    const discussion=!explicitSingle&&input.preset==="custom"&&input.strategy==="team"&&input.discussion?.enabled?input.discussion:null;
    const ids = [...new Set([...executorIds,...(managerId?[managerId]:[]),...(reviewerId?[reviewerId]:[]),...(discussion?.speakerOrder??[])])];
    if (!executorIds.length || ids.some(id=>!byId.has(id))) return;
    const stages:RouteCostStage[]=[];
    const stage = (name:string,agentIds:string[],lowCalls:number,highCalls:number,assumptions:string[]) => {
      let low=0n,high=0n,priced=true;
      for (const id of agentIds) {
        const member=byId.get(id)!;
        const l=requestCostUpperBound(member.price,input.features.inputTokensEstimate,Math.min(1024,input.maxOutputTokens));
        const h=requestCostUpperBound(member.price,input.features.contextTokensRequired,input.maxOutputTokens);
        if (!l||!h||l.currency!=="USD"||h.currency!=="USD") priced=false;
        else {low+=BigInt(l.atomic)*BigInt(lowCalls);high+=BigInt(h.atomic)*BigInt(highCalls);}
      }
      stages.push({stage:name,agentIds,lowCalls,highCalls,lowAtomic:priced?String(low):null,highAtomic:priced?String(high):null,assumptions});
    };
    if(discussion)stage("discussion",discussion.speakerOrder,discussion.maxRounds,discussion.maxRounds,["The explicit Custom discussion runs every configured speaker in every configured round; its summary is included in the following planning call."]);
    if (managerId) stage("planning",[managerId],1,2,["Rule prior: one Manager plan and at most one structured-plan repair; no measured success probability."]);
    stage("execution",executorIds,1,(workflow==="direct"||workflow==="execute_review")&&complex?10:6,["Rule prior: 1–6 model samples per executor; unplanned multi-module work reserves up to 10. A later Reviewer does not reduce execution work. Tool results and rework remain uncertain."]);
    stage("validation",[],0,0,["Local approved checks; duration is recorded separately and no API price is invented."]);
    if (reviewerId) stage("review",[reviewerId],1,2,["Independent member review; machine failures remain authoritative."]);
    if (workflow!=="direct") stage("integration",[],0,0,["Local integration verification; workspace writes remain serial."]);
    if (input.limits.maxRetries) stage("retry_allowance",executorIds,0,input.limits.maxRetries*2,["Bounded repair allowance, a rule interval rather than a probability-weighted estimate."]);
    const fallback=fallbackAgentIds.filter(id=>byId.has(id)&&!executorIds.includes(id));
    if (input.limits.maxEscalations&&fallback.length) {
      const worst=[...fallback].sort((a,b)=>costOrder(byId.get(b)!,byId.get(a)!))[0]!;
      stage("escalation_allowance",[worst],0,input.limits.maxEscalations*2,["Only explicitly authorized fallback members; admission is checked again before a new attempt."]);
    }
    stage("summary",[],0,0,["Existing durable local summary; no hidden summarization model call."]);
    const total=(key:"lowAtomic"|"highAtomic")=>stages.every(s=>s[key]!==null)?String(stages.reduce((sum,s)=>sum+BigInt(s[key]!),0n)):null;
    const lowAtomic=total("lowAtomic"),highAtomic=total("highAtomic");
    const modelCalls={low:stages.reduce((n,s)=>n+s.lowCalls*s.agentIds.length,0),high:stages.reduce((n,s)=>n+s.highCalls*s.agentIds.length,0)};
    const exclusionReasons:string[]=[];
    if (input.preset!=="custom"&&workflow!=="direct"&&!machine) exclusionReasons.push("machine_verification_required_for_delegation");
    if (input.preset!=="custom"&&workflow==="team"&&(!complex||input.features.independentModuleCount<2)) exclusionReasons.push("independent_work_packages_not_established");
    if (input.features.risk==="sensitive"&&!machine) exclusionReasons.push("verification_required_for_risk");
    if (modelCalls.low>input.limits.maxTotalModelCalls) exclusionReasons.push("model_call_limit_insufficient");
    if (input.budget&&input.budget.mode!=="tracking_only"&&(highAtomic===null||BigInt(highAtomic)>BigInt(input.budget.limitAtomic))) exclusionReasons.push("workflow_budget_insufficient");
    const costedIds=[...new Set(stages.flatMap(stage=>stage.agentIds))];
    const costStatus=costedIds.every(id=>knownPrice(byId.get(id)!))?"known":highAtomic!==null?"reference_estimate":"unknown";
    const candidate:RouteCandidate={id:[workflow,managerId??"-",executorIds.join(","),reviewerId??"-"].join(":"),workflow,
      resolved:{kind:workflow==="direct"?"direct":"team",agentIds:ids},assignments:{managerId,executorIds,reviewerId},
      lowAtomic,highAtomic,currency:"USD",stages,priceSnapshotIds:[...new Set(costedIds.flatMap(id=>byId.get(id)!.price?[byId.get(id)!.price!.id]:[]))],modelCalls,
      reasonCodes:[...reasonCodes,"cold_start_rule_interval",...(costStatus!=="known"?["price_reference_or_unknown"]:[]),...(modelCalls.high>input.limits.maxTotalModelCalls?["call_budget_may_pause"]:[])],
      feasible:exclusionReasons.length===0,exclusionReasons,evidence:"rules_only",costStatus,...(fallbackOnly?{fallbackOnly:true}:{})};
    if (!candidates.some(c=>c.id===candidate.id)) candidates.push(candidate);
  };
  if (explicitSingle) {
    const id=input.lockedAgentIds[0]!;
    if(byId.has(id))make("direct",null,[id],null,["explicit_single_member"]);
  } else if (input.preset==="custom") {
    if (input.strategy==="team") {
      const managerId=input.managerId;
      const executors=input.lockedAgentIds.length?input.lockedAgentIds:input.customExecutorId?[input.customExecutorId]:input.allowedAgentIds;
      if (managerId&&byId.has(managerId)&&executors.every(id=>byId.has(id))) make("team",managerId,executors,input.reviewerId,["custom_assignment_preserved"]);
    } else {
      const id=input.lockedAgentIds[0]??input.customExecutorId??input.primaryAgentId;
      if(input.lockedAgentIds.length<=1&&byId.has(id))make("direct",null,[id],null,["custom_assignment_preserved"]);
    }
  } else {
    for(const member of ordered) make("direct",null,[member.agentId],null,[complex?"single_context_preserved":"single_sufficient"]);
    if(ordered.length>1&&manager){
      const worker=ordered.find(member=>member.agentId!==manager.agentId)!;
      if(complex)make("plan_execute",manager.agentId,[worker.agentId],null,["planning_for_multiple_modules","worker_selected_by_total_cost"]);
      const workerForReview=ordered[0]!,reviewer=byId.get(input.reviewerId??"") ?? ordered.find(member=>member.agentId!==workerForReview.agentId)!;
      if(reviewer.agentId!==workerForReview.agentId&&(complex||input.features.risk==="sensitive"))make("execute_review",null,[workerForReview.agentId],reviewer.agentId,["independent_review_required"]);
      if(complex&&input.features.independentModuleCount>=2){
        const workers=ordered.slice(0,Math.min(2,input.features.independentModuleCount)).map(member=>member.agentId);
        const independentReviewer=ordered.find(member=>!workers.includes(member.agentId));
        make("team",manager.agentId,workers,independentReviewer?.agentId??null,["independent_modules_detected","serial_workspace_writes","integration_verification_required"]);
      }
    }
  }
  for(const candidate of [...candidates]){
    if(candidate.workflow==="direct"&&input.preset!=="custom")continue;
    for(const fallback of fallbackAgentIds){
      if(!byId.has(fallback)||candidate.assignments.executorIds.includes(fallback)||candidate.assignments.reviewerId===fallback)continue;
      if(candidate.workflow==="plan_execute"&&candidate.assignments.managerId===fallback)continue;
      make(candidate.workflow,candidate.assignments.managerId,[fallback,...candidate.assignments.executorIds.slice(1)],candidate.assignments.reviewerId,[...candidate.reasonCodes,"fallback_only"],true);
    }
  }
  const priceRank=(c:RouteCandidate)=>c.costStatus==="known"?0:c.costStatus==="reference_estimate"?1:2;
  const compareCost=(a:RouteCandidate,b:RouteCandidate)=>priceRank(a)-priceRank(b)
    ||(a.highAtomic!==null&&b.highAtomic!==null&&a.highAtomic!==b.highAtomic?(BigInt(a.highAtomic)<BigInt(b.highAtomic)?-1:1):0)
    ||a.modelCalls.high-b.modelCalls.high||a.id.localeCompare(b.id);
  const preferred=(c:RouteCandidate)=>{
    if(input.preset==="quality")return c.workflow==="team"?0:c.workflow==="execute_review"?1:c.workflow==="plan_execute"?2:3;
    if(input.preset==="balanced"&&input.features.risk==="sensitive")return c.workflow==="execute_review"?0:c.workflow==="team"?1:c.workflow==="plan_execute"?2:3;
    if(input.preset==="balanced"&&complex)return c.workflow==="plan_execute"?0:c.workflow==="direct"?1:2;
    return 0;
  };
  const feasible=candidates.filter(c=>c.feasible&&(!c.fallbackOnly||c.id===input.selectedCandidateId)).sort((a,b)=>priceRank(a)-priceRank(b)||preferred(a)-preferred(b)||compareCost(a,b));
  const selected=input.selectedCandidateId?feasible.find(c=>c.id===input.selectedCandidateId)??null:feasible[0]??null;
  if(input.selectedCandidateId&&!selected)throw new Error("routing_candidate_unavailable");
  return {candidates,selected,selectedCandidateId:selected?.id??null,exclusions,
    allowedAgentIds:eligible.map(m=>m.agentId),fallbackAgentIds:fallbackAgentIds.filter(id=>byId.has(id)),
    reasonCodes:selected?[...selected.reasonCodes,...(input.selectedCandidateId?["candidate_selected_by_user"]:[])] : ["no_feasible_route",...new Set(candidates.flatMap(c=>c.exclusionReasons))]};
}
