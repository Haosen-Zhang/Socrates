import { useState } from "react";
import type { Agent } from "@socrates/core";
import { useStore, type AgentForm } from "./store";

const EMPTY: AgentForm = {
  displayName: "",
  providerId: "",
  modelId: "",
  role: "",
  systemPrompt: "",
  temperature: "",
};

export default function AgentsSection() {
  const { agents, providers, saveAgent, removeAgent } = useStore();
  const [form, setForm] = useState<AgentForm>(EMPTY);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? "已删除的供应商";

  const startEdit = (a: Agent) => {
    setEditingId(a.id);
    setForm({
      displayName: a.displayName,
      providerId: a.providerId,
      modelId: a.modelId,
      role: a.role,
      systemPrompt: a.systemPrompt,
      temperature: a.temperature?.toString() ?? "",
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const provider = providers.find((p) => p.id === form.providerId);
    const modelId = form.modelId.trim() || provider?.defaultModel || "";
    try {
      await saveAgent({ ...form, modelId }, editingId);
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
        <h2 className="mb-3 text-base font-semibold">Agent</h2>
        {agents.length === 0 && (
          <p className="text-sm text-neutral-500">还没有 Agent，用下面的表单创建一个。</p>
        )}
        <ul className="space-y-2">
          {agents.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-3 rounded border border-neutral-200 bg-white px-4 py-3"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{a.displayName}</div>
                <div className="truncate text-xs text-neutral-500">
                  {providerName(a.providerId)} · {a.modelId}
                  {a.role ? ` · ${a.role}` : ""}
                </div>
              </div>
              <button
                className="rounded border border-neutral-300 px-2 py-1 text-sm hover:bg-neutral-100"
                onClick={() => startEdit(a)}
              >
                编辑
              </button>
              <button
                className="rounded border border-red-200 px-2 py-1 text-sm text-red-700 hover:bg-red-50"
                onClick={() => void removeAgent(a.id)}
              >
                删除
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="rounded border border-neutral-200 bg-white p-4">
        <h3 className="mb-3 text-sm font-semibold">{editingId ? "编辑 Agent" : "创建 Agent"}</h3>
        <form onSubmit={submit} className="grid grid-cols-2 gap-3">
          <label className="text-sm">
            名称
            <input
              className={input}
              required
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
            />
          </label>
          <label className="text-sm">
            供应商
            <select
              className={input}
              required
              value={form.providerId}
              onChange={(e) => setForm({ ...form, providerId: e.target.value })}
            >
              <option value="">选择供应商…</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            模型（留空用供应商默认）
            <input
              className={input}
              placeholder={providers.find((p) => p.id === form.providerId)?.defaultModel ?? ""}
              value={form.modelId}
              onChange={(e) => setForm({ ...form, modelId: e.target.value })}
            />
          </label>
          <label className="text-sm">
            温度（可选）
            <input
              className={input}
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form.temperature}
              onChange={(e) => setForm({ ...form, temperature: e.target.value })}
            />
          </label>
          <label className="text-sm">
            角色
            <input
              className={input}
              placeholder="架构审稿人 / 实现者…"
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          </label>
          <label className="col-span-2 text-sm">
            系统提示词
            <textarea
              className={`${input} h-20`}
              value={form.systemPrompt}
              onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })}
            />
          </label>
          {error && <p className="col-span-2 text-sm text-red-700">{error}</p>}
          <div className="col-span-2 flex gap-2">
            <button
              type="submit"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-700"
            >
              {editingId ? "保存修改" : "创建"}
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
                取消
              </button>
            )}
          </div>
        </form>
      </section>
    </div>
  );
}
