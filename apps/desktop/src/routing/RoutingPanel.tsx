import type { AdaptiveAttempt, AdaptiveEvidenceHandoff, AdaptiveWorkflowView, RouteDecision } from "@socrates/core";
import { useT } from "../store";
import { ErrorNotice, LoadingState, StatusBadge } from "../foundation/components";
import { formatAtomic } from "../cost/ui-state";
import { RouteCandidateSummary, RouteReasons } from "./RoutePreviewControls";
import { useRoutingTask } from "./useRoutingTask";
import { routingMessage } from "./labels";
import "./routing.css";

export function RoutingHandoff({ handoff }: { handoff: AdaptiveEvidenceHandoff }) {
  const t = useT();
  return <div className="space-y-2">
    <p><strong>{t("route_objective")}</strong>: {handoff.objective}</p>
    <p>{t("route_failure_category")}: {t(`route_failure_${handoff.failureCategory}`)}</p>
    {handoff.diagnostics && <pre className="routing-code">{handoff.diagnostics}</pre>}
    <details><summary className="cursor-pointer">{t("route_evidence_refs")}</summary><div className="space-y-2 break-all">
      <dl className="verification-facts"><dt>{t("verify_failure")}</dt><dd><code>{handoff.failureSignature ?? "—"}</code></dd><dt>{t("verify_snapshot")}</dt><dd><code>{handoff.artifactSnapshotHash ?? "—"}</code></dd></dl>
      {handoff.evidenceRefs.length ? handoff.evidenceRefs.map(ref => <p key={ref}><code>{ref}</code></p>) : <p>{t("verify_no_evidence")}</p>}
      {!!handoff.constraints.length && <ul className="ml-4 list-disc">{handoff.constraints.map((constraint, index) => <li key={`${index}:${constraint}`}>{constraint}</li>)}</ul>}
      <p>{t("route_completed_attempts")}: {handoff.completedAttemptIds.join(", ") || "—"}</p>
    </div></details>
  </div>;
}

function Attempt({ attempt, decision }: { attempt: AdaptiveAttempt; decision: RouteDecision }) {
  const t = useT();
  const names = (ids: string[]) => ids.map(id => decision.members[id]?.profile.nickname ?? id).join(", ");
  return <details className="border-t border-neutral-200 pt-2" data-route-attempt={attempt.id}>
    <summary className="cursor-pointer">{t("route_attempt")} {attempt.ordinal} · {t(`route_attempt_${attempt.kind}`)} · {t(`route_status_${attempt.status}`)}</summary>
    <div className="mt-2 space-y-2">
      <p>{t(`route_workflow_${attempt.workflow}`)} · {t("route_executors")}: {names(attempt.assignments.executorIds)}</p>
      {attempt.assignments.managerId && <p>{t("route_manager")}: {names([attempt.assignments.managerId])}</p>}
      {attempt.assignments.reviewerId && <p>{t("route_reviewer")}: {names([attempt.assignments.reviewerId])}</p>}
      <p>{t("route_additional_cost")}: {formatAtomic(attempt.estimatedAdditionalCost.lowAtomic, attempt.estimatedAdditionalCost.currency)} – {formatAtomic(attempt.estimatedAdditionalCost.highAtomic, attempt.estimatedAdditionalCost.currency)}</p>
      {attempt.reason && <RouteReasons codes={[attempt.reason]} />}
      <dl className="verification-facts"><dt>{t("verify_started")}</dt><dd>{attempt.startedAt ?? "—"}</dd><dt>{t("verify_finished")}</dt><dd>{attempt.finishedAt ?? "—"}</dd><dt>{t("route_child")}</dt><dd><code>{attempt.child ? `${attempt.child.kind}:${attempt.child.id}` : "—"}</code></dd></dl>
      {attempt.handoff && <RoutingHandoff handoff={attempt.handoff} />}
      {attempt.failureSignature && <p className="break-all">{t("verify_failure")}: <code>{attempt.failureSignature}</code></p>}
    </div>
  </details>;
}

