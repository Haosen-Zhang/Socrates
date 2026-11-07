import { useEffect, useState } from "react";
import { decimalToAtomic, type PriceSnapshot, type Provider } from "@socrates/core";
import { useStorePick } from "../selectors";
import { useT } from "../store";
import { costRequest } from "./client";
import { formatAtomic } from "./ui-state";

export function providerPriceProtocol(provider: Pick<Provider, "type" | "baseUrl">): string {
  if (provider.type === "anthropic") return "anthropic_messages";
  try { const url = new URL(provider.baseUrl); if (url.protocol === "https:" && url.hostname === "api.openai.com" && url.pathname.replace(/\/$/, "") === "/v1") return "openai_responses"; } catch { /* Show configured compatible protocol without inventing a mapping. */ }
  return "openai_chat_completions";
}

export function syntheticPricePreview(input: string, output: string): string | null {
  try { return ([input, output].reduce((sum, rate) => sum + (BigInt(decimalToAtomic(rate)) + 999n) / 1000n, 0n)).toString(); }
  catch { return null; }
}

export default function ProviderPrices({ provider, models }: { provider: Provider; models: string[] }) {
  const { handshake } = useStorePick("handshake");
  const t = useT();
  const [prices, setPrices] = useState<PriceSnapshot[]>([]);
  const [modelId, setModelId] = useState(provider.defaultModel ?? models[0] ?? "");
  const [currency, setCurrency] = useState("USD");
  const [input, setInput] = useState("1");
  const [output, setOutput] = useState("5");
  const [cacheRead, setCacheRead] = useState("1");
  const [cacheWrite, setCacheWrite] = useState("1");
  const [free, setFree] = useState(false);
  const [mappingConfirmed, setMappingConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [version, setVersion] = useState(0);
  const protocol = providerPriceProtocol(provider);
  useEffect(() => {
    const controller = new AbortController(); let active = true;
    setPrices([]); setError(null);
    if (handshake) void costRequest<PriceSnapshot[]>(handshake, `/prices?providerId=${encodeURIComponent(provider.id)}`, undefined, controller.signal).then(value => { if (active) setPrices(value); }).catch(cause => { if (active && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { active = false; controller.abort(); };
  }, [handshake, provider.id, version]);
  useEffect(() => setMappingConfirmed(false), [provider.id, provider.baseUrl, protocol]);
  const selectedPrice = [...prices].filter(price => price.modelId === modelId.trim()).sort((a, b) =>
    ({ user_confirmed: 3, official: 2, verified_catalog: 1, preset_estimate: 0 })[b.source] - ({ user_confirmed: 3, official: 2, verified_catalog: 1, preset_estimate: 0 })[a.source] || b.fetchedAt.localeCompare(a.fetchedAt))[0];
  useEffect(() => {
    setInput(selectedPrice?.rates.input ?? "1"); setOutput(selectedPrice?.rates.output ?? "5");
    setCacheRead(selectedPrice ? selectedPrice.rates.cacheRead ?? "" : "1"); setCacheWrite(selectedPrice ? selectedPrice.rates.cacheWrite ?? "" : "1");
    setCurrency(selectedPrice?.currency ?? "USD");
  }, [selectedPrice?.id, modelId]);
  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const rates = { input: input.trim(), output: output.trim(), ...(cacheRead.trim() ? { cacheRead: cacheRead.trim() } : {}), ...(cacheWrite.trim() ? { cacheWrite: cacheWrite.trim() } : {}) };
      for (const rate of Object.values(rates)) decimalToAtomic(rate.trim());
      if (!modelId.trim()) throw new Error("cost_model_required");
      await costRequest(handshake, "/prices", { providerConnectionId: provider.id, modelId: modelId.trim(), baseUrl: provider.baseUrl, protocol,
        currency: currency.trim().toUpperCase(), rates, source: "user_confirmed", sourceVersion: "user-confirmed/1", billingMode: "metered", explicitlyFree: free });
      setVersion(value => value + 1);
      window.dispatchEvent(new CustomEvent("socrates-prices-changed"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  const preview = syntheticPricePreview(input, output);
  const importCatalog = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      if (!modelId.trim()) throw new Error("cost_model_required");
      if (!mappingConfirmed) throw new Error("catalog_mapping_confirmation_required");
      await costRequest(handshake, "/prices/import", { providerConnectionId: provider.id, modelId: modelId.trim(), protocol, baseUrl: provider.baseUrl,
        catalogProviderId: "openai", catalogModelId: "gpt-5", confirmedMapping: true });
      setVersion(value => value + 1); window.dispatchEvent(new CustomEvent("socrates-prices-changed"));
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };
  return <details className="mt-3 border-t border-neutral-200 pt-3 text-xs">
    <summary className="cursor-pointer font-semibold">{t("cost_prices")}</summary>
    <div className="mt-3 space-y-3">
      <p className="text-neutral-500">{t("cost_price_mapping_hint")}</p>
      <p>{t("cost_automatic_prices")}</p>
      <p className="text-neutral-500">{t("cost_price_priority")}</p>
      {!prices.length && <p>{t("cost_price_empty")}</p>}
      {prices.map(price => <div className="break-words" key={price.id}><strong>{price.modelId}</strong> · {price.currency} · {t(`cost_source_${price.source}`)}<p>{price.protocol} · {price.baseUrl} · {price.serviceTier}</p><p>{t("cost_input")}: {price.rates.input} / 1M · {t("cost_output")}: {price.rates.output} / 1M · {t("cost_updated")}: {new Date(price.fetchedAt).toLocaleString()}</p>{price.sourceUrl.startsWith("https://") && <a href={price.sourceUrl} target="_blank" rel="noreferrer">{t("cost_price_source_link")}</a>}<p className="break-all text-neutral-500">{t("cost_price_version")}: {price.id}</p></div>)}
      <fieldset className="grid grid-cols-1 gap-2 sm:grid-cols-2" disabled={busy}>
        <legend className="mb-2 font-semibold">{t("cost_custom_price")}</legend>
        <label>{t("cost_exact_model")}<input className="pixel-input w-full px-2 py-1" value={modelId} onChange={event => { setModelId(event.target.value); setMappingConfirmed(false); }} list={`cost-models-${provider.id}`} /><datalist id={`cost-models-${provider.id}`}>{models.map(model => <option key={model} value={model} />)}</datalist></label>
        <label>{t("cost_currency")}<input className="pixel-input w-full px-2 py-1" maxLength={3} value={currency} onChange={event => setCurrency(event.target.value)} /></label>
        {[["cost_input_rate", input, setInput], ["cost_output_rate", output, setOutput], ["cost_cache_read_rate", cacheRead, setCacheRead], ["cost_cache_write_rate", cacheWrite, setCacheWrite]].map(([label, value, update]) => <label key={label as string}>{t(label as string)}<input className="pixel-input w-full px-2 py-1" inputMode="decimal" value={value as string} onChange={event => (update as (value: string) => void)(event.target.value)} placeholder={label === "cost_cache_read_rate" || label === "cost_cache_write_rate" ? t("cost_optional_unknown") : ""} /></label>)}
        <label className="flex items-center gap-2 sm:col-span-2"><input type="checkbox" checked={free} onChange={event => setFree(event.target.checked)} />{t("cost_confirm_free")}</label>
        <p className="break-words text-neutral-500 sm:col-span-2">{protocol} · {provider.baseUrl}</p>
        {preview !== null && <p className="sm:col-span-2">{t("cost_synthetic_preview")}: {formatAtomic(preview, currency.toUpperCase(), true)}</p>}
        <button type="button" className="pixel-button w-fit px-3 py-1.5" onClick={() => void save()}>{busy ? t("cost_saving") : t("cost_save_price")}</button>
      </fieldset>
      <details><summary className="cursor-pointer">{t("cost_catalog_import")}</summary><div className="mt-2 space-y-2">
        <p>{t("cost_catalog_scope")}</p>
        <p>models.dev · openai / gpt-5 → {modelId.trim() || t("cost_exact_model")} · {protocol}</p>
        <label className="flex items-start gap-2"><input type="checkbox" checked={mappingConfirmed} disabled={busy} onChange={event => setMappingConfirmed(event.target.checked)} /><span>{t("cost_catalog_confirm_mapping")}</span></label>
        <button type="button" className="pixel-button px-3 py-1.5" disabled={busy || !mappingConfirmed || !modelId.trim()} onClick={() => void importCatalog()}>{t("cost_catalog_import_action")}</button>
      </div></details>
      {error && <p role="alert" style={{ color: "var(--pixel-danger)" }}>{t(error)}</p>}
    </div>
  </details>;
}
