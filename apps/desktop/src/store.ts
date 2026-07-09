import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadLang, persistLang, tr, type Lang } from "./i18n";
import {
  parseSseChunk,
  type Agent,
  type Provider,
  type ProviderType,
  type Room,
  type StoredMessage,
  type TaskSummary,
  type TestOutcome,
} from "@socrates/core";

type Handshake = { port: number; token: string };
export type ConnStatus = "connecting" | "connected" | "disconnected";

export type ProviderForm = {
  name: string;
  type: ProviderType;
  baseUrl: string;
  defaultModel: string;
  apiKey: string;
};

export type AgentForm = {
  displayName: string;
  providerId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  temperature: string; // 表单态，空串=未设置
};

export type TestResult = { outcome: TestOutcome; status?: number; detail?: string };
export type StreamingTurn = {
  agentName: string;
  model: string;
  text: string;
  round?: number;
  phase?: "discussion" | "summary";
  duty?: string;
};

export type DebateRoleForm = {
  proposerId: string;
  skepticId: string;
  synthesizerId: string;
  judgeId: string;
};

export type TaskForm = {
  prompt: string;
  mode: "round_robin" | "debate";
  speakingOrder: string[];
  maxRounds: number;
  finalSummarizerId: string;
  debate?: DebateRoleForm;
};

type Store = {
  status: ConnStatus;
  handshake: Handshake | null;
  view: "chat" | "settings";
  setView: (v: "chat" | "settings") => void;
  lang: Lang;
  setLang: (lang: Lang) => void;

  providers: Provider[];
  testResults: Record<string, TestResult | "running">;
  loadProviders: () => Promise<void>;
  saveProvider: (form: ProviderForm, editingId: string | null) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  testProvider: (id: string) => Promise<void>;

  agents: Agent[];
  loadAgents: () => Promise<void>;
  saveAgent: (form: AgentForm, editingId: string | null) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;

  rooms: Room[];
  currentRoomId: string | null;
  messages: StoredMessage[];
  streaming: StreamingTurn | null;
  chatError: string | null;
  /** 当前房间的历史任务（新在前） */
  tasks: TaskSummary[];
  loadTasks: () => Promise<void>;
  /** 运行中的编排任务；非空时禁止发起新讨论 */
  activeTaskId: string | null;
  /** 失败待处置的 turn（引擎挂起等 decision） */
  failedTurn: { agentName: string; message: string } | null;
  cancelTask: () => Promise<void>;
  decideTurn: (action: "retry" | "skip" | "abort") => Promise<void>;
  loadRooms: () => Promise<void>;
  createRoom: (name: string, agentIds: string[]) => Promise<void>;
  removeRoom: (id: string) => Promise<void>;
  archiveRoom: (id: string, archived: boolean) => Promise<void>;
  selectRoom: (id: string) => Promise<void>;
  sendMessage: (content: string) => Promise<void>;
  sendTask: (form: TaskForm) => Promise<void>;
  clearChatError: () => void;

  connect: () => Promise<void>;
};

const HANDSHAKE_POLL_MS = 250;
const HANDSHAKE_MAX_POLLS = 40;
let connectStarted = false; // React StrictMode 下 effect 会跑两次

async function sidecarFetch(hs: Handshake, path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`http://127.0.0.1:${hs.port}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${hs.token}`, ...init?.headers },
  });
  if (res.status >= 500) throw new Error(`sidecar ${path} 返回 ${res.status}`);
  return res;
}

async function requireOk<T>(res: Response): Promise<T> {
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `请求失败 (${res.status})`);
  return body as T;
}

