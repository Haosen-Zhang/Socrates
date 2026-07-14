import { useRef, useState } from "react";
import {
  DEFAULT_BASE_URLS,
  resolveBaseUrl,
  selectCheapestOpenAiModel,
  type Provider,
  type ProviderType,
} from "@socrates/core";
import { useStore, useT, type ProviderForm, type TestResult } from "./store";
import { pixelBurst, sfx } from "./fx";

const EMPTY: ProviderForm = {
  name: "",
  type: "openai_compatible",
  baseUrl: "",
  defaultModel: "",
  apiKey: "",
};

function isOfficialOpenAi(form: ProviderForm): boolean {
  if (form.type !== "openai_compatible") return false;
  try {
    return new URL(resolveBaseUrl(form.type, form.baseUrl)).hostname === "api.openai.com";
  } catch {
    return false;
  }
}

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
  const { agents, testResults, modelLists, testProvider, removeProvider, loadModels } = useStore();
  const t = useT();
  const [confirming, setConfirming] = useState(false);
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
            onClick={(e) => {
              if (!confirming) {
                setConfirming(true);
                setTimeout(() => setConfirming(false), 3000);
                return;
              }
              sfx.delete();
              pixelBurst(e.currentTarget, "#b4233b");
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
  const { providers, saveProvider, discoverProviderModels } = useStore();
  const t = useT();
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const modelRequestId = useRef(0);

  const field = (key: keyof ProviderForm) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value }),
  });

  const close = () => {
    modelRequestId.current += 1;
    setOpen(false);
    setError(null);
  };

  const resetModels = () => {
    modelRequestId.current += 1;
    setModels([]);
    setModelsLoading(false);
    setModelsError(null);
    setManualModel(false);
  };

  const refreshModels = async (candidate: ProviderForm, providerId: string | null) => {
    if (!providerId && !candidate.apiKey.trim()) {
      setModelsError(t("models_need_key"));
      return;
    }
    const requestId = ++modelRequestId.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const available = await discoverProviderModels(candidate, providerId);
      if (requestId !== modelRequestId.current) return;
      setModels(available);
      setManualModel(false);
      setForm((current) => {
        if (current.type !== candidate.type || current.baseUrl !== candidate.baseUrl || current.defaultModel.trim()) {
          return current;
        }
        const defaultModel = isOfficialOpenAi(candidate)
          ? selectCheapestOpenAiModel(available)
          : available[0];
        return defaultModel ? { ...current, defaultModel } : current;
      });
    } catch (err) {
      if (requestId !== modelRequestId.current) return;
      setModels([]);
      setModelsError(err instanceof Error ? err.message : String(err));
    } finally {
      if (requestId === modelRequestId.current) setModelsLoading(false);
    }
  };

  const startCreate = () => {
    setEditingId(null);
    setForm(EMPTY);
    resetModels();
    setOpen(true);
  };
  const startEdit = (p: Provider) => {
    const next = { name: p.name, type: p.type, baseUrl: p.baseUrl, defaultModel: p.defaultModel ?? "", apiKey: "" };
    setEditingId(p.id);
    setForm(next);
    resetModels();
    setOpen(true);
    void refreshModels(next, p.id);
  };

  const changeType = (type: ProviderType) => {
    const oldDefault = DEFAULT_BASE_URLS[form.type];
    const baseUrl = !form.baseUrl || form.baseUrl === oldDefault ? DEFAULT_BASE_URLS[type] : form.baseUrl;
    setForm({ ...form, type, baseUrl, defaultModel: "" });
    resetModels();
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
        <div className="pixel-dialog-backdrop" role="presentation" onMouseDown={close}>
          <div
            className="pixel-dialog w-[min(620px,calc(100vw-48px))] p-5"
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? t("provider_edit") : t("provider_add")}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between">
              <div>
                <div className="pixel-kicker">PROVIDER CONFIG</div>
                <h3 className="text-lg font-bold">{editingId ? t("provider_edit") : t("provider_add")}</h3>
              </div>
              <button
                className="pixel-button h-8 w-8"
                onClick={(e) => {
                  sfx.close();
                  pixelBurst(e.currentTarget);
                  close();
                }}
                aria-label={t("close")}
              >
                ×
              </button>
            </div>
            <form onSubmit={submit} className="grid grid-cols-2 gap-4">
              <label className="text-sm">
                {t("name")}
                <input className={input} required {...field("name")} />
              </label>
              <label className="text-sm">
                {t("provider_type")}
                <select
                  className={`${input} cursor-pointer`}
                  value={form.type}
                  onChange={(event) => changeType(event.target.value as ProviderType)}
                >
                  <option value="openai_compatible">OpenAI-compatible</option>
                  <option value="anthropic">Anthropic</option>
                </select>
              </label>
              <label className="text-sm">
                {t("base_url")}
                <input
                  className={input}
                  placeholder="https://…"
                  value={form.baseUrl}
                  onChange={(event) => {
                    setForm({ ...form, baseUrl: event.target.value, defaultModel: "" });
                    resetModels();
                  }}
                />
              </label>
              <label className="text-sm">
                {t("default_model")}
                {models.length > 0 && !manualModel ? (
                  <div className="flex gap-1">
                    <select className={`${input} cursor-pointer`} {...field("defaultModel")}>
                      <option value="">{t("model_pick")}</option>
                      {form.defaultModel && !models.includes(form.defaultModel) && (
                        <option value={form.defaultModel}>{form.defaultModel}</option>
                      )}
                      {models.map((model) => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="pixel-button shrink-0 px-2 text-sm"
                      title={t("model_manual")}
                      onClick={() => setManualModel(true)}
                    >
                      ✎
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-1">
                    <input
                      className={input}
                      placeholder="gpt-5-nano / deepseek-chat"
                      {...field("defaultModel")}
                    />
                    {models.length > 0 && (
                      <button
                        type="button"
                        className="pixel-button shrink-0 px-2 text-sm"
                        title={t("model_from_list")}
                        onClick={() => setManualModel(false)}
                      >
                        ☰
                      </button>
                    )}
                  </div>
                )}
                <span className="mt-1 flex items-center justify-between gap-2 text-xs text-neutral-500">
                  <span>
                    {modelsError ??
                      (isOfficialOpenAi(form) && form.defaultModel === selectCheapestOpenAiModel(models)
                        ? t("model_cheapest_selected")
                        : models.length > 0
                          ? t("models_total", { n: models.length })
                          : "")}
                  </span>
                  <button
                    type="button"
                    className="pixel-link shrink-0"
                    disabled={modelsLoading}
                    onClick={() => void refreshModels(form, editingId)}
                  >
                    {modelsLoading ? t("models_loading") : t("refresh_models")}
                  </button>
                </span>
              </label>
              <label className="col-span-2 text-sm">
                {editingId ? t("api_key_keep") : t("api_key")}
                <input
                  className={input}
                  type="password"
                  required={editingId === null}
                  autoComplete="off"
                  value={form.apiKey}
                  onChange={(event) => {
                    setForm({ ...form, apiKey: event.target.value });
                    resetModels();
                  }}
                  onBlur={() => {
                    if (form.apiKey.trim()) void refreshModels(form, editingId);
                  }}
                />
              </label>
              {error && <p className="col-span-2 text-sm text-red-700">{error}</p>}
              <div className="col-span-2 flex justify-end gap-2">
                <button type="button" className="pixel-button px-4 py-2 text-sm" onClick={close}>
                  {t("cancel")}
                </button>
                <button type="submit" className="pixel-button pixel-button--primary px-4 py-2 text-sm">
                  {editingId ? t("save") : t("add")}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
