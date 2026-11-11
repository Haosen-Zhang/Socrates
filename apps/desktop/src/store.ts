import type { WorkPackageView, TeamSummaryView } from "./roomModels";
import { initialRoomNavigation, navigateRoom, switchRoomMode, type RoomNavigation, type RoomMention, type SelectedMention } from "./roomNavigation";
import { roomCreatePayload, roomDraftBlocker, type RoomDraft } from "./roomSelection";
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
  type RoomCollaborationSettings,
  type SessionMessage,
  type RuntimeEvent,
  type ApprovalDecision,
  type AttachmentRecord,
  type WorkspaceRef,
  type McpServerInput,
  type McpServerRecord,
  type ReasoningEffort,
  type NormalizedUsage,
  type ToolRisk,
  type ToolApprovalCapabilities,
  type ToolApprovalMode,
  type CollaborationRuntimeCapabilities,
  type TaskState,
  executionEventToRuntimeEvent,
} from "@socrates/core";
import { relativeWorkspacePath } from "./workspace/workspacePath";
import { resolveActiveWorkspace } from "./workspace/projectSelection";
import { sidecarFetch, requireOk, streamSseEvents } from "./transport";
import { commandCostBody } from "./cost/client";
import type { CostOptions } from "./cost/ui-state";
import { decodeExecutionEvent } from "./protocol";
import { commitApprovalPolicyUpdate } from "./approvalPolicyUi";
import {
  type ActiveAgentRunObserver,
  RetryableAgentRunProjectionError,
  observeDurableRun,
  pollAgentRunUntilTerminal,
  type AgentRunStatusView,
} from "./agentRunTransport";
import {
  advanceActiveAgentRunCursor,
  clearActiveAgentRunCursor,
  readActiveAgentRunCursor,
  writeActiveAgentRunCursor,
} from "./agentRunCursor";

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
  contextWindowTokens: string; // 空串=目录不可用；不会猜测默认值
  contextWindowDirty: boolean;
  reasoningEffort: ReasoningEffort;
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
  taskId?: string;
  risk: ToolRisk;
  freshHumanRequired: boolean;
  sessionId?: string;
  toolGeneration?: number;
  status: "pending" | "allowed" | "denied" | "expired";
};
export type UsageSummaryView = { agentId: string | null; current: NormalizedUsage; cumulative: NormalizedUsage; records: number };
export type WorkspacePathResult = { relativePath: string; kind: "file" | "directory" };
export type McpToolView = {
  name: string; namespacedName: string; description: string; generation: number; risk: string;
  enabled: boolean; effect: "allow" | "ask" | "deny"; riskOverride: string | null;
};
export type MultiPlan = {
  version: number; contentHash: string; status: string;
  content: { objective: string; summary: string; steps: Array<{ id: string; title: string; description: string; files: string[]; commands: string[]; risks: string[]; verification: string[] }>; evidence: Array<{ refId: string; snapshotHash: string }> };
};
export type MultiTaskView = {
  workPackages?: WorkPackageView[];
  summary?: string | TeamSummaryView;
  id: string; sessionId: string; prompt: string; state: TaskState; resumeFrom: string | null; terminalReason: string | null; outcomeUnknown: boolean; requiresExecutionReview: boolean;
  config: { clientRequestId?: string; costRootTaskId?:string; routeDecisionId?:string; speakingOrder: string[]; maxRounds: number; synthesizerId: string; executionAgentId: string; effortByAgent?: Record<string, ReasoningEffort>; fallbackOrderByAgent?: Record<string, string[]> };
  plan: MultiPlan | null;
  turns: Array<{ id: string; phase: string; round: number; agentId: string; snapshot: Record<string, unknown>; status: string; content: string | null; usage: { inputTokens?: number; outputTokens?: number } | null; error: string | null }>;
  pendingApprovals: PendingApproval[];
  usageSummaries: Array<{ agentId: string | null; current: NormalizedUsage; cumulative: NormalizedUsage; records: number }>;
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

export function mergeSessionMessages(current:SessionMessage[], incoming:SessionMessage[]):SessionMessage[] {
  const messages=new Map(current.map(message=>[message.id,message]));
  for(const message of incoming) messages.set(message.id,message);
  return [...messages.values()].sort((a,b)=>a.sequence-b.sequence);
}

export type RoomCommandIntent = "respond" | "discuss" | "execute";
export type RoomOperationTarget = { roomId: string; workspaceId: string; canonicalPath: string };
export type RoomProjection = Pick<Store,
  "multiLiveStreams" |
  "historyGeneration" | "historyRequestVersion" | "historyRevision" | "taskRequestVersion" | "attachmentError" | "attachmentImports" |
  "sessionMessages" | "agentEvents" | "agentStreamText" | "pendingApprovals" | "agentRunning" | "agentError" | "activeAgentRunId" |
  "multiTasks" | "currentMultiTask" | "multiRunning" | "multiError" | "multiStreamAgentId" | "multiStreamText" |
  "messages" | "streaming" | "roomSending" | "chatError" | "tasks" | "activeTaskId" | "failedTurn" | "usageSummaries" |
  "draftAttachments" | "draftWorkspaceRefs" | "workspacePathResults" | "lastStoppedRunId" | "activeRoomCommandId" | "adaptiveCommandId" | "adaptiveStatus" | "commandExecutionKind">;
const emptyRoomProjection = (): RoomProjection => ({
  multiLiveStreams: {},
  historyGeneration: 0, historyRequestVersion: 0, historyRevision: 0, taskRequestVersion: 0, attachmentError: null, attachmentImports: 0,
  activeRoomCommandId:null, adaptiveCommandId:null, adaptiveStatus:null, commandExecutionKind:null, lastStoppedRunId: null, sessionMessages: [], agentEvents: [], agentStreamText: "", pendingApprovals: [], agentRunning: false, agentError: null, activeAgentRunId: null,
  multiTasks: [], currentMultiTask: null, multiRunning: false, multiError: null, multiStreamAgentId: null, multiStreamText: "",
  messages: [], streaming: null, roomSending: false, chatError: null, tasks: [], activeTaskId: null, failedTurn: null, usageSummaries: [],
  draftAttachments: [], draftWorkspaceRefs: [], workspacePathResults: [],
});
const projectionOf = (state: Store): RoomProjection => Object.fromEntries(Object.keys(emptyRoomProjection()).map(key => [key, state[key as keyof RoomProjection]])) as RoomProjection;

export type Store = {
  multiLiveStreams: Record<string, { agentId: string; text: string }>;
  historyGeneration: number;
  historyRequestVersion: number;
  historyRevision: number;
  taskRequestVersion: number;
  attachmentError: string | null;
  attachmentImports: number;
  activeRoomCommandId:string | null;
  adaptiveCommandId:string | null;
  adaptiveStatus:string|null;
  commandExecutionKind:"direct"|"discussion"|"team"|null;
  lastStoppedRunId: string | null;
  roomNavigation: RoomNavigation;
  roomProjections: Record<string, RoomProjection>;
  pendingRoomRequests:Record<string,{fingerprint:string;clientRequestId:string;costOptions?:CostOptions}>;
  approvalDecisionKeys:Record<string,{decision:ApprovalDecision;key:string}>;
  composerDrafts: Record<string, string>;
  composerMentions: Record<string, SelectedMention[]>;
  setComposerMentions: (roomId:string,mentions:SelectedMention[]) => void;
  clearSubmittedRoomFiles: (roomId:string,attachmentIds:string[],workspaceRefIds:string[]) => void;
  setComposerDraft: (roomId: string, text: string) => void;
  setAppMode: (mode: "chat" | "cowork") => Promise<void>;
  sendRoomCommand: (content: string, mentions: RoomMention[], intent: RoomCommandIntent, clientRequestId?: string, roomId?: string, costOptions?: CostOptions, verificationPlanId?:string, routingCandidateId?:string) => Promise<boolean>;
  continueAgentRun: () => Promise<void>;
  applyMemberTemplate: (sessionId: string, agentId: string) => Promise<void>;
  retryWorkPackage: (taskId: string, packageId: string, confirmOutcomeUnknown?:boolean) => Promise<void>;
  assignWorkPackage: (taskId: string, packageId: string, executorAgentId: string) => Promise<void>;
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
  registerWorkspacePath: (path: string) => Promise<WorkspaceRecord>;
  selectWorkspacePath: (path: string) => Promise<WorkspaceRecord>;
  setActiveWorkspace: (workspaceId: string | null) => Promise<void>;
  renameWorkspace: (id: string, label: string) => Promise<void>;
  archiveWorkspace: (id: string, archived: boolean) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;

  sessions: ConversationSession[];
  currentSessionId: string | null;
  sessionMessages: SessionMessage[];
  agentEvents: RuntimeEvent[];
  /** 累积的流式文本；text_delta 经 rAF 批处理写入，UI 直接读取，不再每帧 filter/join */
  agentStreamText: string;
  pendingApprovals: PendingApproval[];
  agentCapabilities: {
    approvalPolicy: ToolApprovalCapabilities;
    collaboration: CollaborationRuntimeCapabilities;
  } | null;
  agentRunning: boolean;
  agentError: string | null;
  activeAgentRunId: string | null;
  loadSessions: () => Promise<void>;
  selectAgentSession: (id: string) => Promise<void>;
  renameSession: (id: string, title: string) => Promise<void>;
  updateCollaboration: (
    id: string,
    collaboration: RoomCollaborationSettings,
    primaryAgentId?: string,
  ) => Promise<void>;
  restoreCollaborationDefaults: (id: string) => Promise<void>;
  updatePrimaryAgent: (id: string, primaryAgentId: string) => Promise<void>;
  updateApprovalPolicy: (id: string, mode: ToolApprovalMode) => Promise<void>;
  archiveSession: (id: string, archived: boolean) => Promise<void>;
  removeSession: (id: string, workspaceFiles?: "keep" | "delete") => Promise<void>;
  rewindSessionTo: (messageId: string) => Promise<void>;
  sendAgentPrompt: (prompt: string) => Promise<boolean>;
  resumeAgentRun: (sessionId: string, runId: string, afterSeq?: number) => Promise<boolean>;
  decideAgentApproval: (requestId: string, decision: ApprovalDecision) => Promise<void>;
  cancelAgentRun: () => Promise<void>;
  usageSummaries: UsageSummaryView[];
  loadCurrentUsage: (roomId?: string) => Promise<void>;
  multiTasks: MultiTaskView[];
  currentMultiTask: MultiTaskView | null;
  multiRunning: boolean;
  multiError: string | null;
  /** 当前正在发言的 turn 的实时文本（SSE delta，rAF 批处理）；turn 完成后清空并重载 */
  multiStreamAgentId: string | null;
  multiStreamText: string;
  loadMultiTasks: (sessionId?: string) => Promise<void>;
  loadMultiTask: (id: string, sessionId?: string) => Promise<void>;
  sendMultiTask: (prompt: string) => Promise<void>;
  decideMultiPlan: (input: { decision: "approve_exact_plan" | "request_replan" | "reject" | "edit_and_approve"; reason?: string; content?: MultiPlan["content"] }) => Promise<void>;
  decideMultiApproval: (requestId: string, decision: ApprovalDecision) => Promise<void>;
  cancelMultiTask: () => Promise<void>;
  pauseMultiTask: () => Promise<void>;
  resumeMultiTask: () => Promise<void>;
  retryMultiTask: () => Promise<void>;
  draftAttachments: AttachmentRecord[];
  workspacePathResults: WorkspacePathResult[];
  captureRoomTarget: () => RoomOperationTarget;
  importWorkspaceAttachment: (absolutePath: string, target?: RoomOperationTarget) => Promise<void>;
  importClipboardAttachment: (file: File, target?: RoomOperationTarget) => Promise<void>;
  removeDraftAttachment: (id: string) => void;
  searchWorkspacePaths: (query: string) => Promise<void>;
  draftWorkspaceRefs: WorkspaceRef[];
  addWorkspaceRef: (relativePath: string, target?: RoomOperationTarget) => Promise<WorkspaceRef>;
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
  modelLoading:Record<string,boolean>;
  modelListErrors:Record<string,string|null>;
  loadModels: (providerId: string, force?: boolean) => Promise<void>;
  modelContextWindows: Record<string, import("@socrates/core").ContextWindowResolution>;
  loadModelContextWindow: (providerId: string, modelId: string) => Promise<void>;

  agents: Agent[];
  loadAgents: () => Promise<void>;
  saveAgent: (form: AgentForm, editingId: string | null) => Promise<Agent>;
  removeAgent: (id: string) => Promise<void>;

  rooms: Room[];
  currentRoomId: string | null;
  messages: StoredMessage[];
  streaming: StreamingTurn | null;
  /** Request has left the composer but the first SSE event has not arrived yet. */
  roomSending: boolean;
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
  /** 建房唯一入口（C4）：kind 决定走 rooms 还是 sessions，工作区只来自草稿 */
  createRoomFromDraft: (draft: RoomDraft) => Promise<void>;
  renameRoom: (id: string, name: string) => Promise<void>;
  addRoomAgent: (roomId: string, agentId: string) => Promise<void>;
  addSessionAgent: (sessionId: string, agentId: string) => Promise<void>;
  removeSessionAgent: (sessionId: string, agentId: string) => Promise<void>;
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
const ACTIVE_WORKSPACE_STORAGE_KEY = "socrates.active-workspace-id";
const ROOM_NAVIGATION_STORAGE_KEY = "socrates.room-navigation.v1";
let connectStarted = false; // React StrictMode 下 effect 会跑两次

export function storedRoomNavigation(): RoomNavigation {
  try {
    const value=JSON.parse(window.localStorage.getItem(ROOM_NAVIGATION_STORAGE_KEY) ?? "null") as RoomNavigation | null;
    if(value && ["chat","cowork"].includes(value.mode)) return {mode:value.mode,selected:{chat:typeof value.selected?.chat === "string" ? value.selected.chat : null,cowork:typeof value.selected?.cowork === "string" ? value.selected.cowork : null}};
  } catch { /* Storage is optional. */ }
  return initialRoomNavigation();
}
function persistRoomNavigation(value: RoomNavigation) {
  try { window.localStorage.setItem(ROOM_NAVIGATION_STORAGE_KEY,JSON.stringify(value)); } catch { /* Storage is optional. */ }
}

function storedActiveWorkspaceId(): string | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage.getItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function persistActiveWorkspaceId(workspaceId: string | null): void {
  try {
    if (typeof window === "undefined") return;
    if (workspaceId) window.localStorage.setItem(ACTIVE_WORKSPACE_STORAGE_KEY, workspaceId);
    else window.localStorage.removeItem(ACTIVE_WORKSPACE_STORAGE_KEY);
  } catch {
    // Private browsing or a locked WebView must not make project selection fail.
  }
}


export const useStore = create<Store>((set, get) => {
  const roomView = (roomId: string): RoomProjection => {
    const state = get();
    return (state.currentSessionId ?? state.currentRoomId) === roomId ? projectionOf(state) : state.roomProjections[roomId] ?? emptyRoomProjection();
  };
  const updateRoom = (roomId: string, patch: Partial<RoomProjection> | ((view: RoomProjection) => Partial<RoomProjection>)) => {
    set(state => {
      const visible = (state.currentSessionId ?? state.currentRoomId) === roomId;
      const view = visible ? projectionOf(state) : state.roomProjections[roomId] ?? emptyRoomProjection();
      const next = { ...view, ...(typeof patch === "function" ? patch(view) : patch) };
      return { roomProjections: { ...state.roomProjections, [roomId]: next }, ...(visible ? next : {}) };
    });
  };
  const currentRun = (roomId: string) => (get().currentSessionId === roomId ? get().activeAgentRunId : get().roomProjections[roomId]?.activeAgentRunId);
  const taskRoom = (taskId: string) => {
    const state=get();
    const task=[state.currentMultiTask,...state.multiTasks,...Object.values(state.roomProjections).flatMap(view=>[view.currentMultiTask,...view.multiTasks])].find(item=>item?.id === taskId);
    return task?.sessionId ?? state.currentSessionId ?? undefined;
  };
  const selectProjection = (id: string, source: "session" | "room", mode: "chat" | "cowork") => {
    set(state => {
      const oldId = state.currentSessionId ?? state.currentRoomId;
      const roomProjections = oldId ? {...state.roomProjections, [oldId]:projectionOf(state)} : state.roomProjections;
      return {...(roomProjections[id] ?? emptyRoomProjection()), roomProjections,
        currentSessionId: source === "session" ? id : null, currentRoomId: source === "room" ? id : null,
        roomNavigation: navigateRoom(state.roomNavigation, mode, id)};
    });
    persistRoomNavigation(get().roomNavigation);
  };
  const activeAgentObservers = new Map<string, ActiveAgentRunObserver>();
  const hs = () => {
    const h = get().handshake;
    if (!h) throw new Error("sidecar 未连接");
    return h;
  };
  // A history response may replace only the generation/revision it actually read.
  // Live events invalidate in-flight reads; rewind establishes a new generation.
  const refreshMessages = async (roomId: string, generation = roomView(roomId).historyGeneration) => {
    if (roomView(roomId).historyGeneration !== generation) return;
    const version = roomView(roomId).historyRequestVersion + 1;
    const revision = roomView(roomId).historyRevision;
    updateRoom(roomId, { historyRequestVersion: version });
    const sessionMessages = await requireOk<SessionMessage[]>(await sidecarFetch(hs(), `/sessions/${roomId}/messages`));
    updateRoom(roomId, view => view.historyGeneration === generation && view.historyRequestVersion === version && view.historyRevision === revision
      ? { sessionMessages, historyRevision: revision + 1 } : {});
  };
  const commitMessage = (roomId: string, message: SessionMessage) => updateRoom(roomId, view => ({
    sessionMessages: mergeSessionMessages(view.sessionMessages, [message]), historyRevision: view.historyRevision + 1,
  }));
  const cursorStorage = () => {
    try {
      return typeof window === "undefined" ? null : window.localStorage;
    } catch {
      return null;
    }
  };
  const submitApprovalDecision = async (scope:"agent"|"multi",requestId:string,decision:ApprovalDecision) => {
    const prior=get().approvalDecisionKeys[requestId];
    const key=prior?.decision === decision ? prior.key : crypto.randomUUID();
    set(state=>({approvalDecisionKeys:{...state.approvalDecisionKeys,[requestId]:{decision,key}}}));
    await requireOk(await sidecarFetch(hs(),`/${scope}/approvals/${requestId}/decision`,{method:"POST",body:JSON.stringify({decision,clientDecisionKey:key})}));
    set(state=>{const approvalDecisionKeys={...state.approvalDecisionKeys};if(approvalDecisionKeys[requestId]?.key === key) delete approvalDecisionKeys[requestId];return {approvalDecisionKeys};});
  };

  const commandObservers = new Map<string, { roomId: string; generation: number; controller: AbortController; promise: Promise<void> }>();
  const adaptiveObservers = new Map<string,{roomId:string;generation:number;controller:AbortController;promise:Promise<void>}>();
  type CommandView={commandId:string;kind:"direct"|"discussion"|"team";status:string;adaptive?:boolean;routeStatus?:string;runId?:string;taskId?:string;error?:string};
  const observeAdaptiveCommand=(roomId:string,commandId:string)=>{
    const generation=roomView(roomId).historyGeneration;
    const existing=adaptiveObservers.get(commandId);if(existing?.generation===generation)return existing.promise;
    existing?.controller.abort();const controller=new AbortController();
    updateRoom(roomId,{activeRoomCommandId:commandId,adaptiveCommandId:commandId});
    const valid=()=>!controller.signal.aborted&&roomView(roomId).historyGeneration===generation&&roomView(roomId).adaptiveCommandId===commandId;
    let childController:AbortController|undefined,childId:string|undefined;
    const seenRuns=new Set<string>();
    const followTeam=(taskId:string,signal:AbortSignal)=>{void(async()=>{
      let cursor=0;
      while(valid()&&!signal.aborted&&childId===taskId){
        const response=await sidecarFetch(hs(),`/room-commands/${commandId}/events?afterSeq=${cursor}`,{signal});
        if(!response.ok)await requireOk(response);
        for await(const raw of streamSseEvents(response)){
          if(!valid()||signal.aborted||childId!==taskId)break;
          const event=raw as {seq?:number;taskId?:string;type?:string;turnId?:string;agentId?:string;text?:string;payload?:{runId?:string;packageId?:string;agentId?:string;event?:RuntimeEvent}};
          if(event.taskId!==taskId||typeof event.seq!=="number"||event.seq<=cursor)continue;cursor=event.seq;
          const runtime=event.payload?.event;
          const key=event.payload?.runId??event.payload?.packageId??event.turnId??event.agentId??taskId;
          const text=runtime?.type==="text_delta"?runtime.text:event.type==="delta"?event.text:undefined;
          if(text)updateRoom(roomId,v=>({multiLiveStreams:{...v.multiLiveStreams,[key]:{agentId:event.payload?.agentId??event.agentId??"",text:(v.multiLiveStreams[key]?.text??"")+text}}}));
          if(["turn_completed","multi.package_finished"].includes(event.type??""))updateRoom(roomId,v=>{const streams={...v.multiLiveStreams};delete streams[key];return {multiLiveStreams:streams};});
        }
        if(!signal.aborted)await new Promise(resolve=>setTimeout(resolve,500));
      }
    })().catch(error=>{if(valid()&&!signal.aborted)updateRoom(roomId,{multiError:String(error)});});};
    const promise=(async()=>{
      try{
        while(valid()){
          try {
          const response=await sidecarFetch(hs(),`/room-commands/${commandId}`,{signal:controller.signal});
          if(response.status===404||response.status===410){updateRoom(roomId,{activeRoomCommandId:null,adaptiveCommandId:null,agentRunning:false,multiRunning:false});return;}
          const command=await requireOk<CommandView>(response);
          if(!valid())return;
          const terminal=["completed","failed","cancelled","revoked"].includes(command.status);
          updateRoom(roomId,{commandExecutionKind:command.kind,adaptiveStatus:command.routeStatus??command.status,agentError:terminal&&command.status==="failed"&&command.kind==="direct"?command.error??null:null,multiError:terminal&&command.status==="failed"&&command.kind==="team"?command.error??null:null});
          const nextChild=command.taskId??command.runId;
          if(nextChild!==childId){childController?.abort();childController=undefined;childId=nextChild;updateRoom(roomId,{multiLiveStreams:{},agentStreamText:"",agentEvents:[],activeAgentRunId:null,pendingApprovals:[],...(command.kind!=="team"?{currentMultiTask:null,multiRunning:false}:{})});}
          if(command.kind==="team"&&command.taskId){
            await get().loadMultiTask(command.taskId,roomId);
            if(!childController&&!terminal){childController=new AbortController();followTeam(command.taskId,childController.signal);}
          }else if(command.runId&&!seenRuns.has(command.runId)){
            seenRuns.add(command.runId);
            updateRoom(roomId,{activeAgentRunId:command.runId});
            void get().resumeAgentRun(roomId,command.runId,0);
          }
          if(!valid())return;
          const executing=["pending","running","assessing"].includes(command.routeStatus??command.status);
          updateRoom(roomId,{agentRunning:executing&&command.kind!=="team",multiRunning:executing&&command.kind==="team"});
          if(terminal){await refreshMessages(roomId,generation);updateRoom(roomId,{activeRoomCommandId:null,adaptiveCommandId:null,agentRunning:false,multiRunning:false,multiLiveStreams:{}});await get().loadSessions();return;}
          } catch(error) {if(valid())updateRoom(roomId,{agentError:error instanceof Error?error.message:String(error)});}
          if(valid())await new Promise(resolve=>setTimeout(resolve,500));
        }
      }
      finally{childController?.abort();}
    })();
    const observer={roomId,generation,controller,promise};adaptiveObservers.set(commandId,observer);
    void promise.finally(()=>{if(adaptiveObservers.get(commandId)===observer)adaptiveObservers.delete(commandId);});return promise;
  };
  const observeCommand = (roomId: string, commandId: string, taskId?: string) => {
    const generation = roomView(roomId).historyGeneration;
    const existing = commandObservers.get(commandId);
    if (existing?.generation === generation) return existing.promise;
    existing?.controller.abort();
    const controller = new AbortController();
    updateRoom(roomId, { activeRoomCommandId: commandId });
    const valid = () => !controller.signal.aborted && roomView(roomId).historyGeneration === generation && roomView(roomId).activeRoomCommandId === commandId;
    const patch = (value: Partial<RoomProjection> | ((view: RoomProjection) => Partial<RoomProjection>)) => { if (valid()) updateRoom(roomId, value); };
    const refreshTask = () => taskId ? get().loadMultiTask(taskId, roomId) : refreshMessages(roomId, generation);
    const observation = (async () => {
      let cursor = 0, terminal = false, unavailable = false;
      patch({ activeRoomCommandId: commandId, ...(taskId ? { multiRunning: true } : { agentRunning: true }) });
      if(taskId) await refreshTask().catch(error=>patch({multiError:String(error)}));
      while (!terminal && valid()) {
        try {
          const response = await sidecarFetch(hs(), `/room-commands/${commandId}/events?afterSeq=${cursor}`, { signal: controller.signal });
          if (response.status === 404 || response.status === 410) { terminal=true; unavailable=true; break; }
          if (!response.ok || !response.body) await requireOk(response);
          if(taskId) patch({multiError:null});
          for await (const raw of streamSseEvents(response)) {
            if (!valid()) break;
            const event = raw as {type?:string; seq?:number; roomId?:string; taskId?:string; turnId?:string; agentId?:string; text?:string; error?:string; message?:SessionMessage; payload?:{runId?:string; agentId?:string; packageId?:string; event?:RuntimeEvent}; state?:string};
            if (event.roomId && event.roomId !== roomId || taskId && event.taskId && event.taskId !== taskId) continue;
            if (typeof event.seq !== "number" || event.seq <= cursor) continue;
            if (taskId) {
              const key = event.turnId ?? event.agentId ?? taskId;
              if (event.type === "turn_started") patch(view => ({ multiStreamAgentId: event.agentId ?? null, multiStreamText: "", multiLiveStreams: {...view.multiLiveStreams, [key]: {agentId: event.agentId ?? "", text:""}} }));
              if (event.type === "delta" && event.text) patch(view => ({multiStreamAgentId:event.agentId ?? view.multiStreamAgentId, multiStreamText: view.multiStreamText + event.text, multiLiveStreams:{...view.multiLiveStreams,[key]:{agentId:event.agentId ?? view.multiLiveStreams[key]?.agentId ?? "",text:(view.multiLiveStreams[key]?.text ?? "") + event.text}}}));
              if (event.type === "multi.package_runtime" && event.payload?.event?.type === "text_delta") {
                const payload=event.payload, runtime=payload.event;
                const streamId=payload.runId ?? payload.packageId ?? key;
                if (runtime?.type === "text_delta") patch(view => ({multiLiveStreams:{...view.multiLiveStreams,[streamId]:{agentId:payload.agentId ?? "",text:(view.multiLiveStreams[streamId]?.text ?? "")+runtime.text}}}));
              } else if (event.type === "multi.package_runtime" && event.payload?.event) {
                await refreshTask();
              }
              if (event.type === "turn_completed") {
                await refreshTask();
                patch(view => {const streams={...view.multiLiveStreams};delete streams[key];return {multiLiveStreams:streams,multiStreamText:"",multiStreamAgentId:null};});
              } else if (["task_state", "plan_ready", "reviewer_verdict", "task_failed", "task_cancelled", "multi.package_started", "multi.package_reviewed", "multi.package_finished", "multi.team_completed", "multi.team_paused", "multi.team_cancelled"].includes(event.type ?? "")) {
                await refreshTask();
                if(event.type === "multi.package_finished") patch(view=>{const streams={...view.multiLiveStreams};for(const id of [event.payload?.runId,event.payload?.packageId]) if(id) delete streams[id];return {multiLiveStreams:streams};});
                if(["multi.team_completed","multi.team_paused","multi.team_cancelled"].includes(event.type ?? "")) patch({multiLiveStreams:{},multiStreamText:"",multiStreamAgentId:null});
              }
              // A replayed failure can belong to an earlier attempt, or be a
              // recoverable reviewer error. Reconcile status when SSE closes.
            } else {
              if (event.type === "delta" && event.text) patch(view => ({agentStreamText:view.agentStreamText + event.text}));
              if (event.type === "turn_started") patch({agentStreamText:"",multiStreamAgentId:event.agentId ?? null});
              if (event.type === "message" && event.message) {commitMessage(roomId,event.message);patch({agentStreamText:""});}
              if (["completed","failed","cancelled","revoked"].includes(event.type ?? "")) {
                terminal=true;
                patch({agentRunning:false,multiStreamAgentId:null,agentStreamText:"",agentError:event.type === "completed" ? null : event.error ?? event.type!});
              }
            }
            cursor=event.seq;
          }
          if (!terminal && valid()) {
            const command=await requireOk<{status:string;error?:string}>(await sidecarFetch(hs(),`/room-commands/${commandId}`,{signal:controller.signal}));
            terminal=["completed","failed","cancelled","revoked"].includes(command.status);
            if (taskId) await refreshTask();
          }
        } catch (error) {
          patch(taskId ? {multiError:error instanceof Error ? error.message : String(error)} : {agentError:error instanceof Error ? error.message : String(error)});
        }
        if (!terminal && valid()) await new Promise(resolve=>setTimeout(resolve,500));
      }
      if (!valid()) return;
      if(unavailable) await Promise.all([refreshMessages(roomId,generation),get().loadMultiTasks(roomId)]);
      else await refreshTask();
      patch({activeRoomCommandId:null,agentRunning:false,...(taskId ? {multiRunning:false,multiStreamAgentId:null,multiStreamText:"",multiLiveStreams:{}} : {})});
      await get().loadSessions();
    })().catch(error => patch(taskId ? {multiError:String(error)} : {agentError:String(error)}));
    const observer={roomId,generation,controller,promise:observation};
    commandObservers.set(commandId,observer);
    void observation.then(()=>{if(commandObservers.get(commandId) === observer) commandObservers.delete(commandId);});
    return observation;
  };
  const restoreTeamObserver = async (roomId: string, taskId: string, generation: number) => {
    const commands=await requireOk<Array<{commandId:string;kind:string;taskId?:string;adaptive?:boolean}>>(await sidecarFetch(hs(),`/room-commands/rooms/${roomId}`));
    const command=commands.find(item=>item.kind === "team" && item.taskId === taskId);
    if(command && roomView(roomId).historyGeneration === generation) void (command.adaptive?observeAdaptiveCommand(roomId,command.commandId):observeCommand(roomId,command.commandId,taskId));
  };

  /** POST 到当前房间的流式端点并消费 SSE，把事件映射进 store。
   *
   * The composer writes its user turn optimistically before this starts.  Stream
   * deltas are committed at most once per animation frame so an active model
   * cannot starve typing, pointer, or modal-close work in the WebView.
   */
  const streamPost = async (suffix: string, body: unknown, optimisticMessage?: StoredMessage) => {
    const roomId = get().currentRoomId;
    if (!roomId || get().streaming || get().activeTaskId || get().roomSending) return;
    const set: (patch: Partial<RoomProjection> | ((view: RoomProjection) => Partial<RoomProjection>)) => void = patch => updateRoom(roomId, patch);
    set({ chatError: null, roomSending: true });
    let pendingDelta = "";
    let deltaFrame: number | null = null;
    const flushDelta = () => {
      if (!pendingDelta) return;
      const text = pendingDelta;
      pendingDelta = "";
      set((state) =>
        state.streaming ? { streaming: { ...state.streaming, text: state.streaming.text + text } } : {},
      );
    };
    const scheduleDelta = () => {
      if (deltaFrame !== null) return;
      deltaFrame = window.requestAnimationFrame(() => {
        deltaFrame = null;
        flushDelta();
      });
    };
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
            set((state) => ({
              messages: optimisticMessage
                ? state.messages.map((message) => (message.id === optimisticMessage.id ? e.message : message))
                : [...state.messages, e.message],
              activeTaskId: e.message.taskId ?? null,
            }));
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
            pendingDelta += e.text;
            scheduleDelta();
          } else if (e.type === "message_completed") {
            flushDelta();
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
      if (deltaFrame !== null) window.cancelAnimationFrame(deltaFrame);
      flushDelta();
      set({ streaming: null, roomSending: false, activeTaskId: null, failedTurn: null });
      void get().loadTasks();
      void get().loadCurrentUsage();
    }
  };

  return {
    multiLiveStreams: {},
    historyGeneration: 0, historyRequestVersion: 0, historyRevision: 0, taskRequestVersion: 0, attachmentError: null, attachmentImports: 0,
    activeRoomCommandId:null, adaptiveCommandId:null, adaptiveStatus:null, commandExecutionKind:null, lastStoppedRunId:null, roomNavigation: storedRoomNavigation(), pendingRoomRequests:{}, approvalDecisionKeys:{}, roomProjections: {}, composerDrafts: {}, composerMentions: {},
    setComposerMentions: (roomId, mentions) => set(state => ({composerMentions:{...state.composerMentions,[roomId]:mentions}})),
    clearSubmittedRoomFiles: (roomId,attachmentIds,workspaceRefIds) => updateRoom(roomId,current=>({draftAttachments:current.draftAttachments.filter(item=>!attachmentIds.includes(item.id)),draftWorkspaceRefs:current.draftWorkspaceRefs.filter(item=>!workspaceRefIds.includes(item.id))})),
    setComposerDraft: (roomId, text) => set(state => ({composerDrafts: {...state.composerDrafts, [roomId]: text}})),
    setAppMode: async mode => {
      const nav = switchRoomMode(get().roomNavigation, mode);
      set({roomNavigation:nav});
      const sessions=get().sessions.filter(session=>session.kind === mode && !session.archived);
      const rooms=mode === "chat" ? get().rooms.filter(room=>!room.archived && !get().sessions.some(session=>session.id === room.id || session.legacyRoomId === room.id)) : [];
      const previous=nav.selected[mode];
      const selectedSession=sessions.find(session=>session.id === previous || session.legacyRoomId === previous);
      const id=selectedSession?.id ?? rooms.find(room=>room.id === previous)?.id ?? sessions[0]?.id ?? rooms[0]?.id;
      if (id && sessions.some(session => session.id === id)) await get().selectAgentSession(id);
      else if (id) await get().selectRoom(id);
      else set(state => {
        const oldId = state.currentSessionId ?? state.currentRoomId;
        return {...emptyRoomProjection(), currentSessionId:null, currentRoomId:null, roomProjections:oldId ? {...state.roomProjections,[oldId]:projectionOf(state)} : state.roomProjections};
      });
      persistRoomNavigation(get().roomNavigation);
    },
    applyMemberTemplate: async (sessionId, agentId) => {
      await requireOk(await sidecarFetch(hs(), `/sessions/${sessionId}/agents/${agentId}/template`, {method:"PUT"}));
      await get().loadSessions();
    },
    assignWorkPackage: async (taskId, packageId, executorAgentId) => {
      const roomId=taskRoom(taskId);
      await requireOk(await sidecarFetch(hs(), `/multi/tasks/${taskId}/packages/${encodeURIComponent(packageId)}`, {method:"PATCH",body:JSON.stringify({executorAgentId})}));
      await get().loadMultiTask(taskId,roomId);
    },
    retryWorkPackage: async (taskId, packageId, confirmOutcomeUnknown) => {
      const roomId=taskRoom(taskId);
      const generation=roomId ? roomView(roomId).historyGeneration : 0;
      await requireOk(await sidecarFetch(hs(), `/multi/tasks/${taskId}/packages/${encodeURIComponent(packageId)}/retry`, {method:"POST",body:JSON.stringify(confirmOutcomeUnknown === true ? {confirmOutcomeUnknown:true} : {})}));
      if(roomId && roomView(roomId).historyGeneration === generation) {
        await get().loadMultiTask(taskId,roomId);
        await restoreTeamObserver(roomId,taskId,generation);
      }
    },
    continueAgentRun: async () => {
      const sessionId = get().currentSessionId;
      const lastRunId = get().lastStoppedRunId;
      if (!sessionId || !lastRunId || get().agentRunning) return;
      const generation=roomView(sessionId).historyGeneration;
      updateRoom(sessionId,{agentRunning:true,agentError:null});
      try {
        const started = await requireOk<{runId:string}>(await sidecarFetch(hs(), `/agent/runs/${lastRunId}/continue`, {method:"POST"}));
        if(roomView(sessionId).historyGeneration !== generation) return;
        updateRoom(sessionId,{agentRunning:true,activeAgentRunId:started.runId,lastStoppedRunId:null,agentError:null,agentStreamText:""});
        const storage=cursorStorage();if(storage) writeActiveAgentRunCursor(storage,{sessionId,runId:started.runId,afterSeq:0});
        void get().resumeAgentRun(sessionId,started.runId);
      } catch(error) {if(roomView(sessionId).historyGeneration === generation) updateRoom(sessionId,{agentRunning:false,agentError:error instanceof Error ? error.message : String(error)});}
    },
    sendRoomCommand: async (content, mentions, intent, clientRequestId, targetRoomId, costOptions, verificationPlanId, routingCandidateId) => {
      const roomId = targetRoomId ?? get().currentSessionId;
      if (!roomId) return false;
      const view = roomView(roomId);
      if (view.agentRunning || view.multiRunning || get().sessions.find(item => item.id === roomId)?.archived) return false;
      const generation = view.historyGeneration;
      const attachments = view.draftAttachments.map(item=>item.id);
      const workspaceRefs = view.draftWorkspaceRefs.map(item=>item.id);
      const requestedCostBody = commandCostBody(costOptions);
      const semanticCostBody = { ...requestedCostBody };
      delete semanticCostBody.quoteId;
      const fingerprint=JSON.stringify({content,mentions,intent,attachments,workspaceRefs,verificationPlanId,routingCandidateId,...semanticCostBody});
      const pending=get().pendingRoomRequests[roomId];
      const retryingPending = pending?.fingerprint === fingerprint && (clientRequestId === undefined || clientRequestId === pending.clientRequestId);
      const costBody = retryingPending && pending.costOptions ? commandCostBody(pending.costOptions) : requestedCostBody;
      clientRequestId ??= retryingPending ? pending.clientRequestId : crypto.randomUUID();
      set(state=>({pendingRoomRequests:{...state.pendingRoomRequests,[roomId]:{fingerprint,clientRequestId:clientRequestId!,costOptions:costBody}}}));
      updateRoom(roomId,{adaptiveCommandId:null,adaptiveStatus:null,commandExecutionKind:null,activeRoomCommandId:`pending:${clientRequestId}`,agentRunning:true,lastStoppedRunId:null,agentError:null,agentEvents:[],agentStreamText:"",historyRevision:view.historyRevision+1,taskRequestVersion:view.taskRequestVersion+1,multiStreamAgentId:mentions.find(mention=>mention.type==="agent")?.type === "agent" ? (mentions.find(mention=>mention.type==="agent") as {agentId:string}).agentId : get().sessions.find(session=>session.id===roomId)?.primaryAgentId ?? null});
      try {
        const response = await sidecarFetch(hs(),"/room-commands",{method:"POST",body:JSON.stringify({roomId,clientRequestId,content,mentions,intent,attachmentIds:attachments,workspaceRefIds:workspaceRefs,verificationPlanId,routingCandidateId,...costBody})});
        if (!response.ok) {
          const rejected = await response.json() as { error?: string };
          // These errors prove that this quote was rejected before dispatch.
          // A dropped response retains the original quote and request identity.
          if (["quote_stale", "quote_expired", "quote_required_for_budget"].includes(rejected.error ?? "")) {
            set(state=>{const pendingRoomRequests={...state.pendingRoomRequests};if(pendingRoomRequests[roomId]?.clientRequestId === clientRequestId) delete pendingRoomRequests[roomId];return {pendingRoomRequests};});
          }
          throw new Error(rejected.error ?? `request failed (${response.status})`);
        }
        const started = await response.json() as CommandView;
        if (roomView(roomId).historyGeneration !== generation) return false;
        set(state=>{const pendingRoomRequests={...state.pendingRoomRequests};delete pendingRoomRequests[roomId];return {pendingRoomRequests};});
        updateRoom(roomId, current => ({activeRoomCommandId:started.commandId,commandExecutionKind:started.kind, draftAttachments: current.draftAttachments.filter(item => !attachments.includes(item.id)), draftWorkspaceRefs: current.draftWorkspaceRefs.filter(item => !workspaceRefs.includes(item.id))}));
        if(started.adaptive){void observeAdaptiveCommand(roomId,started.commandId);}
        else if (started.kind === "direct" && started.runId) {
          updateRoom(roomId,{activeAgentRunId:started.runId});
          const storage=cursorStorage(); if(storage) writeActiveAgentRunCursor(storage,{sessionId:roomId,runId:started.runId,afterSeq:0});
          void get().resumeAgentRun(roomId, started.runId, 0);
        } else if (started.kind === "team" && started.taskId) {
          updateRoom(roomId,{agentRunning:false,multiRunning:true});
          void observeCommand(roomId,started.commandId,started.taskId);
        } else {
          void observeCommand(roomId,started.commandId);
        }
        void refreshMessages(roomId, generation).catch(()=>{});
        return true;
      } catch(error) {
        if (roomView(roomId).historyGeneration === generation) updateRoom(roomId,{activeRoomCommandId:null,agentRunning:false,agentError:error instanceof Error ? error.message : String(error)});
        return false;
      }
    },
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
    agentEvents: [], agentStreamText: "",
    pendingApprovals: [],
    agentCapabilities: null,
    usageSummaries: [],
    agentRunning: false,
    agentError: null,
    activeAgentRunId: null,
    draftAttachments: [],
    workspacePathResults: [],
    draftWorkspaceRefs: [],
    multiTasks: [],
    currentMultiTask: null,
    multiRunning: false,
    multiError: null,
    multiStreamAgentId: null,
    multiStreamText: "",
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
    roomSending: false,
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
              const capabilities = await requireOk<{
                approvalPolicy: ToolApprovalCapabilities;
                collaboration: CollaborationRuntimeCapabilities;
              }>(
                await sidecarFetch(handshake, "/agent/capabilities"),
              );
              set({ agentCapabilities: capabilities });
              await Promise.all([get().loadProviders(), get().loadAgents(), get().loadRooms(), get().loadWorkspaces(), get().loadSessions(), get().loadMcpServers()]);
              await get().setAppMode(get().roomNavigation.mode);
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
      set((state) => ({
        workspaces,
        activeWorkspace: resolveActiveWorkspace(workspaces, state.activeWorkspace, storedActiveWorkspaceId()),
      }));
    },
    registerWorkspacePath: async (path) => {
      const workspace = await requireOk<WorkspaceRecord>(
        await sidecarFetch(hs(), "/workspaces", { method: "POST", body: JSON.stringify({ path }) }),
      );
      await get().loadWorkspaces();
      return workspace;
    },
    selectWorkspacePath: async (path) => {
      const activeWorkspace = await get().registerWorkspacePath(path);
      set({ activeWorkspace });
      persistActiveWorkspaceId(activeWorkspace.id);
      await get().loadMcpServers();
      return activeWorkspace;
    },
    setActiveWorkspace: async (workspaceId) => {
      if (get().activeTaskId || get().agentRunning) throw new Error("workspace_change_while_running");
      const workspace = workspaceId ? get().workspaces.find((item) => item.id === workspaceId) ?? null : null;
      if (workspaceId && !workspace) throw new Error("workspace_not_found");
      set({ activeWorkspace: workspace });
      persistActiveWorkspaceId(workspace?.id ?? null);
      await get().loadMcpServers();
    },
    renameWorkspace: async (id, label) => {
      await requireOk<WorkspaceRecord>(await sidecarFetch(hs(), `/workspaces/${id}`, {
        method: "PUT",
        body: JSON.stringify({ label }),
      }));
      await get().loadWorkspaces();
    },
    archiveWorkspace: async (id, archived) => {
      await requireOk<WorkspaceRecord>(await sidecarFetch(hs(), `/workspaces/${id}/archive`, {
        method: "PUT",
        body: JSON.stringify({ archived }),
      }));
      if (archived && get().activeWorkspace?.id === id) {
        set({ activeWorkspace: null });
        persistActiveWorkspaceId(null);
      }
      await Promise.all([get().loadWorkspaces(), get().loadMcpServers()]);
    },
    removeWorkspace: async (id) => {
      await requireOk(await sidecarFetch(hs(), `/workspaces/${id}`, { method: "DELETE" }));
      if (get().activeWorkspace?.id === id) {
        set({ activeWorkspace: null });
        persistActiveWorkspaceId(null);
      }
      await Promise.all([get().loadWorkspaces(), get().loadRooms(), get().loadSessions(), get().loadMcpServers()]);
    },
    loadSessions: async () => {
      set({ sessions: await requireOk<ConversationSession[]>(await sidecarFetch(hs(), "/sessions")) });
    },
    renameSession: async (id, title) => {
      await requireOk<ConversationSession>(await sidecarFetch(hs(), `/sessions/${id}`, {
        method: "PUT",
        body: JSON.stringify({ title }),
      }));
      await get().loadSessions();
    },
    updateCollaboration: async (id, collaboration, primaryAgentId) => {
      await requireOk<ConversationSession>(await sidecarFetch(hs(), `/sessions/${id}/collaboration`, {
        method: "PUT",
        body: JSON.stringify({ collaboration, primaryAgentId }),
      }));
      await get().loadSessions();
    },
    restoreCollaborationDefaults: async (id) => {
      await requireOk<ConversationSession>(
        await sidecarFetch(hs(), `/sessions/${id}/collaboration/restore-defaults`, {
          method: "POST",
        }),
      );
      await get().loadSessions();
    },
    updatePrimaryAgent: async (id, primaryAgentId) => {
      await requireOk<ConversationSession>(
        await sidecarFetch(hs(), `/sessions/${id}/primary-agent`, {
          method: "PUT",
          body: JSON.stringify({ primaryAgentId }),
        }),
      );
      await get().loadSessions();
    },
    updateApprovalPolicy: async (id, mode) => {
      const sessions = await commitApprovalPolicyUpdate(() => get().sessions, async () =>
        requireOk<ConversationSession>(await sidecarFetch(hs(), `/sessions/${id}/approval-policy`, {
          method: "PUT",
          body: JSON.stringify({ mode }),
        })),
      );
      set({ sessions });
    },
    archiveSession: async (id, archived) => {
      await requireOk<ConversationSession>(await sidecarFetch(hs(), `/sessions/${id}/archive`, {
        method: "PUT",
        body: JSON.stringify({ archived }),
      }));
      await get().loadSessions();
      if (archived && get().currentSessionId === id) {
        await get().setAppMode(get().roomNavigation.mode);
      }
    },
    removeSession: async (id, workspaceFiles) => {
      const query = workspaceFiles ? `?workspaceFiles=${workspaceFiles}` : "";
      await requireOk(await sidecarFetch(hs(), `/sessions/${id}${query}`, { method: "DELETE" }));
      await Promise.all([get().loadSessions(), get().loadWorkspaces()]);
      if (get().currentSessionId === id) {
        set({ currentSessionId: null, sessionMessages: [], agentEvents: [], agentStreamText: "", pendingApprovals: [], multiTasks: [], currentMultiTask: null });
      }
    },
    rewindSessionTo: async (messageId) => {
      const sessionId = get().currentSessionId;
      if (!sessionId || get().agentRunning || get().multiRunning) return;
      const generation=roomView(sessionId).historyGeneration + 1;
      updateRoom(sessionId,{historyGeneration:generation,activeAgentRunId:null,activeRoomCommandId:null,adaptiveCommandId:null,adaptiveStatus:null,commandExecutionKind:null,lastStoppedRunId:null,agentError:null,multiError:null,pendingApprovals:[],agentEvents:[],agentStreamText:"",multiStreamText:"",multiLiveStreams:{}});
      for (const observer of activeAgentObservers.values()) if(observer.sessionId === sessionId) observer.controller.abort();
      for (const observer of commandObservers.values()) if(observer.roomId === sessionId) observer.controller.abort();
      for (const observer of adaptiveObservers.values()) if(observer.roomId === sessionId) observer.controller.abort();
      const storage=cursorStorage();
      const saved=storage ? readActiveAgentRunCursor(storage) : null;
      if(storage && saved?.sessionId === sessionId) clearActiveAgentRunCursor(storage,saved.runId);
      set(state=>{const requests={...state.pendingRoomRequests};delete requests[sessionId];return {pendingRoomRequests:requests};});
      await requireOk(await sidecarFetch(hs(), `/sessions/${sessionId}/rewind`, {method:"POST",body:JSON.stringify({messageId})}));
      if(roomView(sessionId).historyGeneration !== generation) return;
      await refreshMessages(sessionId,generation);
      await get().loadMultiTasks(sessionId);
    },
    selectAgentSession: async (id) => {
      const session=get().sessions.find(item=>item.id === id);
      selectProjection(id,"session",session?.kind === "chat" ? "chat" : "cowork");
      const generation=roomView(id).historyGeneration;
      await refreshMessages(id,generation);
      if(roomView(id).historyGeneration !== generation) return;
      await Promise.all([get().loadCurrentUsage(id),get().loadMultiTasks(id)]);
      if(roomView(id).historyGeneration !== generation) return;
      const revision=roomView(id).historyRevision;
      const commands=await requireOk<CommandView[]>(await sidecarFetch(hs(),`/room-commands/rooms/${id}`));
      if(roomView(id).historyGeneration !== generation || roomView(id).historyRevision !== revision) return;
      const latest=commands[0];
      updateRoom(id,{commandExecutionKind:latest?.kind??null,adaptiveStatus:latest?.adaptive?latest.routeStatus??latest.status:null});
      if(latest?.adaptive){
        if(latest.taskId)await get().loadMultiTask(latest.taskId,id);else updateRoom(id,{currentMultiTask:null,multiRunning:false});
        if(!["completed","failed","cancelled","revoked"].includes(latest.status))void observeAdaptiveCommand(id,latest.commandId);
        else updateRoom(id,{adaptiveCommandId:null,activeRoomCommandId:null,agentRunning:false,multiRunning:false,agentError:latest.kind==="direct"?latest.error??null:null,multiError:latest.kind==="team"?latest.error??null:null});
        return;
      }
      if(latest?.kind === "direct" && latest.runId) {
        if(["running","dispatching","preparing","awaiting_approval"].includes(latest.status)) {
          if(!activeAgentObservers.has(latest.runId)) {
            updateRoom(id,{activeAgentRunId:latest.runId,activeRoomCommandId:latest.commandId,agentRunning:true,agentEvents:[],agentStreamText:""});
            void get().resumeAgentRun(id,latest.runId,0);
          }
          return;
        }
        updateRoom(id,{agentRunning:false,activeAgentRunId:null,activeRoomCommandId:null,agentStreamText:"",pendingApprovals:[],agentError:latest.error ?? null,lastStoppedRunId:latest.error === "budget_exhausted" ? latest.runId : null});
        activeAgentObservers.get(latest.runId)?.controller.abort();
        const storage=cursorStorage();if(storage) clearActiveAgentRunCursor(storage,latest.runId);
        return;
      }
      if(latest?.kind === "team" && latest.taskId && !["completed","failed","cancelled","revoked"].includes(latest.status)) {void observeCommand(id,latest.commandId,latest.taskId);return;}
      if(latest?.kind === "discussion" && ["running","dispatching"].includes(latest.status)) {void observeCommand(id,latest.commandId);return;}
      const storage=cursorStorage();
      const saved=storage ? readActiveAgentRunCursor(storage) : null;
      if(saved?.sessionId === id && !activeAgentObservers.has(saved.runId)) {
        try {
          const run=await requireOk<AgentRunStatusView>(await sidecarFetch(hs(),`/agent/runs/${saved.runId}`));
          if(roomView(id).historyGeneration !== generation) return;
          if(!["running","preparing","awaiting_approval"].includes(run.status)) {if(storage) clearActiveAgentRunCursor(storage,saved.runId);return;}
          updateRoom(id,{activeAgentRunId:saved.runId,agentRunning:true,agentEvents:[],agentStreamText:""});
          void get().resumeAgentRun(id,saved.runId,0);
        } catch {if(storage) clearActiveAgentRunCursor(storage,saved.runId);}
      }
    },
    sendAgentPrompt: async prompt => get().sendRoomCommand(prompt,[],"execute"),
    resumeAgentRun: async (sessionId, runId, afterSeq = 0) => {
      const generation = roomView(sessionId).historyGeneration;
      const valid = () => roomView(sessionId).historyGeneration === generation;
      const set: (patch: Partial<RoomProjection> | ((view: RoomProjection) => Partial<RoomProjection>)) => void = patch => { if (valid()) updateRoom(sessionId, patch); };
      const existing = activeAgentObservers.get(runId);
      if (existing) return existing.promise;
      const controller = new AbortController();
      const observation = (async () => {
        let runError: string | null = null;
        let pendingText = "";
        let rafHandle: number | null = null;
        const flushText = () => {
          rafHandle = null;
          if (!pendingText) return;
          const chunk = pendingText;
          pendingText = "";
          set((state) => ({ agentStreamText: state.agentStreamText + chunk }));
        };
        const flushNow = () => {
          if (rafHandle !== null) { cancelAnimationFrame(rafHandle); rafHandle = null; }
          flushText();
        };
        try {
          const result = await observeDurableRun({
            runId,
            afterSeq,
            open: (cursor) => (async function* () {
              const response = await sidecarFetch(
                hs(),
                `/agent/runs/${runId}/events?afterSeq=${cursor}`,
                { signal: controller.signal },
              );
              if (!response.ok || !response.body) await requireOk(response);
              for await (const raw of streamSseEvents(response)) {
                const event = decodeExecutionEvent(raw);
                if (!event) throw new Error("invalid_execution_event");
                yield event;
              }
            })(),
            shouldContinue: () => valid() && !controller.signal.aborted && currentRun(sessionId) === runId,
            onEvent: async (executionEvent) => {
              if (controller.signal.aborted || currentRun(sessionId) !== runId) return;
              const event = executionEventToRuntimeEvent(executionEvent);
              let pendingApprovals: PendingApproval[] | null = null;
              if (event) {
                if (event.type === "text_delta") {
                  pendingText += event.text;
                  if (rafHandle === null) rafHandle = requestAnimationFrame(flushText);
                } else {
                  if (event.type === "approval_required") {
                    try {
                      pendingApprovals = await requireOk<PendingApproval[]>(
                        await sidecarFetch(hs(), "/agent/approvals", { signal: controller.signal }),
                      );
                      pendingApprovals=pendingApprovals.filter(approval=>approval.taskId === runId);
                    } catch (error) {
                      if (controller.signal.aborted || currentRun(sessionId) !== runId) return;
                      throw new RetryableAgentRunProjectionError(error);
                    }
                  }
                  if (controller.signal.aborted || currentRun(sessionId) !== runId) return;
                  flushNow();
                  set((state) => ({
                    agentEvents: [...state.agentEvents, event],
                    ...(pendingApprovals ? { pendingApprovals } : {}),
                  }));
                  if (event.type === "status" && event.status === "failed") {
                    runError = event.message ?? "agent_run_failed";
                    if(!roomView(sessionId).adaptiveCommandId)set({ agentError: runError });
                  } else if (event.type === "status" && event.status === "interrupted") {
                    runError = event.message === "budget_exhausted" ? "budget_exhausted" : tr(get().lang, "task_cancelled_notice");
                    if(!roomView(sessionId).adaptiveCommandId)set({ agentError: runError, lastStoppedRunId:runId });
                  }
                }
              }
              const storage = cursorStorage();
              if (storage) {
                advanceActiveAgentRunCursor(storage, {
                  sessionId,
                  runId,
                  afterSeq: executionEvent.seq,
                });
              }
            },
            wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          });
          if (!result.terminal || currentRun(sessionId) !== runId) return false;
        } catch (error) {
          runError = error instanceof Error ? error.message : String(error);
          if (!valid() || controller.signal.aborted) return false;
          if (currentRun(sessionId) === runId && !roomView(sessionId).adaptiveCommandId) set({ agentError: runError });
          const run = await pollAgentRunUntilTerminal(
            async () => requireOk<AgentRunStatusView>(
              await sidecarFetch(hs(), `/agent/runs/${runId}`),
            ),
            () => currentRun(sessionId) === runId,
            (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
          );
          if (!run || currentRun(sessionId) !== runId) return false;
          if (run.status === "failed") runError = run.error ?? runError;
        } finally {
          flushNow();
        }

        const storage = cursorStorage();
        if (storage) clearActiveAgentRunCursor(storage, runId);
        if (currentRun(sessionId) === runId) {
          set({
            agentRunning: false,
            activeAgentRunId: null,
            ...(!roomView(sessionId).adaptiveCommandId?{activeRoomCommandId:null}:{}),
            pendingApprovals: [],
            ...(!roomView(sessionId).adaptiveCommandId?{agentError:runError}:{}),
            ...(!runError ? {lastStoppedRunId:null} : {}),
          });
        }
        if (!valid()) return false;
        await Promise.allSettled([
          refreshMessages(sessionId,generation),
          get().loadCurrentUsage(sessionId),
          get().loadSessions(),
        ]);
        return runError === null;
      })();
      const observer = { sessionId, controller, promise: observation };
      activeAgentObservers.set(runId, observer);
      void observation.finally(() => {
        if (activeAgentObservers.get(runId) === observer) activeAgentObservers.delete(runId);
      });
      return observation;
    },
    decideAgentApproval: async (requestId, decision) => {
      const roomId=get().currentSessionId;
      await submitApprovalDecision("agent",requestId,decision);
      if(roomId) updateRoom(roomId,state => ({ pendingApprovals: state.pendingApprovals.filter((approval) => approval.id !== requestId) }));
    },
    cancelAgentRun: async () => {
      const {activeAgentRunId:runId,activeRoomCommandId:commandId}=get();
      if(commandId && !commandId.startsWith("pending:")) await requireOk(await sidecarFetch(hs(),`/room-commands/${commandId}/cancel`,{method:"POST"}));
      else if(runId) await requireOk(await sidecarFetch(hs(),`/agent/runs/${runId}/cancel`,{method:"POST"}));
    },
    loadCurrentUsage: async (targetRoomId) => {
      const state = get();
      const roomId=targetRoomId ?? state.currentSessionId ?? state.currentRoomId;
      const isSession=targetRoomId ? state.sessions.some(item=>item.id === targetRoomId) : Boolean(state.currentSessionId);
      const path = isSession && roomId ? `/sessions/${roomId}/usage` : roomId ? `/rooms/${roomId}/usage` : null;
      if (!path) { set({ usageSummaries: [] }); return; }
      const usageSummaries=await requireOk<UsageSummaryView[]>(await sidecarFetch(hs(), path));
      if(roomId) updateRoom(roomId,{usageSummaries});
    },
    loadMultiTasks: async (targetSessionId) => {
      const sessionId=targetSessionId ?? get().currentSessionId;
      if(!sessionId) return;
      const generation=roomView(sessionId).historyGeneration;
      const version=roomView(sessionId).taskRequestVersion + 1;
      updateRoom(sessionId,{taskRequestVersion:version});
      const summaries=await requireOk<MultiTaskView[]>(await sidecarFetch(hs(),`/multi/sessions/${sessionId}/tasks`));
      if(roomView(sessionId).historyGeneration !== generation || roomView(sessionId).taskRequestVersion !== version) return;
      updateRoom(sessionId,{multiTasks:summaries,...(!summaries.length ? {currentMultiTask:null,multiRunning:false} : {})});
      if(summaries[0]) await get().loadMultiTask(summaries[0].id,sessionId);
    },
    loadMultiTask: async (id, targetSessionId) => {
      const state=get();
      const sessionId=targetSessionId ?? taskRoom(id) ?? state.currentSessionId;
      if(!sessionId) return;
      const generation=roomView(sessionId).historyGeneration;
      const version=roomView(sessionId).taskRequestVersion + 1;
      updateRoom(sessionId,{taskRequestVersion:version});
      const currentMultiTask=await requireOk<MultiTaskView>(await sidecarFetch(hs(),`/multi/tasks/${id}`));
      if(currentMultiTask.sessionId !== sessionId || roomView(sessionId).historyGeneration !== generation || roomView(sessionId).taskRequestVersion !== version) return;
      updateRoom(sessionId,{
        currentMultiTask, pendingApprovals:currentMultiTask.pendingApprovals ?? [], usageSummaries:currentMultiTask.usageSummaries ?? [],
        multiRunning:!["awaiting_plan_approval","failed","cancelled","completed","paused"].includes(currentMultiTask.state),
      });
      await refreshMessages(sessionId,generation);
    },
    sendMultiTask: async (prompt) => { await get().sendRoomCommand(prompt,[],"execute"); },
    decideMultiPlan: async (input) => {
      const task = get().currentMultiTask;
      if (!task?.plan) throw new Error("plan_not_ready");
      const generation=roomView(task.sessionId).historyGeneration;
      await requireOk(await sidecarFetch(hs(), `/multi/tasks/${task.id}/plan-decisions`, {
        method: "POST", body: JSON.stringify({ version: task.plan.version, hash: task.plan.contentHash, clientDecisionKey: crypto.randomUUID(), ...input }),
      }));
      if(roomView(task.sessionId).historyGeneration !== generation) return;
      await get().loadMultiTask(task.id,task.sessionId);
      await restoreTeamObserver(task.sessionId,task.id,generation);
    },
    decideMultiApproval: async (requestId, decision) => {
      const task = get().currentMultiTask;
      try {
        await submitApprovalDecision("multi",requestId,decision);
        if (task) await get().loadMultiTask(task.id,task.sessionId);
      } catch(error) { if(task) updateRoom(task.sessionId,{multiError:error instanceof Error ? error.message : String(error)}); }
    },
    cancelMultiTask: async () => {
      const task = get().currentMultiTask;
      if (!task) return;
      await requireOk(await sidecarFetch(hs(), task.config.costRootTaskId?`/room-commands/${task.config.costRootTaskId}/cancel`:`/multi/tasks/${task.id}/cancel`, { method: "POST" }));
      await get().loadMultiTask(task.id,task.sessionId);
    },
    pauseMultiTask: async () => {
      const task = get().currentMultiTask;
      if (!task) return;
      await requireOk(await sidecarFetch(hs(), `/multi/tasks/${task.id}/pause`, { method: "POST" }));
      await get().loadMultiTask(task.id,task.sessionId);
    },
    resumeMultiTask: async () => {
      const task=get().currentMultiTask;
      if(!task) return;
      const generation=roomView(task.sessionId).historyGeneration;
      updateRoom(task.sessionId,{multiRunning:true,multiError:null});
      try {await requireOk(await sidecarFetch(hs(),`/multi/tasks/${task.id}/resume`,{method:"POST"}));await restoreTeamObserver(task.sessionId,task.id,generation);}
      catch(error) {if(roomView(task.sessionId).historyGeneration === generation) updateRoom(task.sessionId,{multiRunning:false,multiError:error instanceof Error ? error.message : String(error)});}
      finally {if(roomView(task.sessionId).historyGeneration === generation) await get().loadMultiTask(task.id,task.sessionId).catch(error=>{if(roomView(task.sessionId).historyGeneration === generation) updateRoom(task.sessionId,{multiRunning:false,multiError:String(error)});});}
    },
    retryMultiTask: async () => {
      const task=get().currentMultiTask;
      if(!task) return;
      const generation=roomView(task.sessionId).historyGeneration;
      updateRoom(task.sessionId,{multiError:null});
      try {await requireOk(await sidecarFetch(hs(),`/multi/tasks/${task.id}/retry`,{method:"POST",body:JSON.stringify({confirmOutcomeUnknown:true})}));await restoreTeamObserver(task.sessionId,task.id,generation);}
      catch(error) {if(roomView(task.sessionId).historyGeneration === generation) updateRoom(task.sessionId,{multiError:error instanceof Error ? error.message : String(error)});}
      if(roomView(task.sessionId).historyGeneration === generation) await get().loadMultiTask(task.id,task.sessionId).catch(error=>{if(roomView(task.sessionId).historyGeneration === generation) updateRoom(task.sessionId,{multiError:String(error)});});
    },
    captureRoomTarget: () => {
      const state=get(), roomId=state.currentSessionId ?? state.currentRoomId;
      if(!roomId) throw new Error("room_required");
      const session=state.sessions.find(item=>item.id === roomId);
      if(session?.kind === "chat") throw new Error("workspace_required");
      const workspace=state.workspaces.find(item=>item.id === session?.workspaceId);
      if(!workspace) throw new Error("workspace_required");
      return {roomId,workspaceId:workspace.id,canonicalPath:workspace.canonicalPath};
    },
    importWorkspaceAttachment: async (absolutePath, target = get().captureRoomTarget()) => {
      updateRoom(target.roomId,view=>({attachmentError:null,attachmentImports:view.attachmentImports+1}));
      try {
        if(roomView(target.roomId).draftAttachments.length >= 10) throw new Error("attachment_count_exceeded");
        const relativePath=relativeWorkspacePath(target.canonicalPath,absolutePath);
        const attachment=await requireOk<AttachmentRecord>(await sidecarFetch(hs(),"/content/attachments/import",{method:"POST",body:JSON.stringify({workspaceId:target.workspaceId,relativePath})}));
        const view=roomView(target.roomId);
        if(view.draftAttachments.some(item=>item.id === attachment.id)) return;
        if(view.draftAttachments.length >= 10) throw new Error("attachment_count_exceeded");
        if(view.draftAttachments.reduce((sum,item)=>sum+item.byteSize,0)+attachment.byteSize > 50*1024*1024) throw new Error("attachment_batch_too_large");
        updateRoom(target.roomId,current=>({draftAttachments:[...current.draftAttachments,attachment]}));
      } catch(error) {updateRoom(target.roomId,{attachmentError:error instanceof Error ? error.message : String(error)});throw error;}
      finally {updateRoom(target.roomId,view=>({attachmentImports:Math.max(0,view.attachmentImports-1)}));}
    },
    importClipboardAttachment: async (file, target = get().captureRoomTarget()) => {
      updateRoom(target.roomId,view=>({attachmentError:null,attachmentImports:view.attachmentImports+1}));
      try {
        const view=roomView(target.roomId);
        if(view.draftAttachments.length >= 10) throw new Error("attachment_count_exceeded");
        if(view.draftAttachments.reduce((sum,item)=>sum+item.byteSize,0)+file.size > 50*1024*1024) throw new Error("attachment_batch_too_large");
        const filename=file.name || `clipboard-${Date.now()}.${file.type === "image/png" ? "png" : "bin"}`;
        const attachment=await requireOk<AttachmentRecord>(await sidecarFetch(hs(),`/content/attachments/upload?workspaceId=${encodeURIComponent(target.workspaceId)}&filename=${encodeURIComponent(filename)}`,{method:"POST",headers:{"Content-Type":file.type || "application/octet-stream"},body:file}));
        const current=roomView(target.roomId);
        if(current.draftAttachments.some(item=>item.id === attachment.id)) return;
        if(current.draftAttachments.length >= 10) throw new Error("attachment_count_exceeded");
        if(current.draftAttachments.reduce((sum,item)=>sum+item.byteSize,0)+attachment.byteSize > 50*1024*1024) throw new Error("attachment_batch_too_large");
        updateRoom(target.roomId,current=>({draftAttachments:[...current.draftAttachments,attachment]}));
      } catch(error) {updateRoom(target.roomId,{attachmentError:error instanceof Error ? error.message : String(error)});throw error;}
      finally {updateRoom(target.roomId,view=>({attachmentImports:Math.max(0,view.attachmentImports-1)}));}
    },
    removeDraftAttachment: (id) => set((state) => ({ draftAttachments: state.draftAttachments.filter((item) => item.id !== id) })),
    searchWorkspacePaths: async (query) => {
      const state = get();
      const boundId = state.sessions.find((session) => session.id === state.currentSessionId)?.workspaceId;
      if(state.sessions.find(session=>session.id === state.currentSessionId)?.kind === "chat") return set({workspacePathResults:[]});
      const workspace = (boundId ? state.workspaces.find((item) => item.id === boundId) : null) ?? state.activeWorkspace;
      if (!workspace) return set({ workspacePathResults: [] });
      const response = await sidecarFetch(hs(), `/content/workspaces/${workspace.id}/files?q=${encodeURIComponent(query)}`);
      const workspacePathResults=await requireOk<WorkspacePathResult[]>(response);
      if(get().currentSessionId === state.currentSessionId) set({workspacePathResults});
    },
    addWorkspaceRef: async (relativePath, target = get().captureRoomTarget()) => {
      const reference=await requireOk<WorkspaceRef>(await sidecarFetch(hs(),`/content/workspaces/${target.workspaceId}/refs`,{method:"POST",body:JSON.stringify({relativePath})}));
      updateRoom(target.roomId,view=>({draftWorkspaceRefs:view.draftWorkspaceRefs.some(item=>item.id === reference.id) ? view.draftWorkspaceRefs : [...view.draftWorkspaceRefs,reference],workspacePathResults:[]}));
      return reference;
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

    modelLists: {}, modelLoading:{}, modelListErrors:{},
    loadModels: async (providerId, force = false) => {
      if (!force && (get().modelLists[providerId] || get().modelLoading[providerId])) return;
      set(state=>({modelLoading:{...state.modelLoading,[providerId]:true},modelListErrors:{...state.modelListErrors,[providerId]:null}}));
      try {
        const models=await requireOk<string[]>(await sidecarFetch(hs(),`/providers/${providerId}/models`));
        set(state=>({modelLists:{...state.modelLists,[providerId]:models}}));
      } catch(error) {
        set(state=>({modelLists:{...state.modelLists,[providerId]:[]},modelListErrors:{...state.modelListErrors,[providerId]:error instanceof Error ? error.message : String(error)}}));
      } finally {set(state=>({modelLoading:{...state.modelLoading,[providerId]:false}}));}
    },

    modelContextWindows: {},
    loadModelContextWindow: async (providerId, modelId) => {
      if (!providerId || !modelId) return;
      const key = `${providerId}:${modelId}`;
      const res = await sidecarFetch(hs(), `/agents/context-window?providerId=${encodeURIComponent(providerId)}&modelId=${encodeURIComponent(modelId)}`).catch(()=>null);
      if (!res?.ok) return;
      const resolution = await res.json() as import("@socrates/core").ContextWindowResolution;
      set((s) => ({ modelContextWindows: { ...s.modelContextWindows, [key]: resolution } }));
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
        temperature: form.temperature === "" ? null : Number(form.temperature),
        userOverride: form.contextWindowDirty && form.contextWindowTokens !== ""
          ? Number(form.contextWindowTokens)
          : null,
        reasoningEffort: form.reasoningEffort,
      };
      const res = editingId
        ? await sidecarFetch(hs(), `/agents/${editingId}`, { method: "PUT", body: JSON.stringify(payload) })
        : await sidecarFetch(hs(), "/agents", { method: "POST", body: JSON.stringify(payload) });
      const saved = await requireOk<Agent>(res);
      await get().loadAgents();
      return saved;
    },
    removeAgent: async (id) => {
      await sidecarFetch(hs(), `/agents/${id}`, { method: "DELETE" });
      await Promise.all([get().loadAgents(), get().loadRooms()]);
    },

    loadRooms: async () => {
      set({ rooms: await (await sidecarFetch(hs(), "/rooms")).json() });
    },
    createRoomFromDraft: async (draft) => {
      const blocker = roomDraftBlocker(draft);
      if (blocker) throw new Error(blocker);
      const payload = roomCreatePayload(draft);
      const title = draft.title;
      const agents = payload.agentIds.map((id) => get().agents.find((item) => item.id === id));
      if (agents.some((agent) => !agent)) throw new Error("unknown_agent");
      const session = await requireOk<ConversationSession>(await sidecarFetch(hs(), "/sessions", {
        method: "POST",
        body: JSON.stringify({
          title,
          kind: payload.kind,
          mode: payload.mode,
          workspaceSelection: payload.workspaceSelection,
          primaryAgentId: payload.primaryAgentId,
          agents: agents.map((agent) => ({ agentId: agent!.id, snapshot: agent, executionEligible: true })),
        }),
      }));
      await Promise.all([get().loadSessions(), get().loadWorkspaces()]);
      await get().selectAgentSession(session.id);
    },
    renameRoom: async (id, name) => {
      await requireOk<Room>(await sidecarFetch(hs(), `/rooms/${id}`, {
        method: "PUT",
        body: JSON.stringify({ name }),
      }));
      await get().loadRooms();
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
    addSessionAgent: async (sessionId, agentId) => {
      const agent = get().agents.find((item) => item.id === agentId);
      if (!agent) throw new Error("unknown_agent");
      await requireOk<ConversationSession>(await sidecarFetch(hs(), `/sessions/${sessionId}/agents`, {
        method: "POST",
        body: JSON.stringify({ agentId, snapshot: agent }),
      }));
      await get().loadSessions();
    },
    removeSessionAgent: async (sessionId, agentId) => {
      await requireOk<ConversationSession>(await sidecarFetch(hs(), `/sessions/${sessionId}/agents/${agentId}`, { method: "DELETE" }));
      await get().loadSessions();
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
      const session=get().sessions.find(item=>item.id === id || item.legacyRoomId === id);
      if(session) {await get().selectAgentSession(session.id);return;}
      selectProjection(id,"room","chat");
      const messages=await requireOk<StoredMessage[]>(await sidecarFetch(hs(),`/rooms/${id}/messages`));
      updateRoom(id,{messages});
      if(get().currentRoomId !== id) return;
      await get().loadCurrentUsage(); void get().loadTasks();
    },

    loadTasks: async () => {
      const roomId = get().currentRoomId;
      if (!roomId) return;
      const tasks = await requireOk<TaskSummary[]>(await sidecarFetch(hs(), `/rooms/${roomId}/tasks`));
      if (get().currentRoomId === roomId) set({ tasks });
    },
    clearChatError: () => set({ chatError: null }),

    sendMessage: async (content) => {
      const roomId = get().currentRoomId;
      if (!roomId || get().streaming || get().activeTaskId || get().roomSending) return;
      const optimisticMessage: StoredMessage = {
        id: `local:${crypto.randomUUID()}`,
        roomId,
        role: "user",
        content,
        createdAt: new Date().toISOString(),
      };
      set((state) => ({ messages: [...state.messages, optimisticMessage] }));
      await streamPost(`/messages`, { content }, optimisticMessage);
    },

    sendTask: async (form) => {
      const roomId = get().currentRoomId;
      if (!roomId || get().streaming || get().activeTaskId || get().roomSending) return;
      const optimisticMessage: StoredMessage = {
        id: `local:${crypto.randomUUID()}`,
        roomId,
        role: "user",
        content: form.prompt,
        createdAt: new Date().toISOString(),
      };
      set((state) => ({ messages: [...state.messages, optimisticMessage] }));
      await streamPost(`/tasks`, form, optimisticMessage);
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
