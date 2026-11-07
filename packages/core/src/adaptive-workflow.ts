import type { RouteCandidate, RouteLimits, RouteWorkflow, RoutingPreset } from "./routing";
import type { TaskOutcome } from "./verification";

export const ADAPTIVE_WORKFLOW_VERSION = "adaptive_workflow/1";
export type AdaptiveWorkflowStatus = "pending" | "running" | "assessing" | "awaiting_approval" | "awaiting_plan" | "awaiting_verification" | "paused_budget" | "interrupted" | "completed" | "blocked" | "failed" | "cancelled";
export type AdaptiveFailureCategory = "verification" | "model_output" | "authentication" | "environment" | "permission" | "network" | "rate_limit" | "outcome_unknown" | "cancelled" | "unknown";
export interface AdaptiveChildRef { kind: "single" | "team"; id: string }
export interface AdaptiveCost { lowAtomic: string | null; highAtomic: string | null; currency: "USD" }
export interface AdaptiveEvidenceHandoff {
  objective: string;
  constraints: string[];
  completedAttemptIds: string[];
  failureCategory: AdaptiveFailureCategory;
  failureSignature: string | null;
  artifactSnapshotHash: string | null;
  evidenceRefs: string[];
  diagnostics: string;
}
export interface AdaptiveAttempt {
  id: string; rootTaskId: string; ordinal: number;
  clientTurnKey: string; decisionId: string;
  candidateId: string;
  kind: "initial" | "repair" | "escalation";
  workflow: RouteWorkflow;
  assignments: RouteCandidate["assignments"];
  status: "pending" | "dispatching" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  child: AdaptiveChildRef | null;
  handoff: AdaptiveEvidenceHandoff | null;
  estimatedAdditionalCost: AdaptiveCost;
  failureCategory?: AdaptiveFailureCategory;
  failureSignature?: string | null;
  artifactSnapshotHash?: string | null;
  evidenceRefs?: string[];
  result?: string;
  reason?: string;
  createdAt: string; startedAt: string | null; finishedAt: string | null;
}
export interface AdaptiveEscalationApproval {
  id: string; rootTaskId: string; attemptId: string;
  fromAgentId: string; toAgentId: string;
  reason: string; status: "pending" | "allowed" | "denied";
  estimatedAdditionalCost: AdaptiveCost;
  handoff: AdaptiveEvidenceHandoff;
  createdAt: string; decidedAt: string | null;
}
export interface AdaptiveWorkflowView {
  rootTaskId: string; roomId: string; decisionId: string;
  version: typeof ADAPTIVE_WORKFLOW_VERSION;
  preset: RoutingPreset; workflow: RouteWorkflow;
  status: AdaptiveWorkflowStatus; outcome: TaskOutcome;
  reason: string | null;
  limits: RouteLimits;
  retries: number; escalations: number; modelCalls: number;
  attempts: AdaptiveAttempt[];
  pendingApproval: AdaptiveEscalationApproval | null;
  createdAt: string; updatedAt: string; finishedAt: string | null;
}

/** Reasons come from host/verification facts, never a model confidence score. */
export function classifyRoutingFailure(reason: string, explicit?: AdaptiveFailureCategory): AdaptiveFailureCategory {
  if (explicit) return explicit;
  if (/outcome_unknown|remote_unknown|dispatch_outcome_unknown|requires_reconciliation/u.test(reason)) return "outcome_unknown";
  if (/unauthori[sz]ed|authentication|api_key|credential|(?:^|\D)401(?:\D|$)|(?:^|\D)403(?:\D|$)/iu.test(reason)) return "authentication";
  if (/permission|approval_denied|validation_contract_changed|scope_|egress/u.test(reason)) return "permission";
  if (/environment|sandbox|executable_unavailable|verification_timeout|report_(?:invalid|unavailable|provenance)|parser_unavailable|schema_unsupported|no_tests|manual_judgment|independent_acceptance|snapshot_unavailable/u.test(reason)) return "environment";
  if (/rate_limit|(?:^|\D)429(?:\D|$)/iu.test(reason)) return "rate_limit";
  if (/network|ECONN|ENOTFOUND|ETIMEDOUT|provider_timeout/iu.test(reason)) return "network";
  if (/cancelled|canceled/u.test(reason)) return "cancelled";
  if (/verification|check_failed|assertion_failed|nonzero_exit|test_failures/u.test(reason)) return "verification";
  if (/structured_plan|invalid_json|invalid_output|model_output/u.test(reason)) return "model_output";
  return "unknown";
}

export function decideRouteRecovery(input: {
  category: AdaptiveFailureCategory; failureSignature: string | null; artifactSnapshotHash: string | null;
  previous: Array<{ failureSignature?: string | null; artifactSnapshotHash?: string | null }>;
  limits: RouteLimits; retries: number; escalations: number; modelCalls: number; fallbackAgentIds: string[];
}): { action: "repair" | "escalate" | "stop"; reason: string; agentId?: string } {
  if (input.modelCalls >= input.limits.maxTotalModelCalls) return { action: "stop", reason: "routing_model_call_limit" };
  if (!["verification", "model_output"].includes(input.category)) return { action: "stop", reason: `routing_${input.category}_requires_attention` };
  if (input.failureSignature && input.previous.some(prior => prior.failureSignature === input.failureSignature && (prior.artifactSnapshotHash ?? null) === input.artifactSnapshotHash)) {
    return { action: "stop", reason: "routing_repeated_failure_without_change" };
  }
  if (input.retries < input.limits.maxRetries) return { action: "repair", reason: "routing_evidence_bounded_repair" };
  if (input.escalations < input.limits.maxEscalations && input.fallbackAgentIds.length) return { action: "escalate", reason: "routing_authorized_fallback", agentId: input.fallbackAgentIds[0] };
  return { action: "stop", reason: input.escalations >= input.limits.maxEscalations ? "routing_escalation_limit" : "routing_no_authorized_fallback" };
}
