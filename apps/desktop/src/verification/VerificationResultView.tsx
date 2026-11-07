import { useEffect, useRef, useState } from "react";
import type { CheckEvidence, VerificationTarget, VerificationView } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { ErrorNotice, StatusBadge } from "../foundation/components";
import { verificationRequest } from "./client";
import { verificationSummary } from "./ui-state";

type OutputPage = { ref: string; text: string; byteSize: number; offset: number; nextOffset: number | null; truncated: boolean };
function EvidenceOutput({ evidence, target, stream }: { evidence: CheckEvidence; target: VerificationTarget; stream: "stdout" | "stderr" }) {
  const { handshake } = useStorePick("handshake");
  const t = useT();
  const [output, setOutput] = useState<OutputPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const ref = stream === "stdout" ? evidence.stdoutRef : evidence.stderrRef;
  if (!ref) return null;
  const load = async (offset = 0) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      const query = new URLSearchParams({ roomId: target.roomId, stream, offset: String(offset) });
      const value = await verificationRequest<OutputPage>(handshake, `/evidence/${encodeURIComponent(evidence.id)}/output?${query}`);
      if (live.current) setOutput(value);
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  return <details><summary className="cursor-pointer">{t(`verify_${stream}`)}</summary><div className="mt-2 space-y-2">
    <p className="break-all">{t("verify_output_ref")}: <code>{ref}</code></p>
    <button type="button" className="pixel-button px-2 py-1" disabled={busy} onClick={() => void load()}>{t(busy ? "verify_reading_output" : "verify_read_output")}</button>
    {output && <><pre className="verification-code max-h-52">{output.text || t("verify_output_empty")}</pre><p>{output.offset} / {output.byteSize} bytes</p>{typeof output.nextOffset === "number" && <button type="button" className="pixel-button px-2 py-1" disabled={busy} onClick={() => void load(output.nextOffset!)}>{t("verify_output_more")}</button>}</>}
    {error && <ErrorNotice message={t(error)} />}
  </div></details>;
}

function Evidence({ evidence, target, label }: { evidence: CheckEvidence; target: VerificationTarget; label: string }) {
  const t = useT();
  return <details className="border-t border-neutral-200 pt-2" data-verification-evidence={evidence.id}>
    <summary className="cursor-pointer"><strong>{label}</strong> · <StatusBadge tone={evidence.status === "failed" ? "danger" : evidence.status === "passed" ? "info" : "warning"}>{t(`verify_${evidence.status}`)}</StatusBadge> · {evidence.durationMs} ms</summary>
    <div className="mt-2 space-y-2">
      <p>{t(evidence.reason)}</p>
      {evidence.diagnostics && <pre className="verification-code">{evidence.diagnostics}</pre>}
      {evidence.command && <><pre className="verification-code">{JSON.stringify([evidence.command.executable, ...evidence.command.argv])}</pre><p>{t("verify_cwd")}: <code>{evidence.command.cwd}</code></p></>}
      <dl className="verification-facts">
        <dt>{t("verify_started")}</dt><dd><time dateTime={evidence.startedAt}>{evidence.startedAt}</time></dd>
        <dt>{t("verify_finished")}</dt><dd><time dateTime={evidence.finishedAt}>{evidence.finishedAt}</time></dd>
        <dt>{t("verify_exit")}</dt><dd>{evidence.exitCode ?? "—"}</dd><dt>{t("verify_signal")}</dt><dd>{evidence.signal ?? "—"}</dd>
        <dt>{t("verify_timeout")}</dt><dd>{evidence.timedOut ? t("verification_timeout") : "—"}</dd>
        <dt>{t("verify_snapshot")}</dt><dd><code>{evidence.artifactSnapshotHash}</code></dd>
        <dt>{t("verify_plan_hash")}</dt><dd><code>{evidence.planHash}</code></dd>
        <dt>{t("verify_operation")}</dt><dd><code>{evidence.operationId ?? "—"}</code></dd>
        <dt>{t("verify_runner")}</dt><dd>{evidence.runnerVersion}</dd>
      </dl>
      {evidence.counts && <p>{t("verify_test_counts", { ...evidence.counts })}</p>}
      {!!evidence.assertions?.length && <ul className="ml-4 list-disc">{evidence.assertions.map((assertion, index) => <li key={`${index}:${assertion.name}`}>{assertion.name}: {t(assertion.passed ? "verify_passed" : "verify_failed")}</li>)}</ul>}
      {evidence.baselineStatus && <p>{t("verify_baseline_result")}: {t(`verify_${evidence.baselineStatus}`)}</p>}
      {evidence.changedPaths.length > 0 && <p className="break-all">{t("verify_changed")}: {evidence.changedPaths.join(", ")}</p>}
      {evidence.failureSignature && <p className="break-all">{t("verify_failure")}: <code>{evidence.failureSignature}</code></p>}
      <details><summary className="cursor-pointer">{t("verify_environment")}</summary><pre className="verification-code">{Object.keys(evidence.environment).length ? JSON.stringify(evidence.environment, null, 2) : t("verify_environment_none")}</pre></details>
      <EvidenceOutput evidence={evidence} target={target} stream="stdout" /><EvidenceOutput evidence={evidence} target={target} stream="stderr" />
    </div>
  </details>;
}

