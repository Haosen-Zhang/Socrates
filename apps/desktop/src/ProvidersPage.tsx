import { useState } from "react";
import type { Provider } from "@socrates/core";
import { useStore, useT, type ProviderForm, type TestResult } from "./store";

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

export default function ProvidersPage() {
  const { providers, testResults, saveProvider, removeProvider, testProvider } = useStore();
  const t = useT();
  const [form, setForm] = useState<ProviderForm>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const field = (key: keyof ProviderForm) => ({
    value: form[key],
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      setForm({ ...form, [key]: e.target.value }),
  });

  const startEdit = (p: Provider) => {
    setEditingId(p.id);
    setForm({
      name: p.name,
      type: p.type,
      baseUrl: p.baseUrl,
      defaultModel: p.defaultModel ?? "",
      apiKey: "",
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await saveProvider(form, editingId);
      setForm(EMPTY);
      setEditingId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const input = "rounded border border-neutral-300 px-2 py-1.5 text-sm w-full";

  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-3 text-base font-semibold">{t("providers_title")}</h2>
        {providers.length === 0 && <p className="text-sm text-neutral-500">{t("providers_empty")}</p>}
        <ul className="space-y-2">
          {providers.map((p) => (
            <li
              key={p.id}
              className="flex items-center gap-3 rounded border border-neutral-200 bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.name}</div>
                <div className="truncate text-xs text-neutral-500">
                  {p.type} · {p.baseUrl}
                  {p.defaultModel ? ` · ${p.defaultModel}` : ""}
                </div>
              </div>
              <TestBadge result={testResults[p.id]} />
              <button
                className="rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100"
                onClick={() => void testProvider(p.id)}
              >
                {t("test_connection")}
              </button>
              <button
                className="rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100"
                onClick={() => startEdit(p)}
              >
                {t("edit")}
              </button>
              <button
                className="rounded border border-red-200 px-2 py-1 text-sm text-red-700 hover:bg-red-50"
                onClick={() => void removeProvider(p.id)}
              >
                {t("delete")}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold">{editingId ? t("provider_edit") : t("provider_add")}</h3>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
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
          <label className="col-span-2 text-sm">
            {editingId ? t("api_key_keep") : t("api_key")}
            <input
              className={input}
              type="password"
              required={editingId === null}
              autoComplete="off"
              {...field("apiKey")}
            />
          </label>
          {error && <p className="col-span-2 text-sm text-red-700">{error}</p>}
          <div className="col-span-2 flex gap-2">
            <button
              type="submit"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              {editingId ? t("save") : t("add")}
            </button>
            {editingId && (
              <button
                type="button"
                className="rounded border border-neutral-300 px-3 py-1.5 text-sm"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY);
                }}
              >
                {t("cancel")}
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