export function RoutingWorkflowView({ workflow, decision, busy = false, cancelling = false, disabled = false, stale = false, onAction }: {
  workflow: AdaptiveWorkflowView; decision: RouteDecision; busy?: boolean; cancelling?: boolean; disabled?: boolean; stale?: boolean;
  onAction: (path: string, body?: Record<string, unknown>) => void;
}) {
  const t = useT();
  const terminal = ["completed", "blocked", "failed", "cancelled"].includes(workflow.status);
  const resumable = ["awaiting_plan", "awaiting_verification", "paused_budget", "interrupted"].includes(workflow.status) && !workflow.pendingApproval;
  const approval = workflow.pendingApproval;
  const name = (id: string) => decision.members[id]?.profile.nickname ?? id;
  return <div className="space-y-3" data-routing-status={workflow.status}>
    <div className="flex flex-wrap gap-2"><StatusBadge tone={workflow.status === "completed" && workflow.outcome === "verified_success" && !stale ? "success" : workflow.status === "failed" ? "danger" : terminal || resumable || approval ? "warning" : "neutral"}>{t(`route_status_${workflow.status}`)}</StatusBadge><span>{t(`verify_${stale && workflow.outcome === "verified_success" ? "completed_unverified" : workflow.outcome === "failed" ? "execution_failed" : workflow.outcome}`)}</span></div>
    {workflow.reason && <RouteReasons codes={[workflow.reason]} />}
    <p>{t("route_maxRetries")}: {workflow.retries}/{workflow.limits.maxRetries} · {t("route_maxEscalations")}: {workflow.escalations}/{workflow.limits.maxEscalations} · {t("route_maxTotalModelCalls")}: {workflow.modelCalls}/{workflow.limits.maxTotalModelCalls}</p>
    {approval && <section className="pixel-approval-card space-y-3 p-3" aria-label={t("route_change_approval")}>
      <strong>{t("route_change_approval")}: {name(approval.fromAgentId)} → {name(approval.toAgentId)}</strong>
      <RouteReasons codes={[approval.reason]} />
      <p>{t("route_additional_cost")}: {formatAtomic(approval.estimatedAdditionalCost.lowAtomic, approval.estimatedAdditionalCost.currency)} – {formatAtomic(approval.estimatedAdditionalCost.highAtomic, approval.estimatedAdditionalCost.currency)}</p>
      <RoutingHandoff handoff={approval.handoff} />
      <div className="flex flex-wrap gap-2"><button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={busy || disabled} onClick={() => onAction(`/approvals/${encodeURIComponent(approval.id)}/decision`, { decision: "allow" })}>{t("route_approve_change")}</button><button type="button" className="pixel-button px-3 py-1" disabled={busy || disabled} onClick={() => onAction(`/approvals/${encodeURIComponent(approval.id)}/decision`, { decision: "deny" })}>{t("route_deny_change")}</button></div>
    </section>}
    <div className="flex flex-wrap gap-2">
      {resumable && <button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={busy || disabled} onClick={() => onAction(`/tasks/${encodeURIComponent(workflow.rootTaskId)}/resume`)}>{t("route_resume")}</button>}
      {!terminal && <button type="button" className="pixel-button px-3 py-1" disabled={cancelling} onClick={() => onAction(`/tasks/${encodeURIComponent(workflow.rootTaskId)}/cancel`)}>{t("route_cancel")}</button>}
    </div>
    {workflow.attempts.map(attempt => <Attempt key={attempt.id} attempt={attempt} decision={decision} />)}
  </div>;
}

export default function RoutingPanel(props: { roomId: string; rootTaskId: string; disabled?: boolean }) {
  return <Panel key={`${props.roomId}:${props.rootTaskId}`} {...props} />;
}

function Panel({ roomId, rootTaskId, disabled = false }: { roomId: string; rootTaskId: string; disabled?: boolean }) {
  const t = useT();
  const { value, error, stale, loading, busy, cancelling, mutate, refresh } = useRoutingTask(roomId, rootTaskId);
  if (!value && !error && !loading) return null;
  return <details className="pixel-card space-y-2 p-2 text-xs" data-routing-target={rootTaskId}>
    <summary className="cursor-pointer"><strong>{t("route_task_record")}</strong>{value?.workflow ? ` · ${t(`route_status_${value.workflow.status}`)}` : ""}</summary>
    <div className="routing-evidence space-y-3">
      {loading && !value && <LoadingState label={t("route_loading")} />}
      {error && <ErrorNotice message={`${t("route_read_failed")} ${routingMessage(t, error)}`} onRetry={refresh} retryLabel={t("verify_retry")} />}
      {value?.workflow && <RoutingWorkflowView workflow={value.workflow} decision={value.decision} busy={busy} cancelling={cancelling} disabled={disabled} stale={stale} onAction={(path, body) => void mutate(path, body)} />}
      {value && <details><summary className="cursor-pointer">{t("route_policy_record")} · {t(`route_${value.decision.preset}`)}</summary><div className="mt-2 space-y-3"><p>{value.decision.policyVersion}</p><p className="break-all">{value.decision.id} · {value.decision.bindingHash}</p><p>{t("route_rules_only")}</p>{value.decision.selected && <RouteCandidateSummary candidate={value.decision.selected} route={value.decision} />}</div></details>}
    </div>
  </details>;
}
