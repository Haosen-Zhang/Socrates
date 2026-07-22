import { useCallback, useEffect, useState } from "react";
import { useT } from "./store";
import { APP_KEYS, useStorePick } from "./selectors";
import { setSfxEnabled, sfx } from "./fx";
import GlobalFxLayer from "./fx/GlobalFxLayer";
import { shouldPlayHoverFor } from "./fx/interactiveEntry";
import ChatPage from "./ChatPage";
import SettingsOverlayHost from "./settings/SettingsOverlayHost";
import {
  INITIAL_SETTINGS_OVERLAY,
  closeSettings,
  isSettingsShortcut,
  openSettings,
  type SettingsSection,
} from "./settings/settingsOverlay";

const BADGE_CLS: Record<string, string> = {
  connecting: "text-amber-700",
  connected: "text-green-700",
  disconnected: "text-red-700",
};

function App() {
  const { status, config, connect } = useStorePick(...APP_KEYS);
  const t = useT();
  // Settings 是 overlay，不占用导航 target——关闭后回到原房间
  const [settings, setSettings] = useState(INITIAL_SETTINGS_OVERLAY);
  const showSettings = useCallback((section?: SettingsSection) => {
    setSettings((current) => openSettings(current, section));
  }, []);
  const hideSettings = useCallback(() => setSettings(closeSettings), []);
  useEffect(() => {
    void connect();
  }, [connect]);

  // 主题/字号/字体来自 config.toml，套到根元素供 CSS 变量消费
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = config?.theme ?? "light";
    root.dataset.uiTheme = config?.appearance.uiTheme ?? "socrates-classic";
    root.style.setProperty("--app-font-size", `${config?.appearance.fontSize ?? 14}px`);
    const family =
      config?.appearance.fontFamily === "system"
        ? 'system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif'
        : 'ui-monospace, "SFMono-Regular", Menlo, Monaco, Consolas, monospace';
    root.style.setProperty("--app-font-family", family);
  }, [config?.theme, config?.appearance.fontSize, config?.appearance.fontFamily, config?.appearance.uiTheme]);

  useEffect(() => {
    setSfxEnabled(config?.soundEnabled ?? true);
  }, [config?.soundEnabled]);

  // 全局按钮音效：委托到 document，不逐个组件接线；enabled 由 fx 内部把关
  useEffect(() => {
    const isBtn = (target: EventTarget | null) => (target as HTMLElement | null)?.closest?.("button");
    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== "touch" && shouldPlayHoverFor(event.target, event.relatedTarget)) sfx.hover();
    };
    const onDown = (e: PointerEvent) => {
      if (isBtn(e.target)) sfx.click();
    };
    document.addEventListener("pointerover", onOver, { passive: true });
    document.addEventListener("pointerdown", onDown, { passive: true });
    return () => {
      document.removeEventListener("pointerover", onOver);
      document.removeEventListener("pointerdown", onDown);
    };
  }, []);

  // ⌘, / Ctrl+,：始终聚焦同一个实例（openSettings 保证单例）
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSettingsShortcut(event)) return;
      event.preventDefault();
      showSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [showSettings]);

  // 原生菜单 Socrates > Settings…；listener 随组件卸载注销，重挂载不会重复注册
  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen("menu://settings", () => showSettings()))
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch(() => {
        // 非 Tauri 环境（如浏览器预览）没有原生菜单，忽略
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [showSettings]);

  return (
    <main className="pixel-app text-neutral-900">
      <GlobalFxLayer />
      <header className="pixel-header flex h-[var(--app-header-height)] items-center justify-between bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Socrates</h1>
        </div>
        <span className={`text-sm font-medium ${BADGE_CLS[status]}`}>{t(status)}</span>
      </header>
      {status !== "connected" ? (
        <p className="p-6 text-sm text-neutral-500">
          {status === "connecting" ? t("waiting_sidecar") : t("sidecar_failed")}
        </p>
      ) : (
        <ChatPage onOpenSettings={showSettings} />
      )}
      <SettingsOverlayHost open={settings.open} focusNonce={settings.focusNonce} onClose={hideSettings} />
    </main>
  );
}

export default App;
