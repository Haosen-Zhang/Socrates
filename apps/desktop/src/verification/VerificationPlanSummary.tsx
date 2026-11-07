import type { VerificationCheck, VerificationPlan } from "@socrates/core";
import { useT } from "../store";
import { StatusBadge } from "../foundation/components";

export function CheckDefinition({ check }: { check: VerificationCheck }) {
  const t = useT();
  return <div className="space-y-1">
    <div className="flex flex-wrap items-center gap-2"><strong>{check.label}</strong><StatusBadge>{t(check.required ? "verify_required" : "verify_optional")}</StatusBadge><span>{t(`verify_${check.origin ?? "user"}`)}</span></div>
    {check.kind === "command" ? <>
      <pre className="verification-code">{JSON.stringify([check.command.executable, ...check.command.argv])}</pre>
      <p>{t("verify_cwd")}: <code>{check.command.cwd ?? "."}</code> · {t("verify_timeout")}: {(check.command.timeoutMs ?? 120000) / 1000} · {t("verify_category")}: {t(`verify_${check.category}`)}</p>
      {check.category === "test" && <p>{t("verify_parser")}: {check.parser} · minTests: {check.minTests ?? 1}</p>}
      {check.reportPath && <p className="break-all"><code>{check.reportPath}</code> · {t("verification_report_provenance_unavailable")}</p>}
    </> : <>
      <code className="break-all">{check.path}</code>
      {check.kind === "file" && <p>{check.minBytes ?? 1} bytes{check.contains ? ` · ${t("verify_contains")}: ${check.contains}` : ""}{check.expectedSha256 ? ` · SHA-256: ${check.expectedSha256}` : ""}</p>}
      {check.kind === "json_schema" && <pre className="verification-code">{JSON.stringify(check.schema, null, 2)}</pre>}
    </>}
    {!!check.definitionPaths?.length && <p className="break-all">{t("verify_definition_paths")}: {check.definitionPaths.join(", ")}</p>}
  </div>;
}

export default function VerificationPlanSummary({ plan }: { plan: VerificationPlan }) {
  const t = useT();
  return <section className="space-y-3" aria-label={t("verify_plan")}>
    <p>{t("verify_plan_version")}: {plan.version} · <StatusBadge tone={plan.approvalStatus === "approved" ? "info" : "warning"}>{t(plan.approvalStatus === "approved" ? "verify_approved" : "verify_proposed")}</StatusBadge></p>
    <dl className="verification-facts"><dt>{t("verify_plan_hash")}</dt><dd><code>{plan.hash}</code></dd><dt>{t("verify_snapshot")}</dt><dd><code>{plan.baselineSnapshot.hash}</code></dd><dt>{t("verify_scope")}</dt><dd>{plan.artifactPaths.join(", ")}</dd><dt>{t("verify_protected_paths")}</dt><dd>{plan.protectedPaths.join(", ") || "—"}</dd></dl>
    <ol className="space-y-3">{plan.checks.map(check => <li key={check.id} className="border-t border-neutral-200 pt-2"><CheckDefinition check={check} /></li>)}</ol>
    {plan.manualJudgment.length > 0 && <div><strong>{t("verify_manual")}</strong><ul className="ml-4 list-disc">{plan.manualJudgment.map((condition, index) => <li key={`${index}:${condition}`}>{condition}</li>)}</ul></div>}
  </section>;
}
