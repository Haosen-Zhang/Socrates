import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Provider, ProviderType, TestOutcome } from "@socrates/core";

type Handshake = { port: number; token: string };
export type ConnStatus = "connecting" | "connected" | "disconnected";

export type ProviderForm = {
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
};

export type TestResult = { outcome: TestOutcome; status?: number; detail?: string };

type Store = {
  status: ConnStatus;
  handshake: Handshake | null;
  providers: Provider[];
  testResults: Record<string, TestResult | "running">;
  connect: () => Promise<void>;
  loadProviders: () => Promise<void>;
  saveProvider: (form: ProviderForm, editingId: string | null) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  testProvider: (id: string) => Promise<void>;
};

const HANDSHAKE_POLL_MS = 250;
const HANDSHAKE_MAX_POLLS = 40;
let connectStarted = false; // React StrictMode 下 effect 会跑两次

async function sidecarFetch(hs: Handshake, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`http://127.0.0.1:${hs.port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${hs.token}`, ...init?.headers },
  });
  if (!res.ok && res.status !== 400) throw new Error(`sidecar ${path} 返回 ${res.status}`);
  return res;
}

export const useStore = create<Store>((set, get) => ({
  status: "connecting",
  handshake: null,
  providers: [],
  testResults: {},

  connect: async () => {
    if (connectStarted) return;
    connectStarted = true;
    for (let i = 0; i < HANDSHAKE_MAX_POLLS; i++) {
      const hs = await invoke<Handshake | null>("sidecar_handshake");
      if (hs) {
        try {
          const res = await fetch(`http://127.0.0.1:${hs.port}/health`, {
            headers: { Authorization: `Bearer ${hs.token}` },
          });
          if (res.ok) {
            set({ handshake: hs, status: "connected" });
            void get().loadProviders();
            return;
          }
        } catch {
          // 端口尚未就绪，继续轮询
        }
      }
      await new Promise((r) => setTimeout(r, HANDSHAKE_POLL_MS));
    }
    set({ status: "disconnected" });
  },

  loadProviders: async () => {
    const hs = get().handshake;
    if (!hs) return;
    const res = await sidecarFetch(hs, "/providers");
    set({ providers: await res.json() });
  },

  saveProvider: async (form, editingId) => {
    const hs = get().handshake;
    if (!hs) return;
    const payload: Record<string, string> = {
      name: form.name,
      baseUrl: form.baseUrl,
      defaultModel: form.defaultModel,
    };
    if (form.apiKey) payload.apiKey = form.apiKey;
    const res = editingId
      ? await sidecarFetch(hs, `/providers/${editingId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        })
      : await sidecarFetch(hs, "/providers", {
          method: "POST",
          body: JSON.stringify({ ...payload, type: form.type }),
        });
    if (res.status === 400) throw new Error((await res.json()).error);
    await get().loadProviders();
  },

  removeProvider: async (id) => {
    const hs = get().handshake;
    if (!hs) return;
    await sidecarFetch(hs, `/providers/${id}`, { method: "DELETE" });
    await get().loadProviders();
  },

  testProvider: async (id) => {
    const hs = get().handshake;
    if (!hs) return;
    set((s) => ({ testResults: { ...s.testResults, [id]: "running" } }));
    const res = await sidecarFetch(hs, `/providers/${id}/test`, { method: "POST" });
    const result: TestResult = await res.json();
    set((s) => ({ testResults: { ...s.testResults, [id]: result } }));
  },
}));
