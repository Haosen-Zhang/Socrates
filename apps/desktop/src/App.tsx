import { useEffect } from "react";
import { useStore } from "./store";
import ProvidersPage from "./ProvidersPage";
import AgentsSection from "./AgentsSection";
import ChatPage from "./ChatPage";

const BADGE: Record<string, [string, string]> = {
  connecting: ["连接中…", "text-amber-700"],
  connected: ["已连接", "text-green-700"],
  disconnected: ["未连接", "text-red-700"],
};

function App() {
  const { status, view, setView, connect } = useStore();
  useEffect(() => {
    void connect();
  }, [connect]);

  const [text, cls] = BADGE[status];
  const tab = (v: "chat" | "settings", label: string) => (
    <button
      className={`rounded px-3 py-1 text-sm ${
        view === v ? "bg-neutral-900 text-white" : "text-neutral-600 hover:bg-neutral-100"
      }`}
      onClick={() => setView(v)}
    >
      {label}
    </button>
  );

  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Socrates</h1>
          {tab("chat", "聊天")}
          {tab("settings", "设置")}
        </div>
        <span className={`text-sm font-medium ${cls}`}>{text}</span>
      </header>
      {status !== "connected" ? (
        <p className="p-6 text-sm text-neutral-500">
          {status === "connecting" ? "正在等待 sidecar 启动…" : "sidecar 未能启动，请查看日志。"}
        </p>
      ) : view === "chat" ? (
        <ChatPage />
      ) : (
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          <ProvidersPage />
          <AgentsSection />
        </div>
      )}
    </main>
  );
}

export default App;
