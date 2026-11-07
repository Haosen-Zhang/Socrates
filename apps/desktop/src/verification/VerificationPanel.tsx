import { useState } from "react";
import type { VerificationPlan, VerificationTarget } from "@socrates/core";
import { useT } from "../store";
import { ErrorNotice, LoadingState } from "../foundation/components";
import { ConfirmationDialog } from "../foundation/overlays";
import VerificationPlanEditor from "./VerificationPlanEditor";
import VerificationPlanSummary from "./VerificationPlanSummary";
import VerificationResultView, { VerificationStatusLine } from "./VerificationResultView";
import VerificationActions from "./VerificationActions";
import { useVerification } from "./useVerification";
import "./verification.css";

export type VerificationPanelProps = VerificationTarget & { disabled?: boolean };
export default function VerificationPanel(props: VerificationPanelProps) {
  return <Panel key={`${props.roomId}:${props.rootTaskId}:${props.workPackageId ?? ""}`} {...props} />;
}

function Panel({ roomId, rootTaskId, workPackageId, disabled = false }: VerificationPanelProps) {
  const t = useT();
  const target = { roomId, rootTaskId, ...(workPackageId ? { workPackageId } : {}) };
  const { view, error, stale, loading, busy, cancelling, mutate, refresh } = useVerification(target);
  const [editing, setEditing] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const approve = async (plan: VerificationPlan) => { await mutate(`/plans/${encodeURIComponent(plan.id)}/approve`, {}); };
  return <details className="verification-panel space-y-2 text-xs" data-verification-target={rootTaskId}>
    <summary className="cursor-pointer"><strong>{t("verify_title")}</strong>{view ? <> · <VerificationStatusLine view={view} stale={stale} /></> : loading ? ` · ${t("verify_loading")}` : ""}</summary>
    <div className="verification-scroll space-y-3">
      {error && <ErrorNotice message={`${t("verify_load_failed")} ${t(error)}`} onRetry={refresh} retryLabel={t("verify_retry")} />}
      {loading && !view && <LoadingState label={t("verify_loading")} />}
      {editing ? <VerificationPlanEditor roomId={roomId} target={target} initialPlan={view?.plan} disabled={disabled} onSaved={() => { setEditing(false); refresh(); }} onCancel={() => setEditing(false)} /> : view && <>
        <VerificationResultView view={view} stale={stale} />
        {view.plan && <details><summary className="cursor-pointer">{t("verify_plan")} · {view.plan.version}</summary><div className="mt-2"><VerificationPlanSummary plan={view.plan} /></div></details>}
        {view.plan?.approvalStatus === "proposed" && <><p>{t("verify_approval_hint")}</p><button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={disabled || busy} onClick={() => void approve(view.plan!)}>{t("verify_approve")}</button></>}
        <VerificationActions view={view} busy={busy} cancelling={cancelling} disabled={disabled} onAction={(path, body) => { void mutate(path, body); }} onAccept={() => setAccepting(true)} />
        <button type="button" className="pixel-button px-3 py-1" disabled={disabled || busy || view.verificationStatus === "running" || Boolean(view.run?.pendingApprovals.length)} onClick={() => setEditing(true)}>{t(view.plan ? "verify_edit" : "verify_configure")}</button>
      </>}
    </div>
    <ConfirmationDialog open={accepting} onOpenChange={setAccepting} title={t("verify_accept_title")} description={t("verify_accept_hint")} confirmLabel={t("verify_accept_confirmation")} cancelLabel={t("verify_cancel")} pending={busy} error={error ? t(error) : null} onConfirm={async () => { if (await mutate("/accept", { target })) setAccepting(false); }} />
  </details>;
}
