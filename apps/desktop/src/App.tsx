import { useEffect } from "react";
import { useStore, useT } from "./store";
import { setSfxEnabled, sfx } from "./fx";
import GlobalFxLayer from "./fx/GlobalFxLayer";
import { shouldPlayHoverFor } from "./fx/interactiveEntry";
import PixelIcon from "./PixelIcon";
import ChatPage from "./ChatPage";
import Settings from "./Settings";

const BADGE_CLS: Record<string, string> = {
  connecting: "text-amber-700",
  connected: "text-green-700",
  disconnected: "text-red-700",
};

function App() {
  const { status, view, setView, config, connect } = useStore();
  const t = useT();
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

  const tab = (v: "chat" | "settings", label: string, icon: string) => (
    <button
      className={`flex min-h-9 items-center gap-1.5 rounded px-3 py-1 text-sm ${
        view === v ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
      }`}
      onClick={() => setView(v)}
    >
      <PixelIcon name={icon} size={20} />
      {label}
    </button>
  );

  return (
    <main className="pixel-app min-h-screen text-neutral-900">
      <GlobalFxLayer />
      <header className="pixel-header flex items-center justify-between bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Socrates</h1>
          {tab("chat", t("tab_chat"), "chat")}
          {tab("settings", t("tab_settings"), "gear")}
        </div>
        <span className={`text-sm font-medium ${BADGE_CLS[status]}`}>{t(status)}</span>
      </header>
      {status !== "connected" ? (
        <p className="p-6 text-sm text-neutral-500">
          {status === "connecting" ? t("waiting_sidecar") : t("sidecar_failed")}
        </p>
      ) : (
        <div key={view} className="anim-view">
          {view === "chat" ? <ChatPage /> : <Settings />}
        </div>
      )}
    </main>
  );
}

export default App;
