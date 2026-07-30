import { useState } from "react";
import type { Provider } from "@socrates/core";
import { useT, type ProviderForm, type TestResult } from "./store";
import { PROVIDER_CARD_KEYS, PROVIDERS_PAGE_KEYS, useStorePick } from "./selectors";
import { sfx } from "./fx";
import { useTransientFlag } from "./useTransientFlag";
import NestedDialogPortal from "./dialog/NestedDialogPortal";

const EMPTY: ProviderForm = {
  name: "",
  type: "openai_compatible",
  baseUrl: "",
  defaultModel: "",
  apiKey: "",
};

function TestBadge({ result }: { result: TestResult | "running" | undefined }) {
  const t = useT();
  if (!result) return null;
  if (result === "running") return <span className="text-sm text-neutral-500">{t("testing")}</span>;
  const label: Record<string, [string, string]> = {
    ok: [t("test_ok"), "text-green-700"],
    auth_failed: [t("test_auth_failed"), "text-red-700"],
    network_error: [t("test_network_error"), "text-amber-700"],
    error: [t("test_error", { status: result.status ? ` (${result.status})` : "" }), "text-red-700"],
  };
  const [text, cls] = label[result.outcome];
  return (
    <span className={`text-sm font-medium ${cls}`} title={result.detail}>
      {text}
    </span>
  );
}

