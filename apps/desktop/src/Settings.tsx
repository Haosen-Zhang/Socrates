import { useEffect, useState } from "react";
import { DEFAULT_CONFIG, type AppConfig, type ProxyConfig } from "@socrates/core";
import { useT } from "./store";
import { SETTINGS_CONFIG_KEYS, SETTINGS_GENERAL_KEYS, useStorePick } from "./selectors";
import { LANGS } from "./i18n";
import PixelIcon from "./PixelIcon";
import ProvidersPage from "./ProvidersPage";
import AgentsSection from "./AgentsSection";
import McpSettings from "./settings/McpSettings";
import { collaborationStrategyOptions } from "./collaborationSettingsUi";

const DEFAULT_PROXY = DEFAULT_CONFIG.proxy;

type SectionId = "general" | "collaboration" | "providers" | "bots" | "mcp" | "skills" | "memory" | "network" | "appearance";

const NAV: Array<{ id: SectionId; icon: string; labelKey: string }> = [
  { id: "general", icon: "general", labelKey: "nav_general" },
  { id: "collaboration", icon: "group", labelKey: "nav_collaboration" },
  { id: "providers", icon: "plug", labelKey: "nav_providers" },
  { id: "bots", icon: "robot", labelKey: "nav_bots" },
  { id: "mcp", icon: "plug", labelKey: "nav_mcp" },
  { id: "skills", icon: "spark", labelKey: "nav_skills" },
  { id: "memory", icon: "brain", labelKey: "nav_memory" },
  { id: "network", icon: "globe", labelKey: "nav_network" },
  { id: "appearance", icon: "palette", labelKey: "nav_appearance" },
];

