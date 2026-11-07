import { useEffect, useRef, useState } from "react";
import type { VerificationCheck, VerificationPlan, VerificationSuggestions, VerificationTarget } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { ErrorNotice, LoadingState } from "../foundation/components";
import { VerificationRequests, verificationRequest } from "./client";
import { buildCheck, emptyCheckDraft, parsePaths, type CheckDraft } from "./ui-state";
import { CheckDefinition } from "./VerificationPlanSummary";

export default function VerificationPlanEditor({ roomId, target, initialPlan, disabled = false, onSaved, onCancel }: {
  roomId: string; target?: VerificationTarget; initialPlan?: VerificationPlan | null; disabled?: boolean;
  onSaved: (plan: VerificationPlan) => void; onCancel: () => void;
}) {
  const t = useT();
  const { handshake } = useStorePick("handshake");
  const [checks, setChecks] = useState<VerificationCheck[]>(initialPlan?.checks ?? []);
  const [paths, setPaths] = useState(initialPlan?.artifactPaths.join("\n") ?? "");
  const [protectedPaths, setProtectedPaths] = useState(initialPlan?.protectedPaths.join("\n") ?? "");
  const [manual, setManual] = useState(initialPlan?.manualJudgment.join("\n") ?? "");
  const [draft, setDraft] = useState(emptyCheckDraft);
  const [suggestions, setSuggestions] = useState<VerificationSuggestions | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestionError, setSuggestionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const pending = useRef(false);
  const live = useRef(true);
  const requests = useRef(new VerificationRequests());
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setLoading(true); setSuggestionError(null);
    void verificationRequest<VerificationSuggestions>(handshake, `/rooms/${encodeURIComponent(roomId)}/suggestions`, undefined, controller.signal)
      .then(value => { if (active) setSuggestions(value); })
      .catch(cause => { if (active && !controller.signal.aborted) setSuggestionError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [handshake, roomId, revision]);
  const update = <K extends keyof CheckDraft>(key: K, value: CheckDraft[K]) => setDraft(current => ({ ...current, [key]: value }));
  const add = () => {
    try {
      const check = buildCheck(draft, crypto.randomUUID());
      setChecks(current => [...current, check]);
      if (check.kind !== "command") setPaths(current => [...new Set([...parsePaths(current), check.path])].join("\n"));
      setProtectedPaths(current => [...new Set([...parsePaths(current), ...check.definitionPaths ?? []])].join("\n"));
      setDraft(emptyCheckDraft()); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  };
  const addSuggestions = () => {
    if (!suggestions) return;
    setChecks(current => [...current, ...suggestions.checks.filter(check => !current.some(existing => existing.id === check.id))]);
    setPaths(current => [...new Set([...parsePaths(current), ...suggestions.artifactPaths])].join("\n"));
    setProtectedPaths(current => [...new Set([...parsePaths(current), ...suggestions.protectedPaths])].join("\n"));
    setManual(current => [...new Set([...parsePaths(current), ...suggestions.manualJudgment])].join("\n"));
  };
  const save = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (!checks.length) throw new Error("verification_checks_required");
      const artifactPaths = parsePaths(paths);
      if (!artifactPaths.length) throw new Error("verification_artifacts_required");
      const boundTarget = target ?? initialPlan?.target;
      const value = await requests.current.mutate<VerificationPlan>(handshake, "/plans", {
        roomId, ...(boundTarget ? { rootTaskId: boundTarget.rootTaskId, ...(boundTarget.workPackageId ? { workPackageId: boundTarget.workPackageId } : {}) } : {}),
        checks, artifactPaths, protectedPaths: parsePaths(protectedPaths), manualJudgment: parsePaths(manual), source: "user",
      });
      if (live.current) onSaved(value);
    } catch (cause) { if (live.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; if (live.current) setBusy(false); }
  };
  return <section className="verification-editor space-y-3" aria-label={t("verify_configure")}>
    <fieldset disabled={busy || disabled} className="min-w-0 space-y-3">
      <div className="space-y-2"><strong>{t("verify_suggestions")}</strong><p className="text-neutral-500">{t("verify_suggestions_hint")}</p>
        {loading ? <LoadingState label={t("verify_loading")} /> : suggestions?.checks.length ? <button type="button" className="pixel-button px-3 py-1" onClick={addSuggestions}>{t("verify_use_suggestions")} ({suggestions.checks.length})</button> : <p>{t("verify_no_suggestions")}</p>}
        {!!suggestions?.unsupported.length && <p>{t("verify_unavailable")}: {suggestions.unsupported.join(", ")}</p>}
        {suggestionError && <ErrorNotice message={t(suggestionError)} onRetry={() => setRevision(value => value + 1)} retryLabel={t("verify_retry")} />}
      </div>
      {checks.length > 0 && <ol className="space-y-3">{checks.map(check => <li key={check.id} className="space-y-2 border-t border-neutral-200 pt-2"><CheckDefinition check={check} /><button type="button" className="pixel-button px-2 py-1" aria-label={`${t("verify_remove_check")}: ${check.label}`} onClick={() => setChecks(current => current.filter(item => item.id !== check.id))}>{t("verify_remove_check")}</button></li>)}</ol>}
      <div className="verification-form-grid">
        <label>{t("verify_kind")}<select className="pixel-input" value={draft.kind} onChange={event => update("kind", event.target.value as CheckDraft["kind"])}><option value="file">{t("verify_file")}</option><option value="json_schema">{t("verify_json_schema")}</option><option value="command">{t("verify_command")}</option></select></label>
        <label>{t("verify_check_label")}<input className="pixel-input" value={draft.label} onChange={event => update("label", event.target.value)} /></label>
        {draft.kind === "command" ? <>
          <label>{t("verify_category")}<select className="pixel-input" value={draft.category} onChange={event => update("category", event.target.value as CheckDraft["category"])}>{["test", "typecheck", "build", "lint"].map(value => <option key={value} value={value}>{t(`verify_${value}`)}</option>)}</select></label>
          <label>{t("verify_executable")}<input className="pixel-input" value={draft.executable} onChange={event => update("executable", event.target.value)} /></label>
          <label className="verification-form-wide">{t("verify_argv")}<textarea className="pixel-input" rows={2} value={draft.argv} onChange={event => update("argv", event.target.value)} /></label>
          <label>{t("verify_cwd")}<input className="pixel-input" value={draft.cwd} onChange={event => update("cwd", event.target.value)} /></label>
          <label>{t("verify_timeout")}<input className="pixel-input" type="number" min={1} max={120} value={draft.timeoutSeconds} onChange={event => update("timeoutSeconds", event.target.value)} /></label>
          {draft.category === "test" && <label>{t("verify_parser")}<select className="pixel-input" value={draft.parser} onChange={event => update("parser", event.target.value as CheckDraft["parser"])}><option value="bun_test">{t("verify_bun_test")}</option><option value="tap">{t("verify_tap")}</option></select></label>}
        </> : <>
          <label className="verification-form-wide">{t("verify_path")}<input className="pixel-input" value={draft.path} onChange={event => update("path", event.target.value)} /></label>
          {draft.kind === "file" ? <label className="verification-form-wide">{t("verify_contains")}<input className="pixel-input" value={draft.contains} onChange={event => update("contains", event.target.value)} /></label> : <label className="verification-form-wide">{t("verify_schema")}<textarea className="pixel-input" rows={4} value={draft.schema} onChange={event => update("schema", event.target.value)} /></label>}
        </>}
        <label className="verification-form-wide">{t("verify_definition_paths")}<textarea className="pixel-input" rows={2} value={draft.definitionPaths} onChange={event => update("definitionPaths", event.target.value)} /></label>
      </div>
      <label className="flex items-center gap-2"><input type="checkbox" checked={draft.required} onChange={event => update("required", event.target.checked)} />{t("verify_required")}</label>
      <button type="button" className="pixel-button px-3 py-1" onClick={add}>{t("verify_add_check")}</button>
      <div className="verification-form-grid">
        <label className="verification-form-wide">{t("verify_artifact_paths")}<textarea className="pixel-input" rows={2} value={paths} onChange={event => setPaths(event.target.value)} /></label>
        <label className="verification-form-wide">{t("verify_protected_paths")}<textarea className="pixel-input" rows={2} value={protectedPaths} onChange={event => setProtectedPaths(event.target.value)} /></label>
        <label className="verification-form-wide">{t("verify_manual")}<textarea className="pixel-input" rows={2} value={manual} onChange={event => setManual(event.target.value)} /></label>
      </div>
      <p className="text-neutral-500">{t("verify_manual_hint")}</p>
      <div className="flex flex-wrap gap-2"><button type="button" className="pixel-button pixel-button--primary px-3 py-1" onClick={() => void save()} disabled={!checks.length}>{t("verify_save")}</button><button type="button" className="pixel-button px-3 py-1" onClick={onCancel}>{t("verify_cancel_edit")}</button></div>
    </fieldset>
    {error && <ErrorNotice message={t(error)} />}
  </section>;
}