/** Reasonix 式接入卡：徽章 + 元信息 + 已启用模型 chips + 操作按钮 */
function ProviderCard({
  provider,
  onEdit,
}: {
  provider: Provider;
  onEdit: (p: Provider) => void;
}) {
  const { agents, testResults, modelLists, testProvider, removeProvider, loadModels } = useStorePick(...PROVIDER_CARD_KEYS);
  const t = useT();
  const [confirming, markConfirming] = useTransientFlag(3000);
  const [refreshing, setRefreshing] = useState(false);

  // 「已启用」= 被 Agent 实际使用的模型 + 默认模型
  const enabled = [
    ...new Set([
      ...(provider.defaultModel ? [provider.defaultModel] : []),
      ...agents.filter((a) => a.providerId === provider.id).map((a) => a.modelId),
    ]),
  ];
  const available = modelLists[provider.id];

  const refresh = async () => {
    setRefreshing(true);
    try {
      await loadModels(provider.id, true);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <article className="pixel-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-base font-bold">{provider.name}</span>
            <span className="pixel-chip">{provider.type === "anthropic" ? "Anthropic" : "OpenAI-compatible"}</span>
            {provider.apiKeyRef && (
              <span className="pixel-chip !border-green-700 !bg-green-100 !text-green-800">{t("provider_key_set")}</span>
            )}
            <TestBadge result={testResults[provider.id]} />
          </div>
          <div className="mt-1 truncate text-xs text-neutral-500">
            {provider.baseUrl}
            {available ? ` · ${t("models_total", { n: available.length })}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap justify-end gap-2">
          <button className="pixel-button px-2 py-1 text-xs" onClick={() => void testProvider(provider.id)}>
            {t("test_connection")}
          </button>
          <button className="pixel-button px-2 py-1 text-xs" disabled={refreshing} onClick={() => void refresh()}>
            {refreshing ? "…" : t("refresh_models")}
          </button>
          <button className="pixel-button px-2 py-1 text-xs" onClick={() => onEdit(provider)}>
            {t("configure")}
          </button>
          <button
            className="pixel-button pixel-button--danger px-2 py-1 text-xs"
            onClick={() => {
              if (!confirming) {
                markConfirming();
                return;
              }
              sfx.delete();
              void removeProvider(provider.id);
            }}
          >
            {confirming ? t("confirm_delete") : t("delete")}
          </button>
        </div>
      </div>
      {enabled.length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs font-semibold text-neutral-500">{t("enabled_models")}</div>
          <div className="flex flex-wrap gap-1.5">
            {enabled.map((m) => (
              <span key={m} className="pixel-chip normal-case">
                {m}
                {m === provider.defaultModel && ` · ${t("default_badge")}`}
              </span>
            ))}
          </div>
        </div>
      )}
    </article>
  );
}

export default function ProvidersPage() {
  const { providers, saveProvider } = useStorePick(...PROVIDERS_PAGE_KEYS);
  const t = useT();
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const field = (key: keyof ProviderForm) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value }),
  });

  const close = () => {
    setOpen(false);
    setError(null);
  };
  const startCreate = () => {
    setEditingId(null);
    setForm(EMPTY);
    setOpen(true);
  };
  const startEdit = (p: Provider) => {
    setEditingId(p.id);
    setForm({ name: p.name, type: p.type, baseUrl: p.baseUrl, defaultModel: p.defaultModel ?? "", apiKey: "" });
    setOpen(true);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await saveProvider(form, editingId);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const input = "pixel-input w-full px-3 py-2 text-sm";

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <div className="pixel-kicker">PROVIDER ACCESS</div>
          <h2 className="text-xl font-bold">{t("provider_access")}</h2>
          <p className="mt-1 text-sm text-neutral-500">{t("provider_access_desc")}</p>
        </div>
        <button className="pixel-button pixel-button--primary px-4 py-2 text-sm" onClick={startCreate}>
          + {t("provider_add")}
        </button>
      </div>

      {providers.length === 0 ? (
        <button className="pixel-empty w-full p-8 text-sm text-neutral-500" onClick={startCreate}>
          {t("providers_empty")}
        </button>
      ) : (
        <div className="space-y-3">
          {providers.map((p) => (
            <ProviderCard key={p.id} provider={p} onEdit={startEdit} />
          ))}
        </div>
      )}

      {open && (
        <NestedDialogPortal
          ariaLabel={editingId ? t("provider_edit") : t("provider_add")}
          className="pixel-dialog max-h-full w-full max-w-[620px] overflow-y-auto overscroll-contain p-5"
          onClose={close}
        >
          <div className="mb-5 flex items-start justify-between">
              <div>
                <div className="pixel-kicker">PROVIDER CONFIG</div>
                <h3 className="text-lg font-bold">{editingId ? t("provider_edit") : t("provider_add")}</h3>
              </div>
              <button
                className="pixel-button h-8 w-8"
                onClick={() => {
                  sfx.close();
                  close();
                }}
                aria-label={t("close")}
              >
                ×
              </button>
            </div>
          <form onSubmit={submit} className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <label className="text-sm">
                {t("name")}
                <input className={input} required {...field("name")} />
              </label>
              <label className="text-sm">
                {t("provider_type")}
                <select className={input} disabled={editingId !== null} {...field("type")}>
                  <option value="openai_compatible">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
              <label className="text-sm">
                {t("base_url")}
                <input className={input} placeholder="https://…" {...field("baseUrl")} />
              </label>
              <label className="text-sm">
                {t("default_model")}
                <input className={input} placeholder="gpt-5.4 / deepseek-v4-flash" {...field("defaultModel")} />
              </label>
              <label className="text-sm md:col-span-2">
                {editingId ? t("api_key_keep") : t("api_key")}
                <input
                  className={input}
                  type="password"
                  required={editingId === null}
                  autoComplete="off"
                  {...field("apiKey")}
                />
              </label>
              {error && <p className="text-sm text-red-700 md:col-span-2">{error}</p>}
              <div className="flex justify-end gap-2 md:col-span-2">
                <button type="button" className="pixel-button px-4 py-2 text-sm" onClick={close}>
                  {t("cancel")}
                </button>
                <button type="submit" className="pixel-button pixel-button--primary px-4 py-2 text-sm">
                  {editingId ? t("save") : t("add")}
                </button>
              </div>
          </form>
        </NestedDialogPortal>
      )}
    </section>
  );
}
