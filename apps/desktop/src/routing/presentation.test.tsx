import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { DEFAULT_COLLABORATION_SETTINGS, DEFAULT_ROUTE_LIMITS, UNKNOWN_MODEL_CAPABILITIES, type AdaptiveWorkflowView, type RouteDecision } from "@socrates/core";
import { RoutingWorkflowView } from "./RoutingPanel";
import { RouteCandidateSummary } from "./RoutePreviewControls";

function fixture(): { decision: RouteDecision; workflow: AdaptiveWorkflowView } {
  const member = (id: string) => ({ snapshot: {}, profile: { agentId: id, providerId: "provider", modelId: `model-${id}`, nickname: `Member ${id}`, role: "worker", systemPrompt: "", reasoningEffort: "auto" as const, modelCapabilities: { ...UNKNOWN_MODEL_CAPABILITIES }, contextWindowTokens: 100000, configurationVersion: "v1", overrides: {} }, provider: { id: "provider", type: "openai_compatible" as const, baseUrl: "https://fixture.invalid", protocol: "openai_chat_completions" }, price: null });
  const decision: RouteDecision = { id: "decision", rootTaskId: "root-task", quoteId: "quote", createdAt: "2026-11-08T00:00:00Z", roomId: "room", bindingHash: "frozen-binding", inputHash: "input", policyVersion: "deterministic_workflows/1", preset: "balanced", featuresHash: "features", metadataHash: "metadata", workspaceIdentity: "workspace", verification: { planId: "plan", planHash: "plan-hash", hasChecks: true }, members: { a: member("a"), b: member("b") }, allowedAgentIds: ["a", "b"], allowedProviderIds: ["provider"], lockedAgentIds: [], fallbackAgentIds: ["b"], limits: { ...DEFAULT_ROUTE_LIMITS }, collaboration: DEFAULT_COLLABORATION_SETTINGS, budget: null, candidates: [], selectedCandidateId: "direct-a", selected: null, exclusions: [], reasonCodes: ["single_sufficient"], features: { selectedPaths: ["result.txt"], fileCount: 1, modulePaths: [], independentModuleCount: 0, dependencyEdges: [], sharedStateCoupled: false, scripts: [], risk: "ordinary", riskReasons: [], verification: "machine", verificationCheckIds: ["file"], requiredCapabilities: { textInput: true, toolCalling: true, imageInput: false, fileInput: false }, inputTokensEstimate: 100, contextTokensRequired: 1000, scope: "local", evidence: "workspace_metadata", unknowns: [] } };
  const candidate = { id: "direct-a", workflow: "direct" as const, resolved: { kind: "direct" as const, agentIds: ["a"] }, assignments: { managerId: null, executorIds: ["a"], reviewerId: null }, lowAtomic: null, highAtomic: null, currency: "USD" as const, stages: [], priceSnapshotIds: [], modelCalls: { low: 1, high: 3 }, reasonCodes: ["single_sufficient"], feasible: true, exclusionReasons: [], evidence: "rules_only" as const, costStatus: "unknown" as const };
  decision.candidates = [candidate]; decision.selected = candidate;
  const workflow: AdaptiveWorkflowView = { rootTaskId: "root-task", roomId: "room", decisionId: "decision", version: "adaptive_workflow/1", preset: "balanced", workflow: "direct", status: "completed", outcome: "completed_unverified", reason: null, limits: { ...DEFAULT_ROUTE_LIMITS }, retries: 0, escalations: 0, modelCalls: 1, attempts: [], pendingApproval: null, createdAt: decision.createdAt, updatedAt: decision.createdAt, finishedAt: decision.createdAt };
  return { decision, workflow };
}

it("keeps successful execution separate from verified outcomes and stale reads", () => {
  const { decision, workflow } = fixture();
  expect(renderToStaticMarkup(<RoutingWorkflowView decision={decision} workflow={workflow} onAction={() => {}} />)).not.toContain('data-tone="success"');
  workflow.outcome = "verified_success";
  expect(renderToStaticMarkup(<RoutingWorkflowView decision={decision} workflow={workflow} onAction={() => {}} />)).toContain('data-tone="success"');
  expect(renderToStaticMarkup(<RoutingWorkflowView decision={decision} workflow={workflow} stale onAction={() => {}} />)).not.toContain('data-tone="success"');
});

it("presents real failed evidence and additional cost before offering a member change", () => {
  const { decision, workflow } = fixture(); workflow.status = "awaiting_approval"; workflow.finishedAt = null;
  workflow.pendingApproval = { id: "approval", rootTaskId: "root-task", attemptId: "attempt-2", fromAgentId: "a", toAgentId: "b", reason: "routing_authorized_fallback", status: "pending", estimatedAdditionalCost: { lowAtomic: "1000000000", highAtomic: "3000000000", currency: "USD" }, handoff: { objective: "Produce result.txt", constraints: ["Stay in the permitted workspace"], completedAttemptIds: ["attempt-1"], failureCategory: "verification", failureSignature: "failure-sha", artifactSnapshotHash: "artifact-sha", evidenceRefs: ["evidence:run-1:file"], diagnostics: "Actual file assertion failed" }, createdAt: decision.createdAt, decidedAt: null };
  const html = renderToStaticMarkup(<RoutingWorkflowView decision={decision} workflow={workflow} onAction={() => {}} />);
  expect(html).toContain("Member a"); expect(html).toContain("Member b");
  expect(html).toContain("USD 0.001"); expect(html).toContain("USD 0.003");
  expect(html).toContain("Actual file assertion failed"); expect(html).toContain("evidence:run-1:file");
  expect(html).toContain("artifact-sha");
  expect(html.match(/<button/g)).toHaveLength(3); // approve, deny, cancel; never implicit resume.
});

it("allows cancellation during an in-flight resume without exposing terminal retry loops", () => {
  const { decision, workflow } = fixture(); workflow.status = "running"; workflow.finishedAt = null;
  const html = renderToStaticMarkup(<RoutingWorkflowView decision={decision} workflow={workflow} busy onAction={() => {}} />);
  expect(html.match(/<button/g)).toHaveLength(1); expect(html).not.toContain('disabled=""');
  workflow.status = "blocked";
  expect(renderToStaticMarkup(<RoutingWorkflowView decision={decision} workflow={workflow} onAction={() => {}} />)).not.toContain("<button");
});

it("does not turn unknown candidate prices into zero costs or claim savings", () => {
  const { decision } = fixture();
  const html = renderToStaticMarkup(<RouteCandidateSummary candidate={decision.selected!} route={decision} />);
  expect(html).not.toContain("USD 0.00"); expect(html).not.toContain("%");
  expect(html).toContain("Member a");
});
