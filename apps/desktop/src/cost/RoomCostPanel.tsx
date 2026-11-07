import { useEffect, useRef, useState } from "react";
import type { BudgetSummary, CostSummary, InvocationRecord, Money } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useStore, useT } from "../store";
import { sidecarFetch } from "../transport";
import { costRequest, isDefiniteCostRejection } from "./client";
import { budgetAtomic, formatAtomic } from "./ui-state";
import InvocationReconciliation from "./InvocationReconciliation";

function costAmounts(known: Money[], estimated: Money[] | undefined, label: string, expanded = false): string {
  return [known.length ? known.map(total => formatAtomic(total.atomic, total.currency, expanded)).join(" · ") : "",
    estimated?.length ? `${label} ${estimated.map(total => formatAtomic(total.atomic, total.currency, expanded)).join(" · ")}` : ""].filter(Boolean).join(" + ") || "—";
}

export interface RoomCostView {
  summary: CostSummary; invocations: InvocationRecord[];
  tasks: Array<{ rootTaskId: string; commandId?: string; kind: string; status: string; maxOutputTokens?: number; budget: BudgetSummary | null;
    blocked?: { reason: string; details: Record<string, unknown> } | null }>;
}

export function TaskBudget({ task, invocations = [], onRefresh }: { task: RoomCostView["tasks"][number]; invocations?: InvocationRecord[]; onRefresh: () => void }) {
  const { handshake } = useStorePick("handshake");
  const t = useT();
  const [amount, setAmount] = useState("1.00");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const increase = useRef<{ amount: string; body: { requestId: string; expectedRevision: number; amountAtomic: string } } | null>(null);
  const resumeRequest = useRef<{ requestId: string } | null>(null);
  const budget = task.budget;
  if (!budget) return null;
  const paused = ["paused", "interrupted"].includes(task.status);
  const blockedInvocation = invocations.find(item => item.invocationId === task.blocked?.details.invocationId);
  const perform = async (kind: "increase" | "resume") => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (kind === "increase") {
        const amountAtomic = budgetAtomic(amount);
        if (BigInt(amountAtomic) <= 0n) throw new Error("cost_invalid_amount");
        if (increase.current?.amount !== amountAtomic) increase.current = { amount: amountAtomic,
          body: { requestId: crypto.randomUUID(), expectedRevision: budget.revision, amountAtomic } };
        await costRequest(handshake, `/tasks/${encodeURIComponent(task.rootTaskId)}/increase`, increase.current.body);
        increase.current = null;
      } else {
        if (!resumeRequest.current) resumeRequest.current = { requestId: crypto.randomUUID() };
        await costRequest(handshake, `/tasks/${encodeURIComponent(task.rootTaskId)}/resume`, { requestId: resumeRequest.current.requestId });
        resumeRequest.current = null;
        const state = useStore.getState();
        // Reattach existing durable observers; a room switch never redirects it.
        if (state.currentSessionId === budget.roomId) await state.selectAgentSession(budget.roomId);
      }
      onRefresh();
    } catch (cause) {
      if (isDefiniteCostRejection(cause)) {
        if (kind === "increase") increase.current = null;
        else resumeRequest.current = null;
        onRefresh();
      }
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { pending.current = false; setBusy(false); }
  };
  return <article className="space-y-2 border-t border-neutral-200 py-2">
    <div className="flex flex-wrap items-center gap-2"><strong>{t("cost_task_budget")}</strong><span className="pixel-chip">{t(`cost_${budget.mode}`)}</span><span>{t(`task_status_${task.status}`)}</span><span title={task.rootTaskId}>{task.rootTaskId.slice(0, 8)}</span></div>
    <dl className="grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
      {[["cost_budget_limit", budget.limitAtomic], ["cost_known", budget.settledKnownAtomic], ["cost_reserved", budget.activeReservationsAtomic], ["cost_unresolved", budget.unresolvedExposureAtomic], ["cost_available", budget.availableAtomic]].map(([label, value]) => <div key={label}><dt className="text-neutral-500">{t(label)}</dt><dd title={formatAtomic(value, "USD", true)}>{formatAtomic(value)}</dd></div>)}
      {budget.estimatedAtomic && budget.estimatedAtomic !== "0" && <div><dt>{t("cost_reference_estimate")}</dt><dd>{formatAtomic(budget.estimatedAtomic)}</dd></div>}
    </dl>
    {budget.blockedReason && <p role="status" className="text-amber-900">{t(budget.blockedReason)}</p>}
    {blockedInvocation && <p>{t("cost_blocked_call")}: {blockedInvocation.modelId} · {t(`cost_purpose_${blockedInvocation.purpose}`)} · {blockedInvocation.agentId}</p>}
    {budget.breached && <p role="alert" style={{ color: "var(--pixel-danger)" }}>{t("cost_breached")}</p>}
    {budget.unknownCount > 0 && <p className="text-amber-900">{t("cost_pending_count", { n: budget.unknownCount })}</p>}
    {budget.mode !== "tracking_only" && <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-1">{t("cost_increase_amount")}<input aria-label={t("cost_increase_amount")} inputMode="decimal" className="pixel-input w-24 px-2 py-1" value={amount} disabled={busy} onChange={event => setAmount(event.target.value)} /></label>
      <button type="button" className="pixel-button px-2 py-1" disabled={busy} onClick={() => void perform("increase")}>{t("cost_increase")}</button>
      {paused && <>
        <button type="button" className="pixel-button pixel-button--primary px-2 py-1" disabled={busy || budget.unknownCount > 0} onClick={() => void perform("resume")}>{t("cost_resume")}</button>
        <p className="basis-full text-neutral-500">{t("cost_keep_results_hint")}</p>
      </>}
    </div>}
    {error && <p role="alert" style={{ color: "var(--pixel-danger)" }}>{t(error)}</p>}
  </article>;
}

