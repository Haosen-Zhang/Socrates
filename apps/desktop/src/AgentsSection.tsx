import { useEffect, useRef, useState } from "react";
import {
  AGENT_AVATAR_ACCEPT,
  AGENT_AVATARS,
  agentLabel,
  isAgentAvatarSource,
  normalizeAgentNickname,
  randomUniqueAgentIdentity,
  type Agent,
} from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import { validateAvatarUpload } from "./agentAvatarUpload";
import { useStore, useT, type AgentForm } from "./store";
import { sfx } from "./fx";

function newForm(agents: Agent[]): AgentForm {
  const identity = randomUniqueAgentIdentity(agents.map((agent) => agent.nickname));
  return {
    nickname: identity.nickname,
    avatar: identity.avatar,
    providerId: "",
    modelId: "",
    role: "",
    systemPrompt: "",
    temperature: "",
  };
}

export default function AgentsSection() {
  const { agents, providers, modelLists, loadModels, saveAgent, removeAgent } = useStore();
  const t = useT();
  const [form, setForm] = useState<AgentForm>(() => newForm(agents));
  const [editingId, setEditingId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  // 选中供应商后拉取其可用型号（缓存于 store）
  useEffect(() => {
    if (open && form.providerId) void loadModels(form.providerId);
  }, [open, form.providerId, loadModels]);
  const models = form.providerId ? modelLists[form.providerId] : undefined;

  const providerName = (id: string) => providers.find((p) => p.id === id)?.name ?? t("provider_deleted");
  const close = () => {
    setOpen(false);
    setError(null);
  };
  const startCreate = () => {
    setEditingId(null);
    setForm(newForm(agents));
    setError(null);
    setOpen(true);
  };
  const startEdit = (agent: Agent) => {
    setEditingId(agent.id);
    setForm({
      nickname: agent.nickname,
      avatar: agent.avatar,
      providerId: agent.providerId,
      modelId: agent.modelId,
      role: agent.role,
      systemPrompt: agent.systemPrompt,
      temperature: agent.temperature?.toString() ?? "",
    });
    setOpen(true);
  };
  const shuffleIdentity = () => {
    const identity = randomUniqueAgentIdentity(
      agents.filter((agent) => agent.id !== editingId).map((agent) => agent.nickname),
    );
    setForm((current) => ({ ...current, ...identity }));
    setError(null);
  };
  const duplicateNickname = agents.some(
    (agent) =>
      agent.id !== editingId &&
      normalizeAgentNickname(agent.nickname) === normalizeAgentNickname(form.nickname),
  );
  const selectAvatarFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const validation = validateAvatarUpload(file);
    if (validation) {
      setError(t(validation === "size" ? "avatar_too_large" : "avatar_invalid_format"));
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setError(t("avatar_read_failed"));
    reader.onload = () => {
      if (typeof reader.result !== "string" || !isAgentAvatarSource(reader.result)) {
        setError(t("avatar_invalid_format"));
        return;
      }
      setForm((current) => ({ ...current, avatar: reader.result as string }));
      setError(null);
    };
    reader.readAsDataURL(file);
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (duplicateNickname) {
      setError(t("nickname_duplicate"));
      return;
    }
    const provider = providers.find((item) => item.id === form.providerId);
    const modelId = form.modelId.trim() || provider?.defaultModel || "";
    try {
      await saveAgent({ ...form, modelId }, editingId);
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
          <div className="pixel-kicker">AGENT ROSTER</div>
          <h2 className="text-xl font-bold">{t("agents_title")}</h2>
          <p className="mt-1 text-sm text-neutral-500">{t("agents_subtitle")}</p>
        </div>
        <button className="pixel-button pixel-button--primary px-4 py-2 text-sm" onClick={startCreate}>
          + {t("agent_create")}
        </button>
      </div>

      {agents.length === 0 ? (
        <button className="pixel-empty w-full p-8 text-sm text-neutral-500" onClick={startCreate}>
          {t("agents_empty")}
        </button>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {agents.map((agent) => (
            <article key={agent.id} className="pixel-card group flex gap-4 p-4">
              <AgentAvatar src={agent.avatar} label={agent.nickname} size={72} />
              <div className="min-w-0 flex-1">
                <div className="truncate font-bold">{agentLabel(agent)}</div>
                <div className="mt-1 truncate text-xs text-neutral-500">
                  {providerName(agent.providerId)}
                </div>
                {agent.role && <div className="pixel-chip mt-3 inline-block">{agent.role}</div>}
              </div>
              <div className="flex shrink-0 flex-col gap-2 opacity-70 transition group-hover:opacity-100">
                <button className="pixel-button px-2 py-1 text-xs" onClick={() => startEdit(agent)}>
                  {t("edit")}
                </button>
                <button
                  className="pixel-button pixel-button--danger px-2 py-1 text-xs"
                  onClick={() => {
                    sfx.delete();
                    void removeAgent(agent.id);
                  }}
                >
                  {t("delete")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}

      {open && (
        <div className="pixel-dialog-backdrop" role="presentation" onMouseDown={close}>
          <div
            className="pixel-dialog max-h-[88vh] w-[min(760px,calc(100vw-48px))] overflow-y-auto p-5"
            role="dialog"
            aria-modal="true"
            aria-label={editingId ? t("agent_edit") : t("agent_create")}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-5 flex items-start justify-between">
              <div>
                <div className="pixel-kicker">PERSONA CONFIG</div>
                <h3 className="text-lg font-bold">{editingId ? t("agent_edit") : t("agent_create")}</h3>
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

            <form onSubmit={submit} className="space-y-5">
              <div className="pixel-identity-panel flex gap-5 p-4">
                <AgentAvatar src={form.avatar} label={form.nickname} size={104} />
                <div className="min-w-0 flex-1 space-y-3">
                  <div className="flex items-end gap-2">
                    <label className="min-w-0 flex-1 text-sm">
                      {t("nickname")}
                      <input
                        className={input}
                        required
                        aria-invalid={duplicateNickname}
                        value={form.nickname}
                        onChange={(event) => {
                          setForm({ ...form, nickname: event.target.value });
                          setError(null);
                        }}
                      />
                    </label>
                    <button type="button" className="pixel-button px-3 py-2 text-sm" onClick={shuffleIdentity}>
                      ↻ {t("shuffle_identity")}
                    </button>
                  </div>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {AGENT_AVATARS.map((avatar) => (
                      <button
                        key={avatar}
                        type="button"
                        className={`pixel-avatar-choice ${avatar === form.avatar ? "is-selected" : ""}`}
                        onClick={() => setForm({ ...form, avatar })}
                      >
                        <AgentAvatar src={avatar} label="" size={42} lively={false} />
                      </button>
                    ))}
                    <button
                      type="button"
                      className={`pixel-avatar-choice px-2 text-xs ${!AGENT_AVATARS.includes(form.avatar as (typeof AGENT_AVATARS)[number]) ? "is-selected" : ""}`}
                      onClick={() => avatarInputRef.current?.click()}
                      title={t("avatar_upload_hint")}
                    >
                      ↑ {t("avatar_upload")}
                    </button>
                    <input
                      ref={avatarInputRef}
                      className="sr-only"
                      type="file"
                      accept={AGENT_AVATAR_ACCEPT}
                      onChange={selectAvatarFile}
                    />
                  </div>
                  {duplicateNickname && <p className="text-xs text-red-700">{t("nickname_duplicate")}</p>}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <label className="text-sm">
                  {t("provider")}
                  <select className={input} required value={form.providerId} onChange={(e) => setForm({ ...form, providerId: e.target.value })}>
                    <option value="">{t("provider_select")}</option>
                    {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
                  </select>
                </label>
                <label className="text-sm">
                  {t("model_optional")}
                  {models && models.length > 0 && !manualModel ? (
                    <div className="flex gap-1">
                      <select
                        className={input}
                        value={form.modelId}
                        onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                      >
                        <option value="">{t("model_default_option")}</option>
                        {form.modelId && !models.includes(form.modelId) && (
                          <option value={form.modelId}>{form.modelId}</option>
                        )}
                        {models.map((m) => (
                          <option key={m} value={m}>
                            {m}
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
                        placeholder={providers.find((p) => p.id === form.providerId)?.defaultModel ?? ""}
                        value={form.modelId}
                        onChange={(e) => setForm({ ...form, modelId: e.target.value })}
                      />
                      {models && models.length > 0 && (
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
                </label>
                <label className="text-sm">
                  {t("temperature_optional")}
                  <input className={input} type="number" step="0.1" min="0" max="2" value={form.temperature} onChange={(e) => setForm({ ...form, temperature: e.target.value })} />
                </label>
                <label className="col-span-2 text-sm">
                  {t("role")}
                  <input className={input} placeholder={t("role_placeholder")} value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })} />
                </label>
                <label className="col-span-2 text-sm">
                  {t("system_prompt")}
                  <textarea className={`${input} h-24`} value={form.systemPrompt} onChange={(e) => setForm({ ...form, systemPrompt: e.target.value })} />
                </label>
              </div>
              {error && <p className="text-sm text-red-700">{error}</p>}
              <div className="flex justify-end gap-3">
                <button type="button" className="pixel-button px-4 py-2 text-sm" onClick={close}>{t("cancel")}</button>
                <button disabled={duplicateNickname} type="submit" className="pixel-button pixel-button--primary px-5 py-2 text-sm">{editingId ? t("save") : t("create")}</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
