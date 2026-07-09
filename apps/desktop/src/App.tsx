import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Handshake = { port: number; token: string };
type Status = "connecting" | "connected" | "disconnected";

const HANDSHAKE_POLL_MS = 250;
const HANDSHAKE_MAX_POLLS = 40;

function App() {
  const [status, setStatus] = useState<Status>("connecting");
  const [port, setPort] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      for (let i = 0; i < HANDSHAKE_MAX_POLLS && !cancelled; i++) {
        const handshake = await invoke<Handshake | null>("sidecar_handshake");
        if (handshake) {
          try {
            const res = await fetch(`http://127.0.0.1:${handshake.port}/health`, {
              headers: { Authorization: `Bearer ${handshake.token}` },
            });
            if (res.ok && !cancelled) {
              setPort(handshake.port);
              setStatus("connected");
              return;
            }
          } catch {
            // sidecar 端口尚未就绪，继续轮询
          }
        }
        await new Promise((r) => setTimeout(r, HANDSHAKE_POLL_MS));
      }
      if (!cancelled) setStatus("disconnected");
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const badge: Record<Status, { text: string; color: string }> = {
    connecting: { text: "连接中…", color: "#b45309" },
    connected: { text: `已连接 (127.0.0.1:${port})`, color: "#15803d" },
    disconnected: { text: "未连接", color: "#b91c1c" },
  };

  return (
    <main style={{ fontFamily: "system-ui", padding: "2rem" }}>
      <h1>Socrates</h1>
      <p>
        Sidecar:{" "}
        <span style={{ color: badge[status].color, fontWeight: 600 }}>{badge[status].text}</span>
      </p>
    </main>
  );
}

export default App;