export function CostLedgerView({ data, agentNames = {}, onReconciled = () => {} }: { data: RoomCostView; agentNames?: Record<string, string>; onReconciled?: () => void }) {
  const t = useT();
  const pending = data.summary.outcomeUnknownCount ?? data.summary.unknownCount;
  return <div className="space-y-2">
    <p>{t("cost_known")}: {data.summary.totals.length ? data.summary.totals.map(total => formatAtomic(total.atomic, total.currency)).join(" · ") : "—"} · {t("cost_calls", { n: data.summary.invocations })}
      {pending > 0 && <span className="text-amber-900"> + {t("cost_pending_count", { n: pending })}</span>}
    </p>
    {!!data.summary.estimatedTotals?.length && <p><strong>{t("cost_reference_estimate")}: {data.summary.estimatedTotals.map(total => formatAtomic(total.atomic, total.currency, true)).join(" · ")}</strong> · {t("cost_automatic_estimate_hint")}</p>}
    {!!data.summary.unpricedCount && <p>{t("cost_missing_prices", { n: data.summary.unpricedCount })}</p>}
    {!!data.summary.partialCount && <p>{t("cost_partial_pricing", { n: data.summary.partialCount })}</p>}
    {data.summary.historicalUnknownCount > 0 && <p className="text-neutral-500">{t("cost_historical_unknown", { n: data.summary.historicalUnknownCount })}</p>}
    {data.summary.byAgent.map(agent => <p key={agent.agentId}>{agentNames[agent.agentId] ?? agent.agentId}: {costAmounts(agent.totals, agent.estimatedTotals, t("cost_reference_estimate"), true)} · {t("cost_calls", { n: agent.invocations })}{(agent.outcomeUnknownCount ?? agent.unknownCount) > 0 ? ` · ${t("cost_pending_count", { n: agent.outcomeUnknownCount ?? agent.unknownCount })}` : ""}</p>)}
    {data.invocations.length === 0 && <p className="text-neutral-500">{t("cost_ledger_empty")}</p>}
    {data.invocations.length > 0 && <details><summary className="cursor-pointer">{t("cost_invocation_details")}</summary><div className="max-h-72 space-y-3 overflow-auto py-2">
      {data.invocations.map(item => <article key={item.invocationId} className="space-y-1 border-t border-neutral-200 pt-2">
        <div className="flex flex-wrap gap-x-2"><strong>{agentNames[item.agentId] ?? item.agentId} · {item.modelId}</strong><span>{t(`cost_purpose_${item.purpose}`)}</span><span>{t(item.referenceEstimate ? "cost_reference_estimate" : `cost_status_${item.status}`)}</span><span>{formatAtomic(item.referenceEstimate?.amount.atomic ?? item.amount?.atomic, item.referenceEstimate?.amount.currency ?? item.amount?.currency, true)}</span></div>
        <p className="break-all text-neutral-500">{item.invocationId} · {t("cost_price_version")}: {item.referenceEstimate?.priceSnapshotId ?? item.priceSnapshotId ?? t("usage_unavailable")}</p>
        <p>{t("cost_tokens")}: {t("cost_input")} {item.usage?.inputTokens ?? "—"} · {t("cost_output")} {item.usage?.outputTokens ?? "—"} · {t("cost_cache_read")} {item.usage?.cachedInputTokens ?? "—"} · {t("cost_cache_write")} {item.usage?.cacheWriteTokens ?? "—"} · {t("usage_reasoning")} {item.usage?.reasoningTokens ?? "—"}</p>
        {item.lineItems.map((line, index) => <p key={index}>{t(`cost_line_${line.kind}`)}: {line.quantity} × {line.ratePerMillion}/1M = {formatAtomic(line.amount.atomic, line.amount.currency, true)}</p>)}
        {!item.referenceEstimate && item.unknownItems.length > 0 && <p className="text-amber-900">{t("cost_unknowns")}: {item.unknownItems.map(reason => t(reason)).join(" · ")}</p>}
        {item.requestId && <p className="break-all">{t("cost_request_id")}: {item.requestId}</p>}
        <InvocationReconciliation invocation={item} onSaved={onReconciled} />
      </article>)}
    </div></details>}
  </div>;
}

