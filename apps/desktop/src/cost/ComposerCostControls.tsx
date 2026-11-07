import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ConversationSession, RoomCommandIntent, RoomMention } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { costRequest, type TaskQuoteView } from "./client";
import { budgetAtomic, formatAtomic, quoteBinding, QuoteRequestGuard, type BoundCostOptions, type CostOptions } from "./ui-state";
import RoutePreviewControls from "../routing/RoutePreviewControls";
import { routingMessage } from "../routing/labels";

export default function ComposerCostControls({ session, content, mentions, intent, attachmentIds, workspaceRefIds, disabled, onChange, verificationPlanId, routingCandidateId, onCandidateChange, leading, trailing }: {
  session: ConversationSession; content: string; mentions: RoomMention[]; intent: RoomCommandIntent;
  attachmentIds: string[]; workspaceRefIds: string[]; disabled: boolean;
  onChange: (value: BoundCostOptions) => void;
  verificationPlanId?: string; routingCandidateId?: string; onCandidateChange?: (id: string | undefined) => void;
  leading?: ReactNode; trailing?: ReactNode;
}) {
  const { handshake } = useStorePick("handshake");
  const t = useT();
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<NonNullable<CostOptions["budget"]>["mode"]>("soft_limit");
  const [amount, setAmount] = useState("1.00");
  const [quote, setQuote] = useState<TaskQuoteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const guard = useRef(new QuoteRequestGuard());
  useEffect(() => {
    const update = () => setRefresh(value => value + 1);
    window.addEventListener("socrates-prices-changed", update);
    return () => window.removeEventListener("socrates-prices-changed", update);
  }, []);
  let budget: CostOptions["budget"], invalid: string | null = null;
  try { if (enabled) budget = { mode, limitAtomic: budgetAtomic(amount) }; }
  catch { invalid = "cost_invalid_amount"; }
  const input = { roomId: session.id, content: content.trim(), mentions, intent, attachmentIds, workspaceRefIds, ...(verificationPlanId ? { verificationPlanId } : {}), ...(routingCandidateId ? { routingCandidateId } : {}), ...(budget ? { budget } : {}) };
  const binding = quoteBinding(input, session);
  // The binding includes attachments, author snapshots and collaboration settings.
  // Invalidation happens before a new asynchronous result can authorize a send.
  useEffect(() => {
    const ticket = guard.current.begin(binding);
    const controller = new AbortController();
    setQuote(null); setError(invalid); setLoading(false);
    onChange({ binding, options: { ...(budget ? { budget } : {}) }, expiresAt: Number.POSITIVE_INFINITY, error: invalid });
    if (!input.content || invalid || disabled || !handshake) return () => { guard.current.invalidate(); controller.abort(); };
    const timer = window.setTimeout(() => {
      setLoading(true);
      void costRequest<TaskQuoteView>(handshake, "/quotes", input, controller.signal).then((value) => {
        if (!guard.current.accepts(ticket)) return;
        setQuote(value);
        onChange({ binding, options: { quoteId: value.id, ...(budget ? { budget } : {}) }, expiresAt: Date.parse(value.expiresAt) });
      }).catch((cause) => {
        if (guard.current.accepts(ticket) && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause));
      }).finally(() => { if (guard.current.accepts(ticket)) setLoading(false); });
    }, 400);
    return () => { window.clearTimeout(timer); guard.current.invalidate(); controller.abort(); };
  // All input fields are serialized into binding, avoiding array identity rerenders.
  }, [binding, invalid, disabled, handshake, refresh, onChange]);
  return <div className="mb-2 space-y-2 text-xs">
    <div className="flex flex-wrap items-center gap-2">
      {leading}
      <label className="flex items-center gap-1.5"><input type="checkbox" checked={enabled} disabled={disabled} onChange={event => setEnabled(event.target.checked)} />{t("cost_task_budget")}</label>
      {enabled && <>
        <label className="flex items-center gap-1">USD<input aria-label={t("cost_budget_amount")} className="pixel-input w-24 px-2 py-1" inputMode="decimal" value={amount} disabled={disabled || mode === "tracking_only"} onChange={event => setAmount(event.target.value)} /></label>
        <select className="pixel-input max-w-full px-2 py-1" aria-label={t("cost_budget_mode")} value={mode} disabled={disabled} onChange={event => setMode(event.target.value as typeof mode)}>
          <option value="soft_limit">{t("cost_soft_limit")}</option><option value="strict_admission">{t("cost_strict_admission")}</option><option value="tracking_only">{t("cost_tracking_only")}</option>
        </select>
      </>}
      <button type="button" className="pixel-button px-2 py-1" disabled={disabled || loading || !content.trim()} onClick={() => setRefresh(value => value + 1)}>{loading ? t("cost_quoting") : t("cost_refresh_quote")}</button>
      {quote && <span role="status">{t("cost_quote")}: {formatAtomic(quote.lowAtomic, quote.currency)} – {formatAtomic(quote.highAtomic, quote.currency)}</span>}
      {trailing}
      {quote?.route && onCandidateChange && <RoutePreviewControls route={quote.route} candidateId={routingCandidateId} disabled={disabled || loading} onCandidateChange={onCandidateChange} />}
    </div>
    {error && <p role="alert" style={{ color: "var(--pixel-danger)" }}>{routingMessage(t, error)}</p>}
    {quote && <details><summary className="cursor-pointer">{t("cost_quote_details")} · {t("cost_heuristic")}</summary><div className="mt-2 max-h-[25dvh] space-y-2 overflow-auto">
      <p><strong>{t(`cost_workflow_${quote.kind}`)}</strong>{quote.kind === "direct" ? ` · ${t(quote.route ? "route_no_manager" : "cost_no_manager")}` : ""}</p>
      <p>{t("cost_quote_scope")}</p>
      {quote.stages.map((stage, index) => <div key={`${stage.stage}-${index}`}><strong>{t(`cost_stage_${stage.stage}`)}</strong> · {formatAtomic(stage.lowAtomic, quote.currency, true)} – {formatAtomic(stage.highAtomic, quote.currency, true)}<ul className="ml-4 list-disc">{stage.assumptions.map((assumption, i) => <li key={i}>{assumption}</li>)}</ul></div>)}
      {quote.unknowns.length > 0 && <p className="break-words text-amber-900">{t("cost_unknowns")}: {quote.unknowns.map(item => item.startsWith("price_unknown_or_non_usd:") ? `${t("cost_price_unknown_for_member")}: ${String(session.agents.find(agent => agent.agentId === item.slice("price_unknown_or_non_usd:".length))?.snapshot.nickname ?? item.slice("price_unknown_or_non_usd:".length))}` : t(item)).join(" · ")}</p>}
      <p>{t("cost_quote_expiry")}: {new Date(quote.expiresAt).toLocaleTimeString()}</p>
    </div></details>}
    {enabled && <p className="text-neutral-500">{t("cost_budget_scope")}{mode === "strict_admission" ? ` ${t("cost_strict_hint")}` : mode === "soft_limit" ? ` ${t("cost_soft_hint")}` : ""}</p>}
  </div>;
}