export const useStore = create<Store>((set, get) => {
  const hs = () => {
    const h = get().handshake;
    if (!h) throw new Error("sidecar 未连接");
    return h;
  };

  /** POST 到当前房间的流式端点并消费 SSE，把事件映射进 store */
  const streamPost = async (suffix: string, body: unknown) => {
    const roomId = get().currentRoomId;
    if (!roomId || get().streaming || get().activeTaskId) return;
    set({ chatError: null });
    try {
      const res = await sidecarFetch(hs(), `/rooms/${roomId}${suffix}`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      if (!res.headers.get("content-type")?.includes("text/event-stream")) {
        await requireOk(res);
        return;
      }
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = parseSseChunk(buffer);
        buffer = rest;
        for (const e of events) {
          if (e.type === "user_message") {
            set((s) => ({ messages: [...s.messages, e.message], activeTaskId: e.message.taskId ?? null }));
          } else if (e.type === "turn_started") {
            set({
              failedTurn: null,
              streaming: {
                agentName: e.agentName,
                model: e.model,
                text: "",
                round: e.round,
                phase: e.phase,
                duty: e.duty,
              },
            });
          } else if (e.type === "delta") {
            set((s) =>
              s.streaming ? { streaming: { ...s.streaming, text: s.streaming.text + e.text } } : {},
            );
          } else if (e.type === "message_completed") {
            set((s) => ({ messages: [...s.messages, e.message], streaming: null }));
          } else if (e.type === "turn_failed") {
            // 任务流：引擎挂起等处置；单聊流：随后会收到 error 事件
            set({ failedTurn: { agentName: e.agentName, message: e.message }, streaming: null });
          } else if (e.type === "task_cancelled") {
            set({ chatError: tr(get().lang, "task_cancelled_notice"), streaming: null });
          } else if (e.type === "error") {
            set({ chatError: e.message, streaming: null });
          }
          // task_completed 无需处理：streaming 已随最后一条 message_completed 清空
        }
      }
    } catch (err) {
      set({ chatError: err instanceof Error ? err.message : String(err), streaming: null });
    } finally {
      set({ streaming: null, activeTaskId: null, failedTurn: null });
      void get().loadTasks();
    }
  };

  return {
    status: "connecting",
    handshake: null,
    view: "chat",
    setView: (view) => set({ view }),
    lang: loadLang(),
    setLang: (lang) => {
      persistLang(lang);
      set({ lang });
    },

    providers: [],
    testResults: {},
    agents: [],
    rooms: [],
    currentRoomId: null,
    messages: [],
    streaming: null,
    chatError: null,
    tasks: [],
    activeTaskId: null,
    failedTurn: null,

    connect: async () => {
      if (connectStarted) return;
      connectStarted = true;
      for (let i = 0; i < HANDSHAKE_MAX_POLLS; i++) {
        const handshake = await invoke<Handshake | null>("sidecar_handshake");
        if (handshake) {
          try {
            const res = await fetch(`http://127.0.0.1:${handshake.port}/health`, {
              headers: { Authorization: `Bearer ${handshake.token}` },
            });
            if (res.ok) {
              set({ handshake, status: "connected" });
              await Promise.all([get().loadProviders(), get().loadAgents(), get().loadRooms()]);
              const first = get().rooms[0];
              if (first) void get().selectRoom(first.id);
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
      set({ providers: await (await sidecarFetch(hs(), "/providers")).json() });
    },
    saveProvider: async (form, editingId) => {
      const payload: Record<string, string> = {
        name: form.name,
        baseUrl: form.baseUrl,
        defaultModel: form.defaultModel,
      };
      if (form.apiKey) payload.apiKey = form.apiKey;
      const res = editingId
        ? await sidecarFetch(hs(), `/providers/${editingId}`, { method: "PUT", body: JSON.stringify(payload) })
        : await sidecarFetch(hs(), "/providers", {
            method: "POST",
            body: JSON.stringify({ ...payload, type: form.type }),
          });
      await requireOk(res);
      await get().loadProviders();
    },
    removeProvider: async (id) => {
      await sidecarFetch(hs(), `/providers/${id}`, { method: "DELETE" });
      await get().loadProviders();
    },
    testProvider: async (id) => {
      set((s) => ({ testResults: { ...s.testResults, [id]: "running" } }));
      const result: TestResult = await (
        await sidecarFetch(hs(), `/providers/${id}/test`, { method: "POST" })
      ).json();
      set((s) => ({ testResults: { ...s.testResults, [id]: result } }));
    },

    loadAgents: async () => {
      set({ agents: await (await sidecarFetch(hs(), "/agents")).json() });
    },
    saveAgent: async (form, editingId) => {
      const payload = {
        displayName: form.displayName,
        providerId: form.providerId,
        modelId: form.modelId,
        role: form.role,
        systemPrompt: form.systemPrompt,
        temperature: form.temperature === "" ? undefined : Number(form.temperature),
      };
      const res = editingId
        ? await sidecarFetch(hs(), `/agents/${editingId}`, { method: "PUT", body: JSON.stringify(payload) })
        : await sidecarFetch(hs(), "/agents", { method: "POST", body: JSON.stringify(payload) });
      await requireOk(res);
      await get().loadAgents();
    },
    removeAgent: async (id) => {
      await sidecarFetch(hs(), `/agents/${id}`, { method: "DELETE" });
      await Promise.all([get().loadAgents(), get().loadRooms()]);
    },

    loadRooms: async () => {
      set({ rooms: await (await sidecarFetch(hs(), "/rooms")).json() });
    },
    createRoom: async (name, agentIds) => {
      const room = await requireOk<Room>(
        await sidecarFetch(hs(), "/rooms", { method: "POST", body: JSON.stringify({ name, agentIds }) }),
      );
      await get().loadRooms();
      await get().selectRoom(room.id);
    },
    removeRoom: async (id) => {
      await sidecarFetch(hs(), `/rooms/${id}`, { method: "DELETE" });
      await get().loadRooms();
      if (get().currentRoomId === id) set({ currentRoomId: null, messages: [] });
    },
    archiveRoom: async (id, archived) => {
      await sidecarFetch(hs(), `/rooms/${id}/archive`, {
        method: "PUT",
        body: JSON.stringify({ archived }),
      });
      await get().loadRooms();
      if (archived && get().currentRoomId === id) set({ currentRoomId: null, messages: [], tasks: [] });
    },
    selectRoom: async (id) => {
      set({ currentRoomId: id, messages: [], tasks: [], chatError: null });
      const messages = await requireOk<StoredMessage[]>(await sidecarFetch(hs(), `/rooms/${id}/messages`));
      // 加载期间用户可能已切换房间
      if (get().currentRoomId === id) set({ messages });
      void get().loadTasks();
    },

    loadTasks: async () => {
      const roomId = get().currentRoomId;
      if (!roomId) return;
      const tasks = await requireOk<TaskSummary[]>(await sidecarFetch(hs(), `/rooms/${roomId}/tasks`));
      if (get().currentRoomId === roomId) set({ tasks });
    },
    clearChatError: () => set({ chatError: null }),

    sendMessage: async (content) => {
      await streamPost(`/messages`, { content });
    },

    sendTask: async (form) => {
      await streamPost(`/tasks`, form);
    },

    cancelTask: async () => {
      const { currentRoomId, activeTaskId } = get();
      if (!currentRoomId || !activeTaskId) return;
      await sidecarFetch(hs(), `/rooms/${currentRoomId}/tasks/${activeTaskId}/cancel`, { method: "POST" });
    },

    decideTurn: async (action) => {
      const { currentRoomId, activeTaskId } = get();
      if (!currentRoomId || !activeTaskId) return;
      set({ failedTurn: null });
      await sidecarFetch(hs(), `/rooms/${currentRoomId}/tasks/${activeTaskId}/decision`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
    },
  };
});

/** 组件用的翻译 hook：语言切换即触发重渲染 */
export function useT() {
  const lang = useStore((s) => s.lang);
  return (key: string, vars?: Record<string, string | number>) => tr(lang, key, vars);
}