export default function RoomCostPanel({ roomId }: { roomId: string }) {
  const { handshake, sessions } = useStorePick("handshake", "sessions");
  const t = useT();
  const [data, setData] = useState<RoomCostView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [exporting, setExporting] = useState(false);
  const dataRoom = useRef(roomId);
  const detailsRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    if (dataRoom.current !== roomId) { setData(null); dataRoom.current = roomId; }
    setError(null);
    const load = async () => {
      try {
        const value = await costRequest<RoomCostView>(handshake, `/rooms/${encodeURIComponent(roomId)}`, undefined, controller.signal);
        if (active) { setData(value); setError(null); }
      } catch (cause) { if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); }
      finally { if (active) timer = setTimeout(() => void load(), 1200); }
    };
    if (handshake) void load();
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer); };
  }, [roomId, handshake, revision]);
  const exportLedger = async (format: "json" | "csv") => {
    if (!handshake || exporting) return;
    setExporting(true); setError(null);
    try {
      const response = await sidecarFetch(handshake, `/cost/rooms/${encodeURIComponent(roomId)}/export?format=${format}`);
      if (!response.ok) throw new Error("cost_export_failed");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a"); link.href = url; link.download = `socrates-cost-${roomId.replace(/[^\w-]/g, "_")}.${format}`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setExporting(false); }
  };
  const paused = data?.tasks.some(task => task.budget && (task.budget.blockedReason || task.budget.breached || task.budget.mode !== "tracking_only" && ["paused", "interrupted", "budget_stopped"].includes(task.status)));
  useEffect(() => { if (paused && detailsRef.current) detailsRef.current.open = true; }, [paused]);
  const latestBudget = data?.tasks.find(task => task.budget)?.budget;
  const agentNames = Object.fromEntries((sessions.find(session => session.id === roomId)?.agents ?? []).map(member => [member.agentId, String(member.snapshot.nickname ?? member.agentId)]));
  return <details ref={detailsRef} className="pixel-card mx-4 my-2 p-3 text-xs" aria-label={t("cost_ledger")}>
    <summary className="cursor-pointer font-semibold">{t("cost_ledger")}{data ? ` · ${costAmounts(data.summary.totals, data.summary.estimatedTotals, t("cost_reference_estimate"))}${(data.summary.outcomeUnknownCount ?? data.summary.unknownCount) ? ` + ${t("cost_pending_count", { n: data.summary.outcomeUnknownCount ?? data.summary.unknownCount })}` : ""}` : ""}</summary>
    {latestBudget && <p className="mt-1 text-neutral-500">{t("cost_reserved")}: {formatAtomic(latestBudget.activeReservationsAtomic)} · {t("cost_available")}: {formatAtomic(latestBudget.availableAtomic)}</p>}
    <div className="mt-3 max-h-[35vh] space-y-3 overflow-y-auto pr-1">
      {error && <p role="alert" style={{ color: "var(--pixel-danger)" }}>{t(error)}</p>}
      {!data && !error && <p role="status">{t("cost_loading")}</p>}
      {data && <>
        {data.tasks.filter(task => task.budget).map(task => <TaskBudget key={task.rootTaskId} task={task} invocations={data.invocations} onRefresh={() => setRevision(value => value + 1)} />)}
        <CostLedgerView data={data} agentNames={agentNames} onReconciled={() => setRevision(value => value + 1)} />
        <div className="flex flex-wrap gap-2"><button type="button" className="pixel-button px-2 py-1" disabled={exporting} onClick={() => void exportLedger("json")}>{t("cost_export_json")}</button><button type="button" className="pixel-button px-2 py-1" disabled={exporting} onClick={() => void exportLedger("csv")}>{t("cost_export_csv")}</button></div>
        <p className="text-neutral-500">{t("cost_provider_usage")}</p>
      </>}
    </div>
  </details>;
}
