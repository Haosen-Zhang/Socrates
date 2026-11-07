import { useState } from "react";
import type { RouteCandidate, RoutePreview } from "@socrates/core";
import { useT } from "../store";
import { DetailPanel } from "../foundation/overlays";
import { StatusBadge } from "../foundation/components";
import { formatAtomic } from "../cost/ui-state";
import { routingMessage } from "./labels";
import "./routing.css";

export function RouteReasons({ codes }: { codes: string[] }) {
  const t = useT();
  return <ul className="ml-4 list-disc">{codes.map((code, index) => {
    return <li key={`${code}:${index}`}>{routingMessage(t, code)}</li>;
  })}</ul>;
}

export function RouteCandidateSummary({ candidate, route }: { candidate: RouteCandidate; route: RoutePreview }) {
  const t = useT();
  const name = (id: string) => route.members[id]?.profile.nickname ?? id;
  return <section className="space-y-2">
    <div className="flex flex-wrap items-center gap-2"><strong>{t(`route_workflow_${candidate.workflow}`)}</strong><StatusBadge tone={candidate.feasible ? "info" : "warning"}>{t(candidate.feasible ? "route_feasible" : "route_excluded")}</StatusBadge></div>
    <p>{formatAtomic(candidate.lowAtomic, candidate.currency)} – {formatAtomic(candidate.highAtomic, candidate.currency)} · {t(`route_cost_${candidate.costStatus}`)}</p>
    <dl className="verification-facts">
      {candidate.assignments.managerId && <><dt>{t("route_manager")}</dt><dd>{name(candidate.assignments.managerId)}</dd></>}
      <dt>{t("route_executors")}</dt><dd>{candidate.assignments.executorIds.map(name).join(", ")}</dd>
      {candidate.assignments.reviewerId && <><dt>{t("route_reviewer")}</dt><dd>{name(candidate.assignments.reviewerId)}</dd></>}
      <dt>{t("route_model_calls")}</dt><dd>{candidate.modelCalls.low} – {candidate.modelCalls.high}</dd>
    </dl>
    <RouteReasons codes={candidate.feasible ? candidate.reasonCodes : candidate.exclusionReasons} />
    <details><summary className="cursor-pointer">{t("route_cost_breakdown")}</summary><div className="mt-2 space-y-2">{candidate.stages.map((stage, index) => <div key={`${stage.stage}:${index}`}><strong>{t(`cost_stage_${stage.stage}`)}</strong> · {stage.agentIds.map(name).join(", ")} · {formatAtomic(stage.lowAtomic, candidate.currency)} – {formatAtomic(stage.highAtomic, candidate.currency)}<RouteReasons codes={stage.assumptions} /></div>)}</div></details>
  </section>;
}

export default function RoutePreviewControls({ route, candidateId, disabled = false, onCandidateChange }: {
  route: RoutePreview; candidateId?: string; disabled?: boolean; onCandidateChange: (id: string | undefined) => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className="pixel-button px-2 py-1" data-route-preview onClick={() => setOpen(true)}>{t("route_recommended")} · {route.selected ? t(`route_workflow_${route.selected.workflow}`) : t("route_no_feasible")}</button>
    <DetailPanel drawer open={open} title={t("route_recommended")} closeLabel={t("close")} onClose={() => setOpen(false)}>
      <div className="space-y-4 text-xs">
        <p>{t("route_rules_only")}</p>
        <p>{t("route_serial_workspace")}</p>
        <p><strong>{t("route_acceptance")}</strong>: {t(`route_verification_${route.features.verification}`)}</p>
        {route.verification.planId && <p className="break-all">{t("verify_plan")}: <code>{route.verification.planId}</code></p>}
        {!!route.lockedAgentIds.length && <p>{t("route_locked_members")}: {route.lockedAgentIds.map(id => route.members[id]?.profile.nickname ?? id).join(", ")}</p>}
        <RouteReasons codes={route.reasonCodes} />
        {route.candidates.filter(candidate => !candidate.fallbackOnly).map(candidate => <div key={candidate.id} className="pixel-card space-y-2 p-3" data-route-candidate={candidate.id}>
          <RouteCandidateSummary route={route} candidate={candidate} />
          <button type="button" className="pixel-button px-3 py-1" disabled={disabled || !candidate.feasible || candidateId === candidate.id} onClick={() => { onCandidateChange(candidate.id); setOpen(false); }}>{t(candidateId === candidate.id ? "route_selected" : "route_choose")}</button>
        </div>)}
        {!route.selected && <p role="alert">{t("route_no_feasible_hint")}</p>}
        {candidateId && <button type="button" className="pixel-button px-3 py-1" disabled={disabled} onClick={() => { onCandidateChange(undefined); setOpen(false); }}>{t("route_use_recommendation")}</button>}
        {!!route.exclusions.length && <details><summary className="cursor-pointer">{t("route_member_exclusions")}</summary><div className="mt-2 space-y-2">{route.exclusions.map(item => <div key={item.agentId}><strong>{route.members[item.agentId]?.profile.nickname ?? item.agentId}</strong><RouteReasons codes={item.reasonCodes} /></div>)}</div></details>}
        <details><summary className="cursor-pointer">{t("route_policy_record")}</summary><div className="mt-2 space-y-2"><p>{route.policyVersion}</p><code className="break-all">{route.bindingHash}</code><p>{t("route_maxRetries")}: {route.limits.maxRetries} · {t("route_maxEscalations")}: {route.limits.maxEscalations} · {t("route_maxTotalModelCalls")}: {route.limits.maxTotalModelCalls}</p></div></details>
      </div>
    </DetailPanel>
  </>;
}
