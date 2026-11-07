import { useRef, useState } from "react";
import type { InvocationRecord } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { costRequest, isDefiniteCostRejection } from "./client";
import { budgetAtomic, formatAtomic } from "./ui-state";

export default function InvocationReconciliation({ invocation, onSaved }: { invocation: InvocationRecord; onSaved: () => void }) {
  const { handshake } = useStorePick("handshake");
  const t = useT();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState(invocation.amount?.currency ?? "USD");
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const retry = useRef<{ signature: string; body: { requestId: string; totalAtomic: string; currency: string; reason: string } } | null>(null);
  const save = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try {
      if (!confirmed) throw new Error("cost_reconcile_confirmation_required");
      const body = { totalAtomic: budgetAtomic(amount), currency: currency.trim().toUpperCase(), reason: reason.trim() };
      if (!body.reason) throw new Error("cost_reconcile_reason_required");
      const signature = JSON.stringify(body);
      if (retry.current?.signature !== signature) retry.current = { signature, body: { ...body, requestId: crypto.randomUUID() } };
      await costRequest(handshake, `/invocations/${encodeURIComponent(invocation.invocationId)}/reconcile`, retry.current.body);
      retry.current = null; onSaved();
    } catch (cause) {
      if (isDefiniteCostRejection(cause)) retry.current = null;
      setError(cause instanceof Error ? cause.message : String(cause));
    }
    finally { pending.current = false; setBusy(false); }
  };
  if (invocation.reconciliation) return <p className="break-words">{t("cost_manual_bill_confirmed")}: {formatAtomic(invocation.reconciliation.amount.atomic, invocation.reconciliation.amount.currency, true)} · {invocation.reconciliation.reason}</p>;
  if (invocation.referenceEstimate) return <p className="text-neutral-500">{t("cost_historical_reference_hint")}</p>;
  if (!["outcome_unknown", "unpriced", "partially_priced"].includes(invocation.status) || ["created", "not_sent"].includes(invocation.state)) return null;
  return <details><summary className="cursor-pointer">{t("cost_reconcile")}</summary><div className="mt-2 space-y-2">
    <p className="text-neutral-500">{t("cost_reconcile_hint")}</p>
    <fieldset className="flex flex-wrap items-end gap-2" disabled={busy}>
      <label>{t("cost_bill_total")}<input aria-label={t("cost_bill_total")} className="pixel-input block w-32 px-2 py-1" inputMode="decimal" value={amount} onChange={event => { setAmount(event.target.value); setConfirmed(false); }} /></label>
      <label>{t("cost_currency")}<input aria-label={t("cost_bill_currency")} className="pixel-input block w-20 px-2 py-1" maxLength={3} value={currency} onChange={event => { setCurrency(event.target.value); setConfirmed(false); }} /></label>
      <label className="basis-full">{t("cost_bill_reference")}<input aria-label={t("cost_bill_reference")} className="pixel-input block w-full px-2 py-1" value={reason} maxLength={2000} onChange={event => { setReason(event.target.value); setConfirmed(false); }} /></label>
      <label className="flex basis-full items-start gap-2"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>{t("cost_confirm_provider_bill")}</span></label>
      <button type="button" className="pixel-button px-3 py-1.5" disabled={!confirmed || !amount.trim() || !reason.trim()} onClick={() => void save()}>{t("cost_save_reconciliation")}</button>
    </fieldset>
    {error && <p role="alert" style={{ color: "var(--pixel-danger)" }}>{t(error)}</p>}
  </div></details>;
}