/** 分段单选（像素风），config 尚未加载时禁用 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex gap-1">
      {options.map((o) => (
        <button
          key={o.value}
          disabled={disabled}
          className={`pixel-button px-3 py-1 text-sm ${value === o.value ? "pixel-button--primary" : ""}`}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-neutral-200 py-3 last:border-0">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {desc && <div className="text-xs text-neutral-500">{desc}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

function SectionShell({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mb-4 mt-1 text-sm text-neutral-500">{desc}</p>
      {children}
    </div>
  );
}

function GeneralSection() {
  const { config, lang, setLang, updateConfig } = useStorePick(...SETTINGS_GENERAL_KEYS);
  const t = useT();
  return (
    <SectionShell title={t("nav_general")} desc={t("general_desc")}>
      <div className="pixel-card p-4">
        <Row label={t("language")}>
          <Segmented
            value={lang}
            options={LANGS.map((l) => ({ value: l.value, label: l.label }))}
            onChange={(v) => setLang(v)}
          />
        </Row>
        <Row label={t("theme")}>
          <Segmented
            value={config?.theme ?? "light"}
            disabled={!config}
            options={[
              { value: "light", label: t("theme_light") },
              { value: "dark", label: t("theme_dark") },
            ]}
            onChange={(v) => void updateConfig({ theme: v })}
          />
        </Row>
        <Row label={t("close_behavior")}>
          <Segmented
            value={config?.closeBehavior ?? "background"}
            disabled={!config}
            options={[
              { value: "background", label: t("close_background") },
              { value: "quit", label: t("close_quit") },
            ]}
            onChange={(v) => void updateConfig({ closeBehavior: v })}
          />
        </Row>
        <Row label={t("sound_effects")}>
          <Segmented
            value={config?.soundEnabled === false ? "off" : "on"}
            disabled={!config}
            options={[
              { value: "on", label: t("on") },
              { value: "off", label: t("off") },
            ]}
            onChange={(v) => void updateConfig({ soundEnabled: v === "on" })}
          />
        </Row>
      </div>
    </SectionShell>
  );
}

function NetworkSection() {
  const { config, updateConfig } = useStorePick(...SETTINGS_CONFIG_KEYS);
  const t = useT();
  // 网络字段多，采用暂存 + 「保存」显式提交，而非逐字段即时写盘
  const [draft, setDraft] = useState<ProxyConfig>(config?.proxy ?? DEFAULT_PROXY);
  useEffect(() => {
    if (config) setDraft(config.proxy);
  }, [config]);
  const set = (patch: Partial<ProxyConfig>) => setDraft((d) => ({ ...d, ...patch }));
  const field = "pixel-input w-full px-3 py-2 text-sm";
  const custom = draft.mode === "custom";

  return (
    <div className="pixel-card p-5">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-xl font-bold">{t("nav_network")}</h2>
        <button
          className="pixel-button pixel-button--primary px-3 py-1.5 text-sm"
          disabled={!config}
          onClick={() => void updateConfig({ proxy: draft })}
        >
          {t("save_network")}
        </button>
      </div>

      <Row label={t("proxy_mode")}>
        <Segmented
          value={draft.mode}
          disabled={!config}
          options={[
            { value: "auto", label: t("proxy_auto") },
            { value: "custom", label: t("proxy_custom") },
            { value: "off", label: t("proxy_off") },
          ]}
          onChange={(mode) => set({ mode })}
        />
      </Row>

      {custom && (
        <>
          <Row label={t("proxy_type")}>
            <Segmented
              value={draft.type}
              options={[
                { value: "http", label: "HTTP" },
                { value: "https", label: "HTTPS" },
                { value: "socks5", label: "SOCKS5" },
                { value: "socks5h", label: "SOCKS5H" },
              ]}
              onChange={(type) => set({ type })}
            />
          </Row>
          <div className="grid grid-cols-[3fr_1fr] gap-3 py-3">
            <label className="text-sm">
              {t("proxy_host")}
              <input className={field} placeholder="127.0.0.1" value={draft.host} onChange={(e) => set({ host: e.target.value })} />
            </label>
            <label className="text-sm">
              {t("proxy_port")}
              <input className={field} placeholder="7890" value={draft.port} onChange={(e) => set({ port: e.target.value })} />
            </label>
          </div>
          <div className="grid grid-cols-2 gap-3 pb-3">
            <label className="text-sm">
              {t("proxy_username")}
              <input className={field} value={draft.username} onChange={(e) => set({ username: e.target.value })} />
            </label>
            <label className="text-sm">
              {t("proxy_password")}
              <input className={field} type="password" value={draft.password} onChange={(e) => set({ password: e.target.value })} />
            </label>
          </div>
          <label className="block border-t border-neutral-200 py-3 text-sm">
            {t("proxy_url")}
            <span className="ml-2 text-xs text-neutral-500">{t("proxy_url_hint")}</span>
            <input className={field} placeholder="socks5://127.0.0.1:7890" value={draft.url} onChange={(e) => set({ url: e.target.value })} />
          </label>
        </>
      )}
      <label className="block border-t border-neutral-200 pt-3 text-sm">
        {t("proxy_no")}
        <input className={field} placeholder="localhost,127.0.0.1,.local" value={draft.noProxy} onChange={(e) => set({ noProxy: e.target.value })} />
      </label>
    </div>
  );
}

function CollaborationDefaultsSection() {
  const { config, updateConfig, agentCapabilities } = useStorePick(
    "config",
    "updateConfig",
    "agentCapabilities",
  );
  const t = useT();
  const defaults = config?.collaborationDefaults ?? DEFAULT_CONFIG.collaborationDefaults;
  const routingAvailable = agentCapabilities?.collaboration.routing === true;
  const update = (patch: Partial<typeof defaults>) => {
    if (!config) return;
    void updateConfig({
      collaborationDefaults: {
        ...defaults,
        ...patch,
      },
    });
  };

  return (
    <SectionShell title={t("nav_collaboration")} desc={t("global_collaboration_desc")}>
      <div className="pixel-card p-4">
        <Row label={t("execution_strategy")}>
          <div className="flex gap-1">
            {collaborationStrategyOptions(agentCapabilities?.collaboration).map(({ strategy, enabled }) => (
              <button
                key={strategy}
                type="button"
                disabled={!config || !enabled}
                className={`pixel-button px-3 py-1 text-sm ${defaults.strategy === strategy ? "pixel-button--primary" : ""}`}
                onClick={() => update({ strategy })}
              >
                {t(`strategy_${strategy}`)}
              </button>
            ))}
          </div>
        </Row>
        <Row label={t("pre_execution_discussion")} desc={t("global_discussion_desc")}>
          <Segmented
            value={defaults.discussion.enabled ? "on" : "off"}
            disabled={!config || agentCapabilities?.collaboration.discussion !== true}
            options={[
              { value: "on", label: t("on") },
              { value: "off", label: t("off") },
            ]}
            onChange={(value) => update({
              discussion: { ...defaults.discussion, enabled: value === "on" },
            })}
          />
        </Row>
        <Row
          label={t("automatic_policy")}
          desc={!routingAvailable ? t("routing_runtime_unavailable") : undefined}
        >
          <Segmented
            value={defaults.assignment.routing.automaticPolicy}
            disabled={!config || !routingAvailable}
            options={[
              { value: "cost", label: t("routing_policy_cost") },
              { value: "balanced", label: t("routing_policy_balanced") },
              { value: "quality", label: t("routing_policy_quality") },
            ]}
            onChange={(automaticPolicy) => update({
              assignment: {
                ...defaults.assignment,
                routing: { ...defaults.assignment.routing, automaticPolicy },
              },
            })}
          />
        </Row>
        <Row label={t("plan_confirmation")}>
          <Segmented
            value="user"
            disabled={!config}
            options={[
              { value: "user", label: t("plan_confirmation_user") },
            ]}
            onChange={() => update({
              planConfirmation: { mode: "user", reviewerAgentId: null },
            })}
          />
        </Row>
      </div>
    </SectionShell>
  );
}

function AppearanceSection() {
  const { config, updateConfig } = useStorePick(...SETTINGS_CONFIG_KEYS);
  const t = useT();
  const appearance: AppConfig["appearance"] = config?.appearance ?? DEFAULT_CONFIG.appearance;
  // 拖动时只更新数字预览，松手（pointerup/keyup）才应用并落盘——避免整个界面跟着滑块抖动
  const [sizeDraft, setSizeDraft] = useState(appearance.fontSize);
  useEffect(() => {
    setSizeDraft(appearance.fontSize);
  }, [appearance.fontSize]);
  const commitSize = (v: number) => {
    if (v !== appearance.fontSize) void updateConfig({ appearance: { ...appearance, fontSize: v } });
  };
  return (
    <SectionShell title={t("nav_appearance")} desc={t("appearance_desc")}>
      <div className="pixel-card p-4">
        <div className="border-b border-neutral-200 pb-4">
          <div className="text-sm font-medium">{t("ui_theme")}</div>
          <div className="mb-3 text-xs text-neutral-500">{t("ui_theme_desc")}</div>
          <div className="grid grid-cols-2 gap-3">
            {(
              [
                { value: "socrates-classic", label: t("ui_theme_classic"), desc: t("ui_theme_classic_desc") },
                { value: "pixel-1998", label: t("ui_theme_pixel_1998"), desc: t("ui_theme_pixel_1998_desc") },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                className={`pixel-theme-choice p-3 text-left ${appearance.uiTheme === option.value ? "is-selected" : ""}`}
                disabled={!config}
                aria-pressed={appearance.uiTheme === option.value}
                onClick={() => void updateConfig({ appearance: { ...appearance, uiTheme: option.value } })}
              >
                <span className="mb-3 flex items-center gap-3">
                  <PixelIcon name="chat" size={40} theme={option.value} variant="decorative" />
                  <PixelIcon name="gear" size={40} theme={option.value} variant="decorative" />
                  <PixelIcon name="robot" size={40} theme={option.value} variant="decorative" />
                </span>
                <span className="block text-sm font-bold">{option.label}</span>
                <span className="mt-1 block text-xs text-neutral-500">{option.desc}</span>
              </button>
            ))}
          </div>
        </div>
        <Row label={t("font_size")}>
          <input
            type="range"
            min={10}
            max={24}
            disabled={!config}
            value={sizeDraft}
            onChange={(e) => setSizeDraft(Number(e.target.value))}
            onPointerUp={(e) => commitSize(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commitSize(Number((e.target as HTMLInputElement).value))}
          />
          <span className="ml-2 text-sm">{sizeDraft}px</span>
        </Row>
        <Row label={t("font_family")}>
          <Segmented
            value={appearance.fontFamily}
            disabled={!config}
            options={[
              { value: "system", label: t("font_system") },
              { value: "mono", label: "Mono" },
            ]}
            onChange={(fontFamily) => void updateConfig({ appearance: { ...appearance, fontFamily } })}
          />
        </Row>
      </div>
    </SectionShell>
  );
}

function Placeholder({ titleKey }: { titleKey: string }) {
  const t = useT();
  return (
    <SectionShell title={t(titleKey)} desc={t("coming_soon")}>
      <div className="pixel-empty grid place-items-center p-12 text-sm text-neutral-500">{t("coming_soon")}</div>
    </SectionShell>
  );
}

export default function Settings() {
  const t = useT();
  const [section, setSection] = useState<SectionId>("general");

  return (
    <div className="flex h-[calc(100vh-53px)]">
      <nav className="w-52 shrink-0 space-y-1 overflow-y-auto border-r border-neutral-200 bg-white p-3">
        {NAV.map((n) => (
          <button
            key={n.id}
            className={`flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm ${
              section === n.id ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"
            }`}
            onClick={() => setSection(n.id)}
          >
            <PixelIcon name={n.icon} size={20} />
            {t(n.labelKey)}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto p-6">
        <div key={section} className="anim-view mx-auto max-w-3xl">
          {section === "general" && <GeneralSection />}
          {section === "collaboration" && <CollaborationDefaultsSection />}
          {section === "providers" && <ProvidersPage />}
          {section === "bots" && <AgentsSection />}
          {section === "mcp" && <McpSettings />}
          {section === "skills" && <Placeholder titleKey="nav_skills" />}
          {section === "memory" && <Placeholder titleKey="nav_memory" />}
          {section === "network" && <NetworkSection />}
          {section === "appearance" && <AppearanceSection />}
        </div>
      </div>
    </div>
  );
}
