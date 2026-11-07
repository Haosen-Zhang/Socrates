import { useEffect, useRef, useState } from "react";
import type { VerificationPlan } from "@socrates/core";
import { useT } from "../store";
import { useStorePick } from "../selectors";
import { ErrorNotice } from "../foundation/components";
import { DetailPanel } from "../foundation/overlays";
import VerificationPlanEditor from "./VerificationPlanEditor";
import VerificationPlanSummary from "./VerificationPlanSummary";
import VerificationResultView from "./VerificationResultView";
import VerificationActions from "./VerificationActions";
import { useVerification } from "./useVerification";
import { verificationRequest } from "./client";
import "./verification.css";

export type VerificationControlsProps = { roomId: string; disabled?: boolean; onPlanChange: (planId: string | undefined) => void };

export default function VerificationControls(props: VerificationControlsProps) {
  return <Controls key={props.roomId} {...props} />;
}

function Controls({ roomId, disabled = false, onPlanChange }: VerificationControlsProps) {
  const t = useT();
  const { handshake } = useStorePick("handshake");
  const [plan, setPlan] = useState<VerificationPlan | null>(null);
  const [editing, setEditing] = useState(false);
  const [open, setOpen] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const selection = useRef(onPlanChange); selection.current = onPlanChange;
  const storageKey = `socrates.verification-plan.v1:${roomId}`;
  const remember = (value: VerificationPlan | null) => {
    setPlan(value);
    try { if (value) localStorage.setItem(storageKey, value.id); else localStorage.removeItem(storageKey); } catch { /* The plan itself remains in SQLite. */ }
  };
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage.getItem(storageKey); } catch { /* Storage may be disabled. */ }
    if (!saved || !handshake) return;
    let active = true; const controller = new AbortController();
    setRestoring(true); setRestoreError(null); selection.current(undefined);
    void verificationRequest<VerificationPlan>(handshake, `/plans/${encodeURIComponent(saved)}`, undefined, controller.signal)
      .then(value => {
        if (!active) return;
        if (value.target.roomId !== roomId || !value.target.rootTaskId.startsWith("draft:") || value.target.workPackageId) throw new Error("verification_plan_changed");
        setPlan(value); selection.current(value.approvalStatus === "approved" ? value.id : undefined);
      })
      .catch(cause => { if (active && !controller.signal.aborted) setRestoreError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; controller.abort(); };
  }, [handshake, roomId, storageKey, restoreRevision]);
  const { view, busy, cancelling, stale, error, mutate, refresh } = useVerification(plan?.target ?? null);
  const approve = async () => {
    if (!plan) return;
    const value = await mutate<VerificationPlan>(`/plans/${encodeURIComponent(plan.id)}/approve`, {});
    if (value) { remember(value); onPlanChange(value.approvalStatus === "approved" ? value.id : undefined); }
  };
  const edit = () => { onPlanChange(undefined); setEditing(true); };
  return <div className="verification-controls text-xs" data-verification-controls>
    <button type="button" className="pixel-button px-2 py-1" aria-expanded={open} onClick={() => setOpen(true)}>{t("verify_title")} · {t(restoring ? "verify_loading" : !plan || editing ? "verify_none" : plan.approvalStatus === "approved" ? "verify_approved" : "verify_proposed")}</button>
    <DetailPanel open={open} drawer title={t("verify_plan")} closeLabel={t("close")} onClose={() => setOpen(false)}>
    <div className="space-y-3 text-xs">
      {editing ? <VerificationPlanEditor roomId={roomId} initialPlan={plan} disabled={disabled} onSaved={value => { remember(value); setEditing(false); onPlanChange(undefined); refresh(); }} onCancel={() => { setEditing(false); onPlanChange(plan?.approvalStatus === "approved" ? plan.id : undefined); }} /> : <>
        {plan ? <><VerificationPlanSummary plan={plan} /><p className="text-neutral-500">{t("verify_approval_hint")}</p><div className="flex flex-wrap gap-2">
          {plan.approvalStatus === "proposed" && <button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={disabled || busy} onClick={() => void approve()}>{t("verify_approve")}</button>}
          <button type="button" className="pixel-button px-3 py-1" disabled={disabled || busy} onClick={edit}>{t("verify_edit")}</button>
          <button type="button" className="pixel-button px-3 py-1" disabled={disabled || busy} onClick={() => { onPlanChange(undefined); remember(null); }}>{t("verify_remove")}</button>
        </div>{plan.approvalStatus === "approved" && <p>{t("verify_plan_selected")}</p>}
        {view && <><VerificationActions view={view} baselineOnly busy={busy} cancelling={cancelling} disabled={disabled} onAction={(path, body) => { void mutate(path, body); }} />{view.run && <VerificationResultView view={view} stale={stale} />}</>}
        </> : <><p>{t("verify_no_plan_hint")}</p><button type="button" className="pixel-button px-3 py-1" disabled={disabled || restoring} onClick={edit}>{t("verify_configure")}</button></>}
      </>}
      {error && <ErrorNotice message={t(error)} onRetry={refresh} retryLabel={t("verify_retry")} />}
      {restoreError && <ErrorNotice message={t(restoreError)} onRetry={() => setRestoreRevision(value => value + 1)} retryLabel={t("verify_retry")} />}
    </div>
    </DetailPanel>
  </div>;
}
