import type { VerificationView } from "@socrates/core";
import { useT } from "../store";

export default function VerificationActions({ view, busy, cancelling = false, disabled = false, onAction, baselineOnly = false, onAccept }: {
  view: VerificationView; busy: boolean; cancelling?: boolean; disabled?: boolean; baselineOnly?: boolean;
  onAction: (path: string, body: Record<string, unknown>) => void;
  onAccept?: () => void;
}) {
  const t = useT();
  const running = ["pending", "running"].includes(view.run?.status ?? "") && !view.run?.finishedAt;
  return <div className="space-y-3">
    {view.run?.pendingApprovals.map(approval => <section key={approval.id} className="pixel-approval-card space-y-2 p-3" aria-label={t("verify_permission")}>
      <strong>{t("verify_permission")}: {view.plan?.checks.find(check => check.id === approval.checkId)?.label ?? approval.checkId}</strong>
      <pre className="verification-code">{JSON.stringify([approval.command.executable, ...approval.command.argv])}</pre>
      <p>{t("verify_cwd")}: <code>{approval.command.cwd ?? "."}</code> · {t("verify_timeout")}: {(approval.command.timeoutMs ?? 120000) / 1000}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={busy || disabled} onClick={() => onAction(`/approvals/${encodeURIComponent(approval.id)}/decision`, { decision: "allow_once" })}>{t("verify_allow_once")}</button><button type="button" className="pixel-button px-3 py-1" disabled={busy || disabled} onClick={() => onAction(`/approvals/${encodeURIComponent(approval.id)}/decision`, { decision: "deny" })}>{t("verify_deny")}</button></div>
    </section>)}
    <div className="flex flex-wrap gap-2">
      {view.plan?.approvalStatus === "approved" && !running && <button type="button" className="pixel-button pixel-button--primary px-3 py-1" disabled={busy || disabled} onClick={() => onAction(baselineOnly ? `/plans/${encodeURIComponent(view.plan!.id)}/baseline` : "/run", baselineOnly ? {} : { target: view.target })}>{t(baselineOnly ? "verify_baseline" : view.run ? "verify_rerun" : "verify_run")}</button>}
      {running && <button type="button" className="pixel-button px-3 py-1" disabled={cancelling} onClick={() => onAction("/cancel", { target: view.target })}>{t("verify_stop")}</button>}
      {!baselineOnly && !running && view.plan?.approvalStatus === "approved" && view.verificationStatus !== "passed" && !view.acceptedUnverified && onAccept && <button type="button" className="pixel-button px-3 py-1" disabled={busy || disabled} onClick={onAccept}>{t("verify_accept")}</button>}
    </div>
  </div>;
}
