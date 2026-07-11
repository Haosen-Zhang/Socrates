import { useEffect } from "react";
import { useStore, useT } from "./store";
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

  // 主题与字号来自 config.toml，套到根元素供 CSS 变量消费（深色调色板见 #37）
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = config?.theme ?? "light";
    root.style.setProperty("--app-font-size", `${config?.appearance.fontSize ?? 14}px`);
  }, [config?.theme, config?.appearance.fontSize]);

  const tab = (v: "chat" | "settings", label: string, icon: string) => (
    <button
      className={`flex items-center gap-1.5 rounded px-3 py-1 text-sm ${
        view === v ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
      }`}
      onClick={() => setView(v)}
    >
      <span aria-hidden>{icon}</span>
      {label}
    </button>
  );

  return (
    <main className="pixel-app min-h-screen text-neutral-900">
      <header className="pixel-header flex items-center justify-between bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Socrates</h1>
          {tab("chat", t("tab_chat"), "💬")}
          {tab("settings", t("tab_settings"), "⚙️")}
        </div>
        <span className={`text-sm font-medium ${BADGE_CLS[status]}`}>{t(status)}</span>
      </header>
      {status !== "connected" ? (
        <p className="p-6 text-sm text-neutral-500">
          {status === "connecting" ? t("waiting_sidecar") : t("sidecar_failed")}
        </p>
      ) : view === "chat" ? (
        <ChatPage />
      ) : (
        <Settings />
      )}
    </main>
  );
}

export default App;
