import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { loadLang, persistLang, tr, type Lang } from "./i18n";
import {
  parseSseChunk,
  type Agent,
  type Provider,
  type ProviderType,
  type AppConfig,
  type Room,
  type StoredMessage,
  type TaskSummary,
  type TestOutcome,
  type WorkspaceRecord,
  type ConversationSession,
  type SessionMessage,
  type RuntimeEvent,
  type ApprovalDecision,
  type AttachmentRecord,
  type WorkspaceRef,
  type McpServerInput,
  type McpServerRecord,
} from "@socrates/core";
import { relativeWorkspacePath } from "./workspace/workspacePath";

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
  nickname: string;
  avatar: string;
  providerId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  temperature: string; // 表单态，空串=未设置
};

export type TestResult = { outcome: TestOutcome; status?: number; detail?: string };
export type StreamingTurn = {
  agentName: string;
  agentAvatar?: string;
  model: string;
  text: string;
  round?: number;
  phase?: "discussion" | "summary";
  duty?: string;
};

export type PendingApproval = {
  id: string;
  kind: string;
  subjectId: string;
  risk: string;
  freshHumanRequired: boolean;
  status: string;
};
export type WorkspacePathResult = { relativePath: string; kind: "file" | "directory" };
export type McpToolView = {
  name: string; namespacedName: string; description: string; generation: number; risk: string;
  enabled: boolean; effect: "allow" | "ask" | "deny"; riskOverride: string | null;
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

  /** config.toml（sidecar 持久化的非敏感配置）；连接后加载 */
  config: AppConfig | null;
  updateConfig: (patch: Partial<AppConfig>) => Promise<void>;

  workspaces: WorkspaceRecord[];
  activeWorkspace: WorkspaceRecord | null;
  loadWorkspaces: () => Promise<void>;
  selectWorkspacePath: (path: string) => Promise<void>;

  sessions: ConversationSession[];
  currentSessionId: string | null;
  sessionMessages: SessionMessage[];
  agentEvents: RuntimeEvent[];
  pendingApprovals: PendingApproval[];
  agentRunning: boolean;
  agentError: string | null;
  activeAgentRunId: string | null;
  loadSessions: () => Promise<void>;
  createAgentSession: (title: string, agentId: string) => Promise<void>;
  selectAgentSession: (id: string) => Promise<void>;
  sendAgentPrompt: (prompt: string, sandbox: "read-only" | "workspace-write") => Promise<boolean>;
  decideAgentApproval: (requestId: string, decision: ApprovalDecision) => Promise<void>;
  cancelAgentRun: () => Promise<void>;
  draftAttachments: AttachmentRecord[];
  workspacePathResults: WorkspacePathResult[];
  importWorkspaceAttachment: (absolutePath: string) => Promise<void>;
  importClipboardAttachment: (file: File) => Promise<void>;
  removeDraftAttachment: (id: string) => void;
  searchWorkspacePaths: (query: string) => Promise<void>;
  draftWorkspaceRefs: WorkspaceRef[];
  addWorkspaceRef: (relativePath: string) => Promise<void>;
  removeDraftWorkspaceRef: (id: string) => void;

  mcpServers: McpServerRecord[];
  mcpTools: Record<string, McpToolView[]>;
  loadMcpServers: () => Promise<void>;
  saveMcpServer: (server: McpServerInput, secrets: Record<string, string>, editingId?: string) => Promise<void>;
  setMcpEnabled: (id: string, enabled: boolean) => Promise<void>;
  testMcpServer: (id: string) => Promise<void>;
  removeMcpServer: (id: string) => Promise<void>;
  loadMcpTools: (id: string) => Promise<void>;
  setMcpToolPolicy: (serverId: string, toolName: string, effect: "allow" | "ask" | "deny") => Promise<void>;

  providers: Provider[];
  testResults: Record<string, TestResult | "running">;
  loadProviders: () => Promise<void>;
  saveProvider: (form: ProviderForm, editingId: string | null) => Promise<void>;
  removeProvider: (id: string) => Promise<void>;
  testProvider: (id: string) => Promise<void>;

  /** providerId → 该供应商的可用模型型号（拉取失败为 []，前端退化为手输） */
  modelLists: Record<string, string[]>;
  loadModels: (providerId: string, force?: boolean) => Promise<void>;

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
  /** 回溯到某条消息（删除它与其后的所有消息），随后重载房间 */
  rewindTo: (messageId: string) => Promise<void>;
  cancelTask: () => Promise<void>;
  decideTurn: (action: "retry" | "skip" | "abort") => Promise<void>;
  loadRooms: () => Promise<void>;
  createRoom: (name: string, agentIds: string[]) => Promise<void>;
  addRoomAgent: (roomId: string, agentId: string) => Promise<void>;
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
                agentAvatar:
                  e.agentAvatar ?? get().agents.find((agent) => agent.id === e.agentId)?.avatar,
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
      if (get().handshake) void get().updateConfig({ language: lang });
    },

    config: null,
    workspaces: [],
    activeWorkspace: null,
    sessions: [],
    currentSessionId: null,
    sessionMessages: [],
    agentEvents: [],
    pendingApprovals: [],
    agentRunning: false,
    agentError: null,
    activeAgentRunId: null,
    draftAttachments: [],
    workspacePathResults: [],
    draftWorkspaceRefs: [],
    mcpServers: [],
    mcpTools: {},
    updateConfig: async (patch) => {
      const res = await sidecarFetch(hs(), "/config", { method: "PUT", body: JSON.stringify(patch) });
      const config = (await res.json()) as AppConfig;
      set({ config });
      if (config.language !== get().lang) {
        persistLang(config.language);
        set({ lang: config.language });
      }
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
              try {
                const cfg = (await (await sidecarFetch(handshake, "/config")).json()) as AppConfig;
                set({ config: cfg, lang: cfg.language });
                persistLang(cfg.language);
              } catch {
                // 配置加载失败不阻塞连接，沿用本地默认
              }
              await Promise.all([get().loadProviders(), get().loadAgents(), get().loadRooms(), get().loadWorkspaces(), get().loadSessions(), get().loadMcpServers()]);
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

    loadWorkspaces: async () => {
      const workspaces = await requireOk<WorkspaceRecord[]>(await sidecarFetch(hs(), "/workspaces"));
      set((state) => ({ workspaces, activeWorkspace: state.activeWorkspace ?? workspaces[0] ?? null }));
    },
    selectWorkspacePath: async (path) => {
      const activeWorkspace = await requireOk<WorkspaceRecord>(
        await sidecarFetch(hs(), "/workspaces", { method: "POST", body: JSON.stringify({ path }) }),
      );
      set({ activeWorkspace });
      await get().loadWorkspaces();
      await get().loadMcpServers();
    },
    loadSessions: async () => {
      set({ sessions: await requireOk<ConversationSession[]>(await sidecarFetch(hs(), "/sessions")) });
    },
    createAgentSession: async (title, agentId) => {
      const agent = get().agents.find((item) => item.id === agentId);
      const workspace = get().activeWorkspace;
      if (!agent || !workspace) throw new Error("agent_and_workspace_required");
      const session = await requireOk<ConversationSession>(await sidecarFetch(hs(), "/sessions", {
        method: "POST",
        body: JSON.stringify({
          title,
          mode: "single_agent",
          workspaceId: workspace.id,
          agents: [{ agentId, snapshot: agent, executionEligible: true }],
        }),
      }));
      await get().loadSessions();
      await get().selectAgentSession(session.id);
    },
    selectAgentSession: async (id) => {
      const sessionMessages = await requireOk<SessionMessage[]>(await sidecarFetch(hs(), `/sessions/${id}/messages`));
      set({ currentSessionId: id, currentRoomId: null, messages: [], sessionMessages, agentEvents: [], pendingApprovals: [], agentError: null });
    },
    sendAgentPrompt: async (prompt, sandbox) => {
      const sessionId = get().currentSessionId;
      if (!sessionId || get().agentRunning) return false;
      set({ agentRunning: true, activeAgentRunId: null, agentEvents: [], pendingApprovals: [], agentError: null });
      let runError: string | null = null;
      try {
        const response = await sidecarFetch(hs(), `/agent/sessions/${sessionId}/runs`, {
          method: "POST",
          body: JSON.stringify({
            prompt,
            attachmentIds: get().draftAttachments.map((attachment) => attachment.id),
            workspaceRefIds: get().draftWorkspaceRefs.map((reference) => reference.id),
            runtimeKind: sandbox === "read-only" ? "native_ai_sdk" : "codex_app_server",
            runtimeOptions: { sandbox },
          }),
        });
        if (!response.ok || !response.body) await requireOk(response);
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split("\n\n");
          buffer = blocks.pop() ?? "";
          for (const block of blocks) {
            const data = block.split("\n").find((line) => line.startsWith("data:"))?.slice(5).trim();
            if (!data) continue;
            const event = JSON.parse(data) as RuntimeEvent | { status: string; error?: string };
            if ("type" in event) {
              set((state) => ({ agentEvents: [...state.agentEvents, event] }));
              if (event.type === "extension" && event.name === "run_started" && event.payload && typeof event.payload === "object" && "runId" in event.payload) {
                set({ activeAgentRunId: String((event.payload as { runId: unknown }).runId) });
              }
              if (event.type === "approval_required") {
                const pendingApprovals = await requireOk<PendingApproval[]>(await sidecarFetch(hs(), "/agent/approvals"));
                set({ pendingApprovals });
              }
            } else if (event.status === "failed") {
              runError = event.error ?? "agent_run_failed";
              set({ agentError: runError });
            } else if (event.status === "cancelled") {
              runError = tr(get().lang, "task_cancelled_notice");
              set({ agentError: runError });
            }
          }
        }
        if (!runError) set({ draftAttachments: [], draftWorkspaceRefs: [], workspacePathResults: [] });
      } catch (error) {
        runError = error instanceof Error ? error.message : String(error);
        set({ agentError: runError });
      } finally {
        const sessionMessages = await requireOk<SessionMessage[]>(await sidecarFetch(hs(), `/sessions/${sessionId}/messages`));
        set({ agentRunning: false, activeAgentRunId: null, sessionMessages });
        await get().loadSessions();
      }
      return runError === null;
    },
    decideAgentApproval: async (requestId, decision) => {
      await requireOk(await sidecarFetch(hs(), `/agent/approvals/${requestId}/decision`, {
        method: "POST",
        body: JSON.stringify({ decision, clientDecisionKey: crypto.randomUUID() }),
      }));
      set((state) => ({ pendingApprovals: state.pendingApprovals.filter((approval) => approval.id !== requestId) }));
    },
    cancelAgentRun: async () => {
      const runId = get().activeAgentRunId;
      if (!runId) return;
      await requireOk(await sidecarFetch(hs(), `/agent/runs/${runId}/cancel`, { method: "POST" }));
    },
    importWorkspaceAttachment: async (absolutePath) => {
      const state = get();
      if (state.draftAttachments.length >= 10) throw new Error("attachment_count_exceeded");
      const boundId = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
      const workspace = (boundId ? state.workspaces.find((item) => item.id === boundId) : null) ?? state.activeWorkspace;
      if (!workspace) throw new Error("workspace_required");
      const relativePath = relativeWorkspacePath(workspace.canonicalPath, absolutePath);
      const attachment = await requireOk<AttachmentRecord>(await sidecarFetch(hs(), "/content/attachments/import", {
        method: "POST",
        body: JSON.stringify({ workspaceId: workspace.id, relativePath }),
      }));
      if (state.draftAttachments.reduce((total, item) => total + item.byteSize, 0) + attachment.byteSize > 50 * 1024 * 1024) throw new Error("attachment_batch_too_large");
      set((state) => ({ draftAttachments: state.draftAttachments.some((item) => item.id === attachment.id) ? state.draftAttachments : [...state.draftAttachments, attachment] }));
    },
    importClipboardAttachment: async (file) => {
      const state = get();
      if (state.draftAttachments.length >= 10) throw new Error("attachment_count_exceeded");
      if (state.draftAttachments.reduce((total, item) => total + item.byteSize, 0) + file.size > 50 * 1024 * 1024) throw new Error("attachment_batch_too_large");
      const boundId = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
      const workspace = (boundId ? state.workspaces.find((item) => item.id === boundId) : null) ?? state.activeWorkspace;
      if (!workspace) throw new Error("workspace_required");
      const filename = file.name || `clipboard-${Date.now()}.${file.type === "image/png" ? "png" : "bin"}`;
      const attachment = await requireOk<AttachmentRecord>(await sidecarFetch(
        hs(),
        `/content/attachments/upload?workspaceId=${encodeURIComponent(workspace.id)}&filename=${encodeURIComponent(filename)}`,
        { method: "POST", headers: { "Content-Type": file.type || "application/octet-stream" }, body: file },
      ));
      set((current) => ({ draftAttachments: current.draftAttachments.some((item) => item.id === attachment.id) ? current.draftAttachments : [...current.draftAttachments, attachment] }));
    },
    removeDraftAttachment: (id) => set((state) => ({ draftAttachments: state.draftAttachments.filter((item) => item.id !== id) })),
    searchWorkspacePaths: async (query) => {
      const state = get();
      const boundId = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
      const workspace = (boundId ? state.workspaces.find((item) => item.id === boundId) : null) ?? state.activeWorkspace;
      if (!workspace) return set({ workspacePathResults: [] });
      const response = await sidecarFetch(hs(), `/content/workspaces/${workspace.id}/files?q=${encodeURIComponent(query)}`);
      set({ workspacePathResults: await requireOk<WorkspacePathResult[]>(response) });
    },
    addWorkspaceRef: async (relativePath) => {
      const state = get();
      const boundId = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
      const workspace = (boundId ? state.workspaces.find((item) => item.id === boundId) : null) ?? state.activeWorkspace;
      if (!workspace) throw new Error("workspace_required");
      const reference = await requireOk<WorkspaceRef>(await sidecarFetch(hs(), `/content/workspaces/${workspace.id}/refs`, {
        method: "POST",
        body: JSON.stringify({ relativePath }),
      }));
      set((state) => ({
        draftWorkspaceRefs: state.draftWorkspaceRefs.some((item) => item.id === reference.id) ? state.draftWorkspaceRefs : [...state.draftWorkspaceRefs, reference],
        workspacePathResults: [],
      }));
    },
    removeDraftWorkspaceRef: (id) => set((state) => ({ draftWorkspaceRefs: state.draftWorkspaceRefs.filter((item) => item.id !== id) })),
    loadMcpServers: async () => {
      const workspaceId = get().activeWorkspace?.id;
      const query = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
      set({ mcpServers: await requireOk<McpServerRecord[]>(await sidecarFetch(hs(), `/mcp/servers${query}`)) });
    },
    saveMcpServer: async (server, secrets, editingId) => {
      await requireOk(await sidecarFetch(hs(), editingId ? `/mcp/servers/${editingId}` : "/mcp/servers", {
        method: editingId ? "PUT" : "POST",
        body: JSON.stringify({ server, secrets }),
      }));
      await get().loadMcpServers();
    },
    setMcpEnabled: async (id, enabled) => {
      await requireOk(await sidecarFetch(hs(), `/mcp/servers/${id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled }) }));
      await Promise.all([get().loadMcpServers(), get().loadMcpTools(id)]);
    },
    testMcpServer: async (id) => {
      await requireOk(await sidecarFetch(hs(), `/mcp/servers/${id}/test`, { method: "POST" }));
      await Promise.all([get().loadMcpServers(), get().loadMcpTools(id)]);
    },
    removeMcpServer: async (id) => {
      await requireOk(await sidecarFetch(hs(), `/mcp/servers/${id}`, { method: "DELETE" }));
      set((state) => {
        const mcpTools = { ...state.mcpTools };
        delete mcpTools[id];
        return { mcpTools };
      });
      await get().loadMcpServers();
    },
    loadMcpTools: async (id) => {
      const tools = await requireOk<McpToolView[]>(await sidecarFetch(hs(), `/mcp/servers/${id}/tools`));
      set((state) => ({ mcpTools: { ...state.mcpTools, [id]: tools } }));
    },
    setMcpToolPolicy: async (serverId, toolName, effect) => {
      await requireOk(await sidecarFetch(hs(), `/mcp/servers/${serverId}/tools/${encodeURIComponent(toolName)}/policy`, {
        method: "PUT", body: JSON.stringify({ effect }),
      }));
      await get().loadMcpTools(serverId);
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

    modelLists: {},
    loadModels: async (providerId, force = false) => {
      if (!force && get().modelLists[providerId]) return;
      let models: string[] = [];
      try {
        const res = await sidecarFetch(hs(), `/providers/${providerId}/models`);
        if (res.ok) models = await res.json();
      } catch {
        // 网络失败 → 空列表，UI 退化为手输
      }
      set((s) => ({ modelLists: { ...s.modelLists, [providerId]: models } }));
    },

    loadAgents: async () => {
      set({ agents: await (await sidecarFetch(hs(), "/agents")).json() });
    },
    saveAgent: async (form, editingId) => {
      const payload = {
        nickname: form.nickname,
        avatar: form.avatar,
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
    addRoomAgent: async (roomId, agentId) => {
      await requireOk(
        await sidecarFetch(hs(), `/rooms/${roomId}/agents`, {
          method: "POST",
          body: JSON.stringify({ agentId }),
        }),
      );
      await get().loadRooms();
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
      set({ currentRoomId: id, currentSessionId: null, messages: [], sessionMessages: [], tasks: [], chatError: null });
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

    rewindTo: async (messageId) => {
      const roomId = get().currentRoomId;
      if (!roomId || get().streaming || get().activeTaskId) return;
      await requireOk(
        await sidecarFetch(hs(), `/rooms/${roomId}/rewind`, {
          method: "POST",
          body: JSON.stringify({ messageId }),
        }),
      );
      await get().selectRoom(roomId);
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
