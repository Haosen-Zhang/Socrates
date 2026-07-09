import { useEffect } from "react";
import { useStore } from "./store";
import ProvidersPage from "./ProvidersPage";

const BADGE: Record<string, [string, string]> = {
  connecting: ["连接中…", "text-amber-700"],
  connected: ["已连接", "text-green-700"],
  disconnected: ["未连接", "text-red-700"],
};

function App() {
  const { status, handshake, connect } = useStore();
  useEffect(() => {
    void connect();
  }, [connect]);

  const [text, cls] = BADGE[status];
  return (
    <main className="min-h-screen bg-neutral-50 text-neutral-900">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-6 py-3">
        <h1 className="text-lg font-semibold">Socrates</h1>
        <span className={`text-sm font-medium ${cls}`}>
          Sidecar: {text}
          {status === "connected" && handshake ? ` (127.0.0.1:${handshake.port})` : ""}
        </span>
      </header>
      {status === "connected" ? (
        <ProvidersPage />
      ) : (
        <p className="p-6 text-sm text-neutral-500">
          {status === "connecting" ? "正在等待 sidecar 启动…" : "sidecar 未能启动，请查看日志。"}
        </p>
      )}
    </main>
  );
}

export default App;