export function VerificationStatusLine({ view, stale = false }: { view: VerificationView; stale?: boolean }) {
  const t = useT();
  const summary = verificationSummary(view);
  const baseline = view.run?.mode === "baseline";
  const verified = summary.verified && !stale;
  const state = baseline && view.run?.status === "running" && !view.run.finishedAt ? "running" : view.verificationStatus === "passed" && !verified ? baseline ? "pending" : "inconclusive" : view.verificationStatus;
  return <span className="inline-flex flex-wrap items-center gap-2" data-verification-status={state}>
    <StatusBadge tone={verified ? "success" : state === "failed" ? "danger" : ["inconclusive", "invalidated"].includes(state) ? "warning" : "neutral"}>{t(`verify_${state}`)}</StatusBadge>
    {view.plan && <span>{t("verify_required_count", { passed: summary.passed, total: summary.total })}</span>}
    {view.acceptedUnverified && <StatusBadge tone="warning">{t("verify_accepted")}</StatusBadge>}
  </span>;
}

export default function VerificationResultView({ view, stale = false }: { view: VerificationView; stale?: boolean }) {
  const t = useT();
  const summary = verificationSummary(view);
  const baseline = view.run?.mode === "baseline";
  return <section className="space-y-3" aria-label={t("verify_evidence")}>
    <VerificationStatusLine view={view} stale={stale} />
    <p>{t(stale ? "verify_load_failed" : summary.verified ? "verify_verified_success" : baseline ? "verify_baseline_hint" : view.outcome === "failed" ? "verify_execution_failed" : view.outcome === "verified_success" ? "verify_completed_unverified" : `verify_${view.outcome}`)}</p>
    {!!view.unverifiedPackageIds?.length && <p>{t("verify_unverified_packages", { count: view.unverifiedPackageIds.length })}</p>}
    {!view.plan && <p className="text-neutral-500">{t("verify_no_plan_hint")}</p>}
    {view.verificationStatus === "invalidated" && <p role="status">{t("verify_evidence_stale")}</p>}
    {view.run?.reason && <p>{t(view.run.reason)}</p>}
    {view.run && <dl className="verification-facts"><dt>{t(baseline ? "verify_baseline_result" : "verify_snapshot")}</dt><dd><code>{view.run.snapshot.hash}</code></dd><dt>{t("verify_scope")}</dt><dd>{view.run.snapshot.paths.join(", ")}</dd></dl>}
    {view.run?.evidence.length ? view.run.evidence.map(evidence => <Evidence key={evidence.id} evidence={evidence} target={view.target} label={view.plan?.checks.find(check => check.id === evidence.checkId)?.label ?? evidence.checkId} />) : <p className="text-neutral-500">{t("verify_no_evidence")}</p>}
  </section>;
}
