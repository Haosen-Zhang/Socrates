import { useEffect } from "react";
import { useStore, useT } from "./store";
import { LANGS } from "./i18n";
import ProvidersPage from "./ProvidersPage";
import AgentsSection from "./AgentsSection";
import ChatPage from "./ChatPage";

const BADGE_CLS: Record<string, string> = {
  connecting: "text-amber-700",
  connected: "text-green-700",
  disconnected: "text-red-700",
};

function LanguageSection() {
  const { lang, setLang } = useStore();
  const t = useT();
  return (
    <section className="rounded border border-neutral-200 bg-white p-4">
      <h3 className="mb-3 text-sm font-semibold">{t("language")}</h3>
      <div className="flex gap-2">
        {LANGS.map((l) => (
          <button
            key={l.value}
            className={`rounded px-3 py-1 text-sm ${
              lang === l.value
                ? "bg-neutral-900 text-white"
                : "border border-neutral-300 text-neutral-600 hover:bg-neutral-100"
            }`}
            onClick={() => setLang(l.value)}
          >
            {l.label}
          </button>
        ))}
      </div>
    </section>
  );
}

function App() {
  const { status, view, setView, connect } = useStore();
  const t = useT();
  useEffect(() => {
    void connect();
  }, [connect]);

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
    <main className="pixel-app min-h-screen text-neutral-900">
      <header className="pixel-header flex items-center justify-between bg-white px-4 py-2.5">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Socrates</h1>
          {tab("chat", t("tab_chat"))}
          {tab("settings", t("tab_settings"))}
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
        <div className="mx-auto max-w-3xl space-y-8 p-6">
          <LanguageSection />
          <ProvidersPage />
          <AgentsSection />
        </div>
      )}
    </main>
  );
}

export default App;
