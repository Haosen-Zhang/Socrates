import { useEffect, useMemo, useState } from "react";
import {
  normalizeAgentNickname,
  randomUniqueAgentIdentity,
  resolveReasoningProfile,
  type Agent,
  type AgentNameLanguage,
} from "@socrates/core";
import AgentIdentityEditor from "./AgentIdentityEditor";
import { useT, type AgentForm } from "./store";
import { AGENTS_SECTION_KEYS, useStorePick } from "./selectors";
import { sfx } from "./fx";
import NestedDialogPortal from "./dialog/NestedDialogPortal";
import ReasoningEffortSelect from "./ReasoningEffortSelect";

function newForm(agents: Agent[], language: AgentNameLanguage): AgentForm {
  const identity = randomUniqueAgentIdentity(
    agents.map((agent) => agent.nickname),
    Math.random,
    language,
  );
  return {
    nickname: identity.nickname,
    avatar: identity.avatar,
    providerId: "",
    modelId: "",
    role: "",
    systemPrompt: "",
    temperature: "",
    contextWindowTokens: "",
    contextWindowDirty: false,
    reasoningEffort: "auto",
  };
}

function formFromAgent(agent: Agent): AgentForm {
  return {
    nickname: agent.nickname,
    avatar: agent.avatar,
    providerId: agent.providerId,
    modelId: agent.modelId,
    role: agent.role,
    systemPrompt: agent.systemPrompt,
    temperature: agent.temperature?.toString() ?? "",
    contextWindowTokens:
      typeof agent.modelCapabilities?.contextWindowTokens === "number"
        ? String(agent.modelCapabilities.contextWindowTokens)
        : "",
    contextWindowDirty: agent.contextWindow?.source === "user_override",
    reasoningEffort: agent.reasoningEffort ?? "auto",
  };
}

export default function AgentEditor({
  agent,
  onSaved,
  onClose,
  onSetupProvider,
  suspended = false,
}: {
  agent?: Agent;
  onSaved: (agent: Agent) => void;
  onClose: () => void;
  onSetupProvider?: () => void;
  suspended?: boolean;
}) {
  const {
    agents,
    providers,
    modelLists,
    loadModels,
    modelContextWindows,
    loadModelContextWindow,
    saveAgent,
  } = useStorePick(...AGENTS_SECTION_KEYS);
  const { modelLoading, modelListErrors, lang } = useStorePick(
    "modelLoading",
    "modelListErrors",
    "lang",
  );
  const t = useT();
  const [form, setForm] = useState<AgentForm>(() =>
    agent ? formFromAgent(agent) : newForm(agents, lang),
  );
  const editingId = agent?.id ?? null;
  const open = true;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualModel, setManualModel] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);

  // 选中供应商后拉取其可用型号（缓存于 store）
  useEffect(() => {
    if (open && form.providerId) void loadModels(form.providerId);
  }, [open, form.providerId, loadModels]);
  const models = form.providerId ? modelLists[form.providerId] : undefined;

  const close = onClose;
  useEffect(() => {
    if (agent) setForm(formFromAgent(agent));
  }, [agent]);
  const duplicateNickname = agents.some(
    (agent) =>
      agent.id !== editingId &&
      normalizeAgentNickname(agent.nickname) ===
        normalizeAgentNickname(form.nickname),
  );
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (uploadingAvatar) return;
    setError(null);
    if (duplicateNickname) {
      setError(t("nickname_duplicate"));
      return;
    }
    const provider = providers.find((item) => item.id === form.providerId);
    const modelId = form.modelId.trim() || provider?.defaultModel || "";
    try {
      setSaving(true);
      const saved = await saveAgent({ ...form, modelId }, editingId);
      onSaved(saved);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const input = "pixel-input w-full px-3 py-2 text-sm";
  const selectedProvider = providers.find(
    (provider) => provider.id === form.providerId,
  );
  const effectiveModelId =
    form.modelId.trim() || selectedProvider?.defaultModel || "";
  const catalogKey =
    form.providerId && effectiveModelId
      ? `${form.providerId}:${effectiveModelId}`
      : "";
  const catalogResolution = catalogKey
    ? modelContextWindows[catalogKey]
    : undefined;
  const editingAgent = editingId
    ? agents.find((agent) => agent.id === editingId)
    : undefined;
  const capabilityOverride =
    editingAgent &&
    editingAgent.providerId === form.providerId &&
    editingAgent.modelId === effectiveModelId
      ? editingAgent.modelCapabilities?.reasoningEfforts
      : undefined;
  const reasoningProfile = useMemo(
    () =>
      resolveReasoningProfile(
        selectedProvider?.type ?? "openai_compatible",
        effectiveModelId,
        capabilityOverride,
      ),
    [selectedProvider?.type, effectiveModelId, capabilityOverride],
  );

  useEffect(() => {
    if (reasoningProfile.efforts.includes(form.reasoningEffort)) return;
    setForm((current) => ({
      ...current,
      reasoningEffort: reasoningProfile.defaultEffort,
    }));
  }, [form.reasoningEffort, reasoningProfile]);

  useEffect(() => {
    if (!open || !form.providerId || !effectiveModelId) return;
    void loadModelContextWindow(form.providerId, effectiveModelId);
  }, [open, form.providerId, effectiveModelId, loadModelContextWindow]);

  useEffect(() => {
    if (form.contextWindowDirty || !catalogResolution) return;
    setForm((current) => ({
      ...current,
      contextWindowTokens:
        catalogResolution.effectiveValue === null
          ? ""
          : String(catalogResolution.effectiveValue),
    }));
  }, [catalogResolution, form.contextWindowDirty]);

  if (suspended) return null;
  return (
    <NestedDialogPortal
      ariaLabel={editingId ? t("agent_edit") : t("agent_create")}
      className="pixel-dialog max-h-full w-full max-w-[760px] overflow-y-auto overscroll-contain p-5"
      onClose={close}
    >
      <div className="mb-5 flex items-start justify-between">
        <div>
          <div className="pixel-kicker">PERSONA CONFIG</div>
          <h3 className="text-lg font-bold">
            {editingId ? t("agent_edit") : t("agent_create")}
          </h3>
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
        {providers.length === 0 && (
          <div role="status" className="pixel-card p-3 text-sm">
            <p>{t("provider_needed")}</p>
            {onSetupProvider && (
              <button
                type="button"
                className="pixel-button mt-2 px-3 py-1"
                onClick={onSetupProvider}
              >
                {t("providers_title")}
              </button>
            )}
          </div>
        )}
        <AgentIdentityEditor
          nickname={form.nickname}
          avatar={form.avatar}
          existingNicknames={agents.filter(item => item.id !== editingId).map(item => item.nickname)}
          duplicateNickname={duplicateNickname}
          onChange={identity => setForm(current => ({ ...current, ...identity }))}
          onError={setError}
          onUploadPending={setUploadingAvatar}
        />
        {uploadingAvatar && <p role="status" className="text-xs text-neutral-500">{t("avatar_loading")}</p>}

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <label className="text-sm">
            {t("provider")}
            <select
              className={input}
              required
              value={form.providerId}
              onChange={(e) =>
                setForm({
                  ...form,
                  providerId: e.target.value,
                  modelId: "",
                  contextWindowTokens: "",
                  contextWindowDirty: false,
                  reasoningEffort: "auto",
                })
              }
            >
              <option value="">{t("provider_select")}</option>
              {providers.map((provider) => (
                <option key={provider.id} value={provider.id}>
                  {provider.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            {t("model_optional")}
            {models && models.length > 0 && !manualModel ? (
              <div className="flex gap-1">
                <select
                  className={input}
                  value={form.modelId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      modelId: e.target.value,
                      contextWindowTokens: "",
                      contextWindowDirty: false,
                      reasoningEffort: "auto",
                    })
                  }
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
                  placeholder={
                    providers.find((p) => p.id === form.providerId)
                      ?.defaultModel ?? ""
                  }
                  value={form.modelId}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      modelId: e.target.value,
                      contextWindowTokens: "",
                      contextWindowDirty: false,
                      reasoningEffort: "auto",
                    })
                  }
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
            <input
              className={input}
              type="number"
              step="0.1"
              min="0"
              max="2"
              value={form.temperature}
              onChange={(e) =>
                setForm({ ...form, temperature: e.target.value })
              }
            />
          </label>
          <label className="text-sm">
            {t("context_window_tokens")}
            <input
              className={input}
              type="number"
              step="1024"
              min="1024"
              max="4000000"
              placeholder={t("context_window_tokens_unknown")}
              value={form.contextWindowTokens}
              onChange={(event) =>
                setForm({
                  ...form,
                  contextWindowTokens: event.target.value,
                  contextWindowDirty: event.target.value !== "",
                })
              }
            />
            <span className="mt-1 block text-xs text-neutral-500">
              {form.contextWindowDirty
                ? t("context_window_source_override")
                : catalogResolution?.source === "catalog"
                  ? t("context_window_source_catalog")
                  : t("context_window_source_unavailable")}
            </span>
          </label>
          <ReasoningEffortSelect
            profile={reasoningProfile}
            value={form.reasoningEffort}
            onChange={(reasoningEffort) =>
              setForm({ ...form, reasoningEffort })
            }
          />
          <label className="text-sm md:col-span-2">
            {t("role")}
            <input
              className={input}
              placeholder={t("role_placeholder")}
              value={form.role}
              onChange={(e) => setForm({ ...form, role: e.target.value })}
            />
          </label>
          <label className="text-sm md:col-span-2">
            {t("system_prompt")}
            <textarea
              className={`${input} h-24`}
              value={form.systemPrompt}
              onChange={(e) =>
                setForm({ ...form, systemPrompt: e.target.value })
              }
            />
          </label>
        </div>
        {modelLoading[form.providerId] && (
          <p role="status" className="text-xs text-neutral-500">
            {t("model_catalog_loading")}
          </p>
        )}
        {modelListErrors[form.providerId] && (
          <p role="status" className="text-xs text-amber-700">
            {t("model_catalog_unavailable")}
            <button
              type="button"
              className="pixel-button ml-2 px-2 py-1"
              onClick={() => void loadModels(form.providerId, true)}
            >
              {t("retry")}
            </button>
          </p>
        )}
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex justify-end gap-3">
          <button
            type="button"
            className="pixel-button px-4 py-2 text-sm"
            onClick={close}
          >
            {t("cancel")}
          </button>
          <button
            disabled={saving || uploadingAvatar || duplicateNickname || !form.providerId}
            type="submit"
            className="pixel-button pixel-button--primary px-5 py-2 text-sm"
          >
            {editingId ? t("save") : t("create")}
          </button>
        </div>
      </form>
    </NestedDialogPortal>
  );
}
