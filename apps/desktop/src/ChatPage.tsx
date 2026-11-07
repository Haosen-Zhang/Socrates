import {taskResumeAction} from "./workPackageRecovery";
import SessionMessageAuthor from "./SessionMessageAuthor";
import RoomTimeline from "./RoomTimeline";
import RoomVerificationPanel from "./RoomVerificationPanel";
import type { SettingsSection } from "./settings/settingsOverlay";
import { hasOpenNestedDialog } from "./dialog/dialogLayer";
import AgentEditor from "./AgentEditor";
import RoomComposer from "./RoomComposer";
import RoomSidebar from "./sidebar/RoomSidebar";
import WorkContextBar from "./work/WorkContextBar";
import WorkProjectHub from "./work/WorkProjectHub";
import type { WorkContext } from "./work/workNavigation";
import { ActorPicker, ConfirmationDialog, DetailPanel, ErrorNotice, notify } from "./foundation";
import { useAnimatedDialogClose } from "./dialog/useAnimatedDialogClose";
import TeamTaskPanel from "./TeamTaskPanel";
import RoomCostPanel from "./cost/RoomCostPanel";
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MD_COMPONENTS } from "./markdownLink";
import { useThrottledValue } from "./useThrottledValue";
import { DEFAULT_WINDOW_SIZE, expandWindow, windowTail } from "./listWindow";
import { useTransientFlag } from "./useTransientFlag";
import { agentLabel, canAllowSessionApproval, validateCollaborationSettings, type Agent,
  type ConversationSession, type RoomCollaborationSettings,
  type SessionMessage, type StoredMessage, type TaskSummary,
} from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import PixelIcon from "./PixelIcon";
import { roomDraftBlocker, toggleRoomAgentSelection } from "./roomSelection";
import { useT, type MultiPlan, type StreamingTurn } from "./store";
import { useStorePick } from "./selectors";
import { sfx } from "./fx";
import { prepareNewRoomWorkspace, selectableProjectWorkspaces } from "./workspace/newRoomWorkspace";
import WorkspaceDock from "./workspace/WorkspaceDock";
import WorkspaceDockButtons from "./workspace/WorkspaceDockButtons";
import RoomOverview, { type RoomOverviewAgent } from "./workspace/RoomOverview";
import { toggleWorkspaceDock, type WorkspaceDockMode } from "./workspace/workspaceDockState";
import { AttachmentImage } from "./attachments/AttachmentTray";
import { canReviewPlan, moveAgentId } from "./multiAgentUi";
import { roomTitleOrFallback } from "./workspace/projectSelection";
import {
  ApprovalShelf,
  PublicReasoningPanel,
  ToolActivityTimeline,
} from "./tooling/ToolActivityTimeline";
import { projectPublicReasoning, projectToolActivities, toolActivityId } from "./tooling/toolActivity";
import { approvalModeOptions } from "./approvalPolicyUi";
import ApprovalPolicySegmented from "./ApprovalPolicySegmented";
import { agentRunErrorKey } from "./agentRunErrorUi";
import { canEditCollaboration, collaborationStrategyOptions, createCollaborationDraft } from "./collaborationSettingsUi";
import { taskStatusKey } from "./taskSurface";
import WindowRoomToolbar from "./window/WindowRoomToolbar";
import { clampPanelSize } from "./layout/panelResize";
import {
  deriveWindowChromeLayout,
  useWindowChromeState,
  type WindowToolbarMode,
} from "./window/windowChrome";

const DUTY_CLS: Record<string, string> = {
  propose: "bg-blue-100 text-blue-800",
  critique: "bg-red-100 text-red-800",
  synthesize: "bg-purple-100 text-purple-800",
  judge: "bg-amber-100 text-amber-800",
  summarize: "bg-amber-100 text-amber-800",
};

type RoomChromeControls = {
  sidebarHidden: boolean;
  toolbarMode: WindowToolbarMode;
  onToggleSidebar: () => void;
  workspaceId: string | null;
  dockMode: WorkspaceDockMode;
  onSelectDock: (mode: "overview" | "files" | "diff") => void;
};

function AgentHeader({ name, model, duty, avatar }: { name?: string; model?: string; duty?: string; avatar?: string }) {
  const t = useT();
  return (
    <div className="mb-1.5 flex items-center gap-2 text-xs text-neutral-500">
      <AgentAvatar src={avatar} label={name ?? "Agent"} size={30} />
      <span>{name} · {model}</span>
      {duty && DUTY_CLS[duty] && <span className={`px-1.5 py-0.5 text-[10px] font-medium ${DUTY_CLS[duty]}`}>{t(`duty_${duty}`)}</span>}
    </div>
  );
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // WKWebView 里 clipboard API 可能不可用，退回 execCommand
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  }
}

const DATE_LOCALE_OF: Record<string, string> = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US" };

type MessageActionTarget = Pick<StoredMessage | SessionMessage, "id" | "content" | "createdAt">;

/** 悬停消息时的操作条：时间 · 复制 · 回溯（二次点击确认）。 */
function MsgActions({
  m,
  align,
  busy = false,
  onRewind,
}: {
  m: MessageActionTarget;
  align: "left" | "right";
  busy?: boolean;
  onRewind: (messageId: string) => void;
}) {
  const { lang } = useStorePick("lang");
  const t = useT();
  const [copied, markCopied] = useTransientFlag(1500);
  const [confirming, markConfirming] = useTransientFlag(3000);
  const btn = "hover:text-neutral-700 hover:underline";

  return (
    <div
      className={`mt-0.5 flex items-center gap-2 text-[11px] text-neutral-400 opacity-0 transition-opacity group-hover:opacity-100 ${
        align === "right" ? "justify-end" : ""
      }`}
    >
      <span>
        {new Date(m.createdAt).toLocaleTimeString(DATE_LOCALE_OF[lang], { hour: "2-digit", minute: "2-digit" })}
      </span>
      <button
        className={btn}
        onClick={() => {
          void copyText(m.content).then((ok) => {
            if (ok) markCopied();
          });
        }}
      >
        {copied ? t("msg_copied") : t("msg_copy")}
      </button>
      {!busy && (
        <button
          className={`${btn} ${confirming ? "font-medium text-red-500" : ""}`}
          title={t("msg_rewind_confirm")}
          onClick={() => {
            if (!confirming) {
              markConfirming();
              return;
            }
            onRewind(m.id);
          }}
        >
          {confirming ? t("confirm_delete") : t("msg_rewind")}
        </button>
      )}
    </div>
  );
}

// memo：已完成气泡在流式期间不重渲染（busy 全程为 true 保持稳定，内容不变即跳过）
const Bubble = memo(function Bubble({ m, busy, onRewind }: { m: StoredMessage; busy: boolean; onRewind: (id: string) => void }) {
  if (m.role === "user") {
    return (
      // 任务的用户消息作为回放跳转锚点
      <div className="anim-msg group flex flex-col items-end" id={m.taskId ? `task-${m.taskId}` : undefined}>
        <div className="max-w-[70%] rounded-lg bg-neutral-900 px-3 py-2 text-sm whitespace-pre-wrap text-white">
          {m.content}
        </div>
        <MsgActions m={m} align="right" busy={busy} onRewind={onRewind} />
      </div>
    );
  }
  const isSummary = m.phase === "summary";
  return (
    <div className="anim-msg group flex justify-start">
      <div className={isSummary ? "w-full max-w-[85%]" : "max-w-[70%]"}>
        <AgentHeader name={m.agentName} avatar={m.agentAvatar} model={m.model} duty={m.duty ?? (isSummary ? "summarize" : undefined)} />
        <div
          className={`md-body rounded-lg px-3 py-2 text-sm ${
            isSummary ? "border-2 border-amber-300 bg-amber-50" : "border border-neutral-200 bg-white"
          }`}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{m.content}</Markdown>
        </div>
        <MsgActions m={m} align="left" busy={busy} onRewind={onRewind} />
      </div>
    </div>
  );
});

function RoundDivider({ round }: { round: number }) {
  const t = useT();
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-neutral-200" />
      <span className="text-xs text-neutral-400">{t("round_divider", { n: round })}</span>
      <div className="h-px flex-1 bg-neutral-200" />
    </div>
  );
}

function StreamingBubble({ s }: { s: StreamingTurn }) {
  // 节流 Markdown 源：流式期间不对每帧增量全量重解析（最终值仍会落定）
  const throttledText = useThrottledValue(s.text, 250);
  return (
    <div className="anim-msg flex justify-start">
      <div className={s.phase === "summary" ? "w-full max-w-[85%]" : "max-w-[70%]"}>
        <AgentHeader name={s.agentName} avatar={s.agentAvatar} model={s.model} duty={s.duty ?? (s.phase === "summary" ? "summarize" : undefined)} />
        <div
          className={`md-body rounded-lg px-3 py-2 text-sm ${
            s.phase === "summary" ? "border-2 border-amber-300 bg-amber-50" : "border border-neutral-200 bg-white"
          }`}
        >
          <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{throttledText}</Markdown>
          <span className="animate-pulse">▍</span>
        </div>
      </div>
    </div>
  );
}

const STATUS_CLS: Record<TaskSummary["status"], string> = {
  running: "bg-blue-100 text-blue-800",
  completed: "bg-green-100 text-green-800",
  failed: "bg-red-100 text-red-800",
  cancelled: "bg-neutral-200 text-neutral-600",
};

const DATE_LOCALE: Record<string, string> = { "zh-CN": "zh-CN", "zh-TW": "zh-TW", en: "en-US" };

/** 历史任务面板：时间、模式、状态、token 合计；点击定位到时间线中的回放位置 */
function TaskHistoryPanel({ onJump }: { onJump: (taskId: string) => void }) {
  const { tasks, lang } = useStorePick("tasks", "lang");
  const t = useT();
  if (tasks.length === 0) {
    return <p className="border-b border-neutral-200 bg-white px-4 py-2 text-xs text-neutral-500">{t("no_tasks")}</p>;
  }
  return (
    <ul className="anim-panel max-h-56 divide-y divide-neutral-100 overflow-y-auto border-b border-neutral-200 bg-white">
      {tasks.map((task) => (
        <li
          key={task.id}
          className="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm hover:bg-neutral-50"
          onClick={() => onJump(task.id)}
        >
          <span className="shrink-0 text-xs text-neutral-400">
            {new Date(task.createdAt).toLocaleString(DATE_LOCALE[lang], {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
          <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600">
            {task.mode === "debate" ? t("mode_debate") : t("mode_round_robin")}
          </span>
          <span
            className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLS[task.status]}`}
            title={task.error}
          >
            {t(`status_${task.status}`)}
          </span>
          <span className="min-w-0 flex-1 truncate">{task.prompt}</span>
          <span className="shrink-0 text-[10px] text-neutral-400">
            ↑{task.inputTokens} ↓{task.outputTokens}
          </span>
        </li>
      ))}
    </ul>
  );
}

/** 运行中任务的控制条：取消；turn 失败时给出 重试/跳过/终止 三选 */
function TaskControlBar() {
  const { activeTaskId, failedTurn, streaming, cancelTask, decideTurn } = useStorePick("activeTaskId", "failedTurn", "streaming", "cancelTask", "decideTurn");
  const t = useT();
  if (!activeTaskId) return null;
  if (failedTurn) {
    return (
      <div className="anim-panel mx-4 mb-2 flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="min-w-0 flex-1 truncate" title={failedTurn.message}>
          {t("turn_failed_msg", { name: failedTurn.agentName, msg: failedTurn.message })}
        </span>
        <button
          className="shrink-0 rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100"
          onClick={() => void decideTurn("retry")}
        >
          {t("retry")}
        </button>
        <button
          className="shrink-0 rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100"
          onClick={() => void decideTurn("skip")}
        >
          {t("skip_agent")}
        </button>
        <button
          className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-red-700 hover:bg-red-50"
          onClick={() => void decideTurn("abort")}
        >
          {t("abort_task")}
        </button>
      </div>
    );
  }
  return (
    <div className="anim-panel mx-4 mb-2 flex items-center justify-between rounded border border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
      <span className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-600" />
        {streaming ? t("speaking_now", { name: streaming.agentName }) : t("task_running")}
      </span>
      <button
        className="rounded border border-neutral-300 bg-white px-2 py-0.5 hover:bg-neutral-50"
        onClick={() => void cancelTask()}
      >
        {t("cancel_task")}
      </button>
    </div>
  );
}

function ArchivedRoomNotice({session}: {session: ConversationSession}) {
  const {archiveSession}=useStorePick("archiveSession");
  const t=useT();
  return <div role="status" className="mx-4 mt-3 flex items-center gap-3 text-xs text-neutral-600"><span>{t("room_archived_notice")}</span><button type="button" className="pixel-button px-2 py-1" onClick={()=>void archiveSession(session.id,false)}>{t("unarchive")}</button></div>;
}

function SingleAgentSession({ chrome }: { chrome: RoomChromeControls }) {
  const {
    sessions, currentSessionId, sessionMessages, agentEvents, agentStreamText, pendingApprovals,
    agentRunning, activeAgentRunId, agentError, agentCapabilities, updateApprovalPolicy, decideAgentApproval, cancelAgentRun, rewindSessionTo, continueAgentRun, multiStreamAgentId, workspaces,
  } = useStorePick("sessions", "currentSessionId", "sessionMessages", "agentEvents", "agentStreamText", "pendingApprovals", "agentRunning", "activeAgentRunId", "agentError", "agentCapabilities", "updateApprovalPolicy", "decideAgentApproval", "cancelAgentRun", "rewindSessionTo", "continueAgentRun", "multiStreamAgentId", "workspaces");
  // 窗口化：长会话只渲染最近 N 条，更早的可展开
  const [sessionLimit, setSessionLimit] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setSessionLimit(DEFAULT_WINDOW_SIZE), [currentSessionId]);
  const sessionWindow = windowTail(sessionMessages, sessionLimit);
  const t = useT();
  const [showCollab, setShowCollab] = useState(false);
  const [showRoster,setShowRoster]=useState(false);
  const session = sessions.find((item) => item.id === currentSessionId);
  const workspaceLabel = workspaces.find((workspace) => workspace.id === session?.workspaceId)?.label ?? t("workspace_none");
  const approvalOptions = approvalModeOptions(agentCapabilities?.approvalPolicy);
  const toolActivities = useMemo(
    () => projectToolActivities({
      messages: sessionMessages,
      events: agentEvents,
      approvals: pendingApprovals,
      activeRunId: activeAgentRunId,
    }),
    [sessionMessages, agentEvents, pendingApprovals, activeAgentRunId],
  );
  const reasoningSummaries = useMemo(
    () => projectPublicReasoning({
      messages: sessionMessages,
      events: agentEvents,
      running: agentRunning,
      activeRunId: activeAgentRunId,
    }),
    [sessionMessages, agentEvents, agentRunning, activeAgentRunId],
  );
  const visibleToolActivityIds = new Set(sessionWindow.visible.flatMap((message) => message.parts
    .filter((part) => part.type === "tool_call")
    .map((part) => toolActivityId(message.runId, part.callId))));
  const visibleSequence = sessionWindow.visible[0]?.sequence ?? Number.MAX_SAFE_INTEGER;
  const unanchoredToolActivities = toolActivities.filter((activity) => (
    !visibleToolActivityIds.has(activity.id) && activity.sequence >= visibleSequence
  ));
  const liveReasoningSummaries = reasoningSummaries.filter((summary) => summary.id === "live-reasoning-summary");
  const streamingText = agentStreamText;
  const strategy = session?.collaboration.strategy ?? "single";
  const status = taskStatusKey(agentError ? "failed" : agentRunning ? "executing" : null);
  const strategyStatus = `${session?.kind === "chat" ? `Chat · ${t(session.collaboration.discussion.enabled ? "team_discussion":"direct_response")}` : t(`strategy_${strategy}`)} · ${t(status)}`;
  const lastWorkspaceSignal=[...agentEvents].reverse().find(event=>(event.type === "extension" && event.name === "workspace_queued") || (event.type === "status" && ["running","ready"].includes(event.status)));
  const queued=agentRunning && lastWorkspaceSignal?.type === "extension";
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WindowRoomToolbar
        title={session?.title ?? "Socrates"}
        subtitle={strategyStatus}
        sidebarHidden={chrome.sidebarHidden}
        toolbarMode={chrome.toolbarMode}
        collapseLabel={t("sidebar_collapse")}
        expandLabel={t("sidebar_expand")}
        onToggleSidebar={chrome.onToggleSidebar}
      >
        <div className="pixel-window-toolbar__room-actions">
          {session?.kind === "cowork" && <WorkspaceDockButtons mode={chrome.dockMode} onSelect={chrome.onSelectDock} />}
          {session && <button className="pixel-button px-2 py-1 text-xs" onClick={()=>setShowRoster(true)}>{t("room_members_title")}</button>}
          {session && <button className="pixel-button pixel-toolbar-icon-action" onClick={() => setShowCollab(true)} title={t("cowork_settings_title")} aria-label={t("cowork_settings_title")}><PixelIcon name="gear" size={16} /></button>}
          {agentRunning && <button className="pixel-button px-2 py-1 text-xs text-red-700" onClick={() => void cancelAgentRun()}>{t("cancel_task")}</button>}
        </div>
      </WindowRoomToolbar>
      {session?.archived && <ArchivedRoomNotice session={session}/>}
    <RoomTimeline roomId={currentSessionId ?? ""} className="flex-1 space-y-3 overflow-y-auto p-4">
        {sessionWindow.hiddenCount > 0 && (
          <button className="pixel-button mx-auto block px-3 py-1 text-xs" onClick={() => setSessionLimit((limit) => expandWindow(limit, sessionMessages.length))}>
            {t("show_earlier", { n: sessionWindow.hiddenCount })}
          </button>
        )}
        {sessionWindow.visible.map((message) => {
          const messageReasoning = reasoningSummaries.filter((summary) => summary.id === message.id);
          if (message.kind === "tool_call") {
            const callId = message.parts.find((part) => part.type === "tool_call")?.callId;
            const activity = toolActivities.find((item) => item.id === toolActivityId(message.runId, callId ?? ""));
            return (
              <Fragment key={message.id}>
                {messageReasoning.length > 0 && <PublicReasoningPanel summaries={messageReasoning} running={messageReasoning.some((summary) => summary.running)} />}
                {activity && <ToolActivityTimeline activities={[activity]} showHeading={false} />}
              </Fragment>
            );
          }
          if (message.kind === "summary") {
            return <PublicReasoningPanel key={message.id} summaries={messageReasoning} running={false} />;
          }
          if (message.kind !== "text" && message.kind !== "error") return null;
          const author=session?.agents.find(member=>member.agentId === message.authorId);
          return (
            <Fragment key={message.id}>
              {messageReasoning.length > 0 && <PublicReasoningPanel summaries={messageReasoning} running={messageReasoning.some((summary) => summary.running)} />}
              <div className={`anim-msg group flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
                {message.role === "assistant" && <SessionMessageAuthor message={message} roomSnapshot={author?.snapshot}/>}
                <div className={`pixel-card max-w-[78%] p-3 text-sm ${message.role === "user" ? "whitespace-pre-wrap bg-violet-50" : "md-body bg-white"}`}>
                  {message.role === "user" ? message.content : <Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{message.content}</Markdown>}
                  {message.parts.filter((part) => part.type !== "text" && part.type !== "reasoning_summary").length > 0 && <div className="mt-2 flex flex-wrap gap-2">
                    {message.parts.map((part, index) => part.type === "image"
                      ? <AttachmentImage key={`${part.attachmentId}-${index}`} id={part.attachmentId} alt={part.alt ?? "image"} className="max-h-64 w-auto max-w-full" />
                      : part.type === "file" ? <span key={`${part.attachmentId}-${index}`} className="pixel-chip">{part.filename}</span>
                      : part.type === "workspace_ref" ? <span key={`${part.refId}-${index}`} className="pixel-chip">@{part.relativePath}</span>
                      : null)}
                  </div>}
                </div>
                <MsgActions m={message} align={message.role === "user" ? "right" : "left"} busy={agentRunning} onRewind={(messageId) => void rewindSessionTo(messageId)} />
              </div>
            </Fragment>
          );
        })}
        <PublicReasoningPanel summaries={liveReasoningSummaries} running={agentRunning} />
        <ToolActivityTimeline activities={unanchoredToolActivities} showHeading={false} />
        {session?.kind === "cowork" && <RoomVerificationPanel roomId={session.id}/>}
        {agentRunning && streamingText && <div className="pixel-card max-w-[78%] whitespace-pre-wrap bg-white p-3 text-sm"><AgentHeader name={String(session?.agents.find(member=>member.agentId===multiStreamAgentId)?.snapshot.nickname ?? "Agent")} model={String(session?.agents.find(member=>member.agentId===multiStreamAgentId)?.snapshot.modelId ?? "")}/>{streamingText}</div>}
      </RoomTimeline>
      {queued && <p role="status" className="mx-4 mb-2 text-xs text-amber-700">{t("workspace_writer_queued")}</p>}
      {agentError && <div role="alert" className="mx-4 mb-2 text-xs text-red-700">{agentError === "budget_exhausted" ? t("budget_exhausted") : t(agentRunErrorKey(agentError))}{agentError === "budget_exhausted" && <button className="pixel-button ml-2 px-3 py-1" onClick={()=>void continueAgentRun()}>{t("continue_task")}</button>}</div>}
      <ApprovalShelf approvals={pendingApprovals} activities={toolActivities} workspaceLabel={workspaceLabel} busy={false} onDecision={decideAgentApproval}/>
      {session && <RoomCostPanel key={`cost-${session.id}`} roomId={session.id} />}
      {session && !session.archived && <RoomComposer key={session.id} session={session} running={agentRunning} onOpenSettings={()=>setShowCollab(true)}/>}
        {session?.kind === "cowork" && (
          <div className="approval-policy-row mt-2 flex min-w-0 items-center gap-2 px-1 text-[11px] text-neutral-600">
            <span className="shrink-0">{t("approval_policy_label")}</span>
            <ApprovalPolicySegmented
              value={session.approvalPolicy.mode}
              options={approvalOptions}
              labels={{
                ask: t("approval_mode_ask_short"),
                auto_safe: t("approval_mode_auto_safe_short"),
                workspace_full: t("approval_mode_workspace_full_short"),
              }}
              descriptions={{
                ask: t("approval_mode_ask_description"),
                auto_safe: t("approval_mode_auto_safe_description"),
                workspace_full: t("approval_mode_workspace_full_description"),
              }}
              onChange={(mode) => void updateApprovalPolicy(session.id, mode)}
            />
            <span className="truncate" title={t(`approval_mode_${session.approvalPolicy.mode}_description`)}>
              {t(`approval_mode_${session.approvalPolicy.mode}_description`)}
            </span>
          </div>
        )}
      {showRoster && session && <SessionMembersDialog session={session} onClose={()=>setShowRoster(false)}/>}
    {showCollab && session && <CoworkRoomSettingsDialog session={session} onClose={() => setShowCollab(false)} />}
    </div>
  );
}

function MultiPlanCard({ plan }: { plan: MultiPlan }) {
  const { currentMultiTask, decideMultiPlan } = useStorePick("currentMultiTask", "decideMultiPlan");
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(plan.content, null, 2));
  const [revision, setRevision] = useState("");
  const pending = canReviewPlan(currentMultiTask?.state ?? "", plan.status);
  const editAndApprove = () => {
    try { void decideMultiPlan({ decision: "edit_and_approve", content: JSON.parse(draft) as MultiPlan["content"] }); }
    catch { /* JSON remains editable */ }
  };
  return (
    <section className="pixel-card border-2 border-violet-400 p-4" aria-label={t("multi_plan_title")}>
      <div className="flex items-start justify-between gap-3">
        <div><div className="pixel-kicker">PLAN v{plan.version}</div><h3 className="text-lg font-bold">{plan.content.objective}</h3><p className="mt-1 text-sm text-neutral-600">{plan.content.summary}</p></div>
        <span className="pixel-chip">{plan.status}</span>
      </div>
      {editing ? <textarea className="pixel-input mt-4 min-h-72 w-full p-3 font-mono text-xs" value={draft} onChange={(event) => setDraft(event.target.value)} /> : (
        <ol className="mt-4 space-y-3">
          {plan.content.steps.map((step) => <li key={step.id} className="border-l-4 border-violet-300 pl-3">
            <strong>{step.id}. {step.title}</strong><p className="mt-1 text-sm">{step.description}</p>
            {step.files.length > 0 && <div className="mt-2 flex flex-wrap gap-1">{step.files.map((file) => <code key={file} className="pixel-chip">{file}</code>)}</div>}
            {step.commands.map((command) => <pre key={command} className="mt-2 overflow-x-auto bg-neutral-900 p-2 text-xs text-white">{command}</pre>)}
            {step.risks.length > 0 && <p className="mt-2 text-xs text-amber-700">⚠ {step.risks.join(" · ")}</p>}
            {step.verification.length > 0 && <p className="mt-1 text-xs text-neutral-600">{t("acceptance_criteria")}: {step.verification.join(" · ")}</p>}
          </li>)}
        </ol>
      )}
      {pending && <div className="mt-4 space-y-3 border-t border-neutral-200 pt-3">
        <input className="pixel-input w-full px-3 py-2 text-sm" value={revision} onChange={(event) => setRevision(event.target.value)} placeholder={t("multi_revision_placeholder")} />
        <div className="flex flex-wrap gap-2">
          <button className="pixel-button pixel-button--primary px-3 py-2 text-xs" onClick={() => void decideMultiPlan({ decision: "approve_exact_plan" })}>{t("multi_plan_approve")}</button>
          <button className="pixel-button px-3 py-2 text-xs" onClick={() => editing ? editAndApprove() : setEditing(true)}>{editing ? t("multi_edit_approve") : t("edit")}</button>
          <button className="pixel-button px-3 py-2 text-xs" onClick={() => void decideMultiPlan({ decision: "request_replan", reason: revision || undefined })}>{t("multi_plan_replan")}</button>
          <button className="pixel-button px-3 py-2 text-xs text-red-700" onClick={() => void decideMultiPlan({ decision: "reject", reason: revision || undefined })}>{t("multi_plan_reject")}</button>
        </div>
      </div>}
    </section>
  );
}

function MultiAgentSession({ chrome }: { chrome: RoomChromeControls }) {
  const {
    sessions, currentSessionId, sessionMessages, currentMultiTask, multiRunning, multiError, multiStreamAgentId, multiLiveStreams, agentRunning, agentStreamText, agentError, cancelAgentRun,
    loadMultiTask, decideMultiApproval, cancelMultiTask, pauseMultiTask, resumeMultiTask, retryMultiTask, rewindSessionTo,
  } = useStorePick("sessions", "currentSessionId", "sessionMessages", "currentMultiTask", "multiRunning", "multiError", "multiStreamAgentId", "multiLiveStreams", "agentRunning", "agentStreamText", "agentError", "cancelAgentRun", "loadMultiTask", "decideMultiApproval", "cancelMultiTask", "pauseMultiTask", "resumeMultiTask", "retryMultiTask", "rewindSessionTo");
  // 窗口化：长会话只渲染最近 N 条，更早的可展开
  const [sessionLimit, setSessionLimit] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setSessionLimit(DEFAULT_WINDOW_SIZE), [currentSessionId]);
  const sessionWindow = windowTail(sessionMessages, sessionLimit);
  const teamToolActivities=useMemo(()=>projectToolActivities({messages:sessionMessages,events:[],approvals:currentMultiTask?.pendingApprovals ?? [],activeRunId:null}),[sessionMessages,currentMultiTask?.pendingApprovals]);
  const teamReasoning=useMemo(()=>projectPublicReasoning({messages:sessionMessages,events:[],running:false,activeRunId:null}),[sessionMessages]);
  const t = useT();
  const session = sessions.find((item) => item.id === currentSessionId);
  const participants: Array<{ id: string; nickname?: unknown; avatar?: unknown; modelId?: unknown; [key: string]: unknown }> = session?.agents.map((item) => ({ id: item.agentId, ...item.snapshot })) ?? [];
  const [showCollab, setShowCollab] = useState(false);
  const [showRoster,setShowRoster]=useState(false);
  // 主实时路径是 SSE delta / turn 事件（见 store.sendMultiTask）；此定时器仅为无 SSE 流阶段
  // （如 executing）的兜底对账，2s 一次，不再是 750ms 的主轮询。
  useEffect(() => {
    if (!currentMultiTask || ["awaiting_plan_approval", "failed", "cancelled", "completed", "paused"].includes(currentMultiTask.state)) return;
    const timer = window.setInterval(() => void loadMultiTask(currentMultiTask.id), 2000);
    return () => window.clearInterval(timer);
  }, [currentMultiTask?.id, currentMultiTask?.state, loadMultiTask]);
  const terminal = !currentMultiTask || ["failed", "cancelled", "completed"].includes(currentMultiTask.state);
  const pausable = currentMultiTask && ["preparing", "discussing", "synthesizing", "executing", "awaiting_tool_approval"].includes(currentMultiTask.state);
  const strategy = session?.collaboration.strategy ?? "team";
  const status = taskStatusKey(
    multiError || agentError ? "failed" : agentRunning ? "discussing" : multiRunning && !currentMultiTask ? "preparing" : currentMultiTask?.state ?? null,
  );
  const strategyStatus = `${t(`strategy_${strategy}`)} · ${t(status)}`;
  const resumeAction=currentMultiTask ? taskResumeAction(currentMultiTask) : "resume";
  const handleResume=()=>{
    if(!currentMultiTask) return;
    if(resumeAction === "packages") document.getElementById(`team-packages-${currentMultiTask.id}`)?.scrollIntoView({behavior:"smooth",block:"start"});
    else void (resumeAction === "retry" ? retryMultiTask() : resumeMultiTask());
  };
  return <div className="flex min-h-0 flex-1 flex-col">
    <WindowRoomToolbar title={session?.title ?? "Socrates"} subtitle={strategyStatus} sidebarHidden={chrome.sidebarHidden} toolbarMode={chrome.toolbarMode} collapseLabel={t("sidebar_collapse")} expandLabel={t("sidebar_expand")} onToggleSidebar={chrome.onToggleSidebar}>
      <div className="pixel-window-toolbar__room-actions"><button className="pixel-button px-2 py-1 text-xs" onClick={()=>setShowRoster(true)}>{t("room_members_title")}</button><WorkspaceDockButtons mode={chrome.dockMode} onSelect={chrome.onSelectDock} />{session && canEditCollaboration(currentMultiTask?.state) && <button className="pixel-button pixel-toolbar-icon-action" onClick={() => setShowCollab(true)} title={t("cowork_settings_title")} aria-label={t("cowork_settings_title")}><PixelIcon name="gear" size={16} /></button>}{currentMultiTask?.state === "paused" ? <button className="pixel-button pixel-toolbar-task-action pixel-button--primary px-2 py-1 text-xs" onClick={handleResume}>{t(resumeAction === "packages" ? "view_work_packages" : resumeAction === "retry" ? "multi_retry_reviewed" : "multi_resume")}</button> : pausable && <button className="pixel-button pixel-toolbar-task-action px-2 py-1 text-xs" onClick={() => void pauseMultiTask()}>{t("multi_pause")}</button>}{agentRunning && <button className="pixel-button px-2 py-1 text-xs" onClick={()=>void cancelAgentRun()}>{t("cancel_task")}</button>}{currentMultiTask && !terminal && <button className="pixel-button pixel-toolbar-task-action px-2 py-1 text-xs text-red-700" onClick={() => void cancelMultiTask()}>{t("cancel_task")}</button>}</div>
    </WindowRoomToolbar>
    {session?.archived && <ArchivedRoomNotice session={session}/>}
    <RoomTimeline roomId={currentSessionId ?? ""} className="flex-1 space-y-4 overflow-y-auto p-4">
      {agentError && <div role="alert" className="border border-red-300 bg-red-50 p-3 text-xs text-red-700">{t(agentRunErrorKey(agentError))}</div>}
      {multiError && <div role="alert" className="border border-red-300 bg-red-50 p-3 text-xs text-red-700">{t(multiError)}</div>}
      {/* 执行是脱离 SSE 的后台任务，失败原因不会走 task_failed 事件——直接读 terminalReason 展示 */}
      {!multiError && currentMultiTask?.state === "failed" && currentMultiTask.terminalReason && (
        <div role="alert" className="border border-red-300 bg-red-50 p-3 text-xs text-red-700">{t("multi_failed_reason", { reason: t(currentMultiTask.terminalReason) })}</div>
      )}
      {currentMultiTask?.state === "paused" && currentMultiTask.outcomeUnknown && <div role="alert" className="border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900">{t("multi_outcome_unknown")}</div>}
      {currentMultiTask?.state === "paused" && currentMultiTask.requiresExecutionReview && <div role="alert" className="border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900">{t("multi_execution_review")}</div>}
      {sessionWindow.hiddenCount > 0 && (
          <button className="pixel-button mx-auto block px-3 py-1 text-xs" onClick={() => setSessionLimit((limit) => expandWindow(limit, sessionMessages.length))}>
            {t("show_earlier", { n: sessionWindow.hiddenCount })}
          </button>
        )}
        {sessionWindow.visible.map((message) => {
        if(message.kind === "tool_result") return null;
        if(message.kind === "tool_call") {
          const call=message.parts.find(part=>part.type === "tool_call");
          const activity=teamToolActivities.find(item=>item.id===toolActivityId(message.runId,call?.callId ?? ""));
          return activity ? <ToolActivityTimeline key={message.id} activities={[activity]} showHeading={false}/> : null;
        }
        if(message.kind === "summary") return <PublicReasoningPanel key={message.id} summaries={teamReasoning.filter(item=>item.id === message.id)} running={false}/>;
        const author = session?.agents.find((item) => item.agentId === message.authorId);
        return <div key={message.id} className={`anim-msg group flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}><div className="max-w-[82%]">
          {message.role !== "user" && <SessionMessageAuthor message={message} roomSnapshot={author?.snapshot}/>}
          <div className={`md-body pixel-card p-3 text-sm ${message.role === "user" ? "bg-violet-50" : "bg-white"}`}><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{message.content}</Markdown></div>
        </div><MsgActions m={message} align={message.role === "user" ? "right" : "left"} busy={multiRunning} onRewind={(messageId) => void rewindSessionTo(messageId)} /></div>;
      })}
      {Object.entries(multiLiveStreams).map(([streamId, stream]) => {
        const member=session?.agents.find(item=>item.agentId === stream.agentId);
        return <div key={streamId} className="pixel-card p-3 text-sm"><AgentHeader name={String(member?.snapshot.nickname ?? stream.agentId)} model={String(member?.snapshot.modelId ?? "")}/><div className="md-body whitespace-pre-wrap">{stream.text || t("multi_thinking")}<span className="animate-pulse">▋</span></div></div>;
      })}
      {agentRunning && agentStreamText && <div className="pixel-card whitespace-pre-wrap p-3 text-sm"><AgentHeader name={String(participants.find(member=>member.id===multiStreamAgentId)?.nickname ?? "Agent")}/>{agentStreamText}</div>}
      {currentMultiTask?.plan && <MultiPlanCard plan={currentMultiTask.plan} />}
      {currentMultiTask?.pendingApprovals.map((approval) => <section key={approval.id} className="pixel-approval-card p-4">
        <div className="flex items-center justify-between"><strong>{approval.kind}</strong><span className="pixel-chip">{approval.risk}</span></div>
        <p className="my-2 text-xs text-neutral-600">{approval.kind === "plan_scope_expansion" ? t("multi_scope_expansion") : t("multi_tool_approval_hint")}</p>
        <div className="flex gap-2"><button className="pixel-button pixel-button--primary px-3 py-1.5 text-xs" onClick={() => void decideMultiApproval(approval.id, "allow_once")}>{t("approval_allow_once")}</button>{canAllowSessionApproval(approval) && <button className="pixel-button px-3 py-1.5 text-xs" onClick={() => void decideMultiApproval(approval.id, "allow_session")}>{t("approval_allow_session")}</button>}<button className="pixel-button px-3 py-1.5 text-xs text-red-700" onClick={() => void decideMultiApproval(approval.id, "deny")}>{t("approval_deny")}</button></div>
      </section>)}
      {currentMultiTask && session && <><RoomVerificationPanel roomId={session.id} taskId={currentMultiTask.id}/><TeamTaskPanel task={currentMultiTask} session={session}/></>}

    </RoomTimeline>
    {session && <RoomCostPanel key={`cost-${session.id}`} roomId={session.id} />}
    {terminal && session && !session.archived && <RoomComposer key={session.id} session={session} running={multiRunning || agentRunning} onOpenSettings={()=>setShowCollab(true)}/> }
    {showRoster && session && <SessionMembersDialog session={session} onClose={()=>setShowRoster(false)}/>}
    {showCollab && session && <CoworkRoomSettingsDialog session={session} onClose={() => setShowCollab(false)} />}
  </div>;
}

function NewRoomDialog({ onClose, presetWorkspaceId, kind, onOpenSettings, settingsOpen }: { onClose: () => void; presetWorkspaceId?: string | null; kind: "chat" | "cowork"; onOpenSettings: () => void; settingsOpen:boolean }) {
  const { agents, workspaces, createRoomFromDraft, registerWorkspacePath } = useStorePick(
    "agents",
    "workspaces",
    "createRoomFromDraft",
    "registerWorkspacePath",
  );
  const t = useT();
  const projectWorkspaces = selectableProjectWorkspaces(workspaces);
  // 从某个工作区分组的「＋」进入时，沿用该 existing workspace。
  const locked = presetWorkspaceId != null && projectWorkspaces.some((w) => w.id === presetWorkspaceId);
  const [name, setName] = useState("");
  const [submitting,setSubmitting]=useState(false);
  const [creatingAgent,setCreatingAgent]=useState(false);
  const [memberQuery,setMemberQuery]=useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [primaryAgentId, setPrimaryAgentId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<"temporary" | "project">(locked ? "project" : "temporary");
  const [workspaceId, setWorkspaceId] = useState<string | null>(locked ? presetWorkspaceId! : null);
  const dialog = useAnimatedDialogClose(onClose);

  const pickAndRegisterWorkspace = async () => {
    const selected = await open({ directory: true, multiple: false, title: t("workspace_choose") });
    if (typeof selected !== "string") return null;
    return registerWorkspacePath(selected);
  };

  const toggle = (id: string) => {
    const next = toggleRoomAgentSelection(selected, id);
    setSelected(next);
    setPrimaryAgentId((current) => {
      if (current && next.includes(current)) return current;
      return next[0] ?? null;
    });
    setError(null);
  };

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !hasOpenNestedDialog(document) && !settingsOpen) dialog.close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dialog]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if(submitting) return;
    setSubmitting(true);
    try {
      const workspaceSelection = kind === "chat" ? {kind:"managed" as const} : await prepareNewRoomWorkspace({
        mode: workspaceMode,
        workspaceId,
        pickAndRegisterWorkspace,
      });
      if (!workspaceSelection) return;
      await createRoomFromDraft({
        kind,
        title: roomTitleOrFallback(name, t("room_untitled")),
        agentIds: selected,
        primaryAgentId,
        workspaceSelection,
      });
      dialog.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {setSubmitting(false);}
  };

  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <form
        onSubmit={submit}
        className="pixel-dialog max-h-[calc(100vh-32px)] w-[min(720px,calc(100vw-48px))] overflow-y-auto p-5"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-room-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <div className="pixel-kicker">NEW PARTY</div>
            <h2 id="new-room-title" className="text-xl font-bold">{t("new_room_title")}</h2>
            <p className="mt-1 text-sm text-neutral-500">{t(kind === "chat" ? "new_chat_room_subtitle":"new_room_subtitle")}</p>
          </div>
          <button
            type="button"
            className="pixel-button h-9 w-9 shrink-0"
            aria-label={t("close")}
            onClick={() => {
              sfx.close();
              dialog.close();
            }}
          >
            ×
          </button>
        </header>

        <label className="block text-sm font-bold">
          {t("room_name")}
          <input
            autoFocus
            className="pixel-input mt-1 w-full px-3 py-2.5 text-sm"
            placeholder={t("room_name_placeholder")}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
        </label>

        {kind === "cowork" && <div className="mt-5">
          <h3 className="mb-2 text-sm font-bold">{t("room_workspace")}</h3>
          <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("room_workspace")}>
            {(["temporary", "project"] as const).map((value) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={workspaceMode === value}
                disabled={locked}
                className={`pixel-mode-card p-3 text-left ${workspaceMode === value ? "is-selected" : ""} ${locked ? "cursor-not-allowed opacity-50" : ""}`}
                onClick={() => {
                  setWorkspaceMode(value);
                  setError(null);
                }}
              >
                <span className="block text-sm font-bold">{t(`workspace_mode_${value}`)}</span>
                <span className="mt-1 block text-[11px] text-neutral-500">{t(`workspace_mode_${value}_desc`)}</span>
              </button>
            ))}
          </div>
          {workspaceMode === "project" && (
            <div className="mt-3 grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
              <label className="block text-sm font-bold">
                {t("workspace_registered")}
                <select
                  className={`pixel-input mt-1 w-full px-3 py-2 text-sm ${locked ? "cursor-not-allowed opacity-70" : ""}`}
                  value={workspaceId ?? ""}
                  disabled={locked}
                  onChange={(event) => {
                    setWorkspaceId(event.target.value || null);
                    setError(null);
                  }}
                >
                  <option value="">{t("room_workspace_placeholder")}</option>
                  {projectWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>{workspace.label || workspace.displayPath}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="pixel-button flex items-center justify-center gap-2 px-3 py-2 text-sm"
                disabled={locked}
                onClick={async () => {
                  try {
                    const workspace = await pickAndRegisterWorkspace();
                    if (!workspace) return;
                    setWorkspaceId(workspace.id);
                    setError(null);
                  } catch (cause) {
                    setError(cause instanceof Error ? cause.message : String(cause));
                  }
                }}
              >
                <PixelIcon name="folder" size={16} />
                {t("workspace_add_folder")}
              </button>
            </div>
          )}
        </div>}

        <div className="mb-2 mt-5 flex items-center justify-between">
          <h3 className="text-sm font-bold">{t("choose_agents")}</h3>
          <span className="pixel-chip">{t("selected_agents", { n: selected.length })}</span>
        </div>
        <div className="mb-3 flex gap-2"><input type="search" aria-label={t("search_members")} placeholder={t("search_members")} className="pixel-input min-w-0 flex-1 px-3 py-2 text-sm" value={memberQuery} onChange={event=>setMemberQuery(event.target.value)}/><button type="button" className="pixel-button px-3 py-2 text-sm" onClick={()=>setCreatingAgent(true)}>+ {t("agent_create")}</button></div>
        {agents.length === 0 ? (
          <div className="pixel-empty p-6 text-center text-sm text-neutral-500">{t("create_agent_first")}</div>
        ) : (
          <div className="grid max-h-[42vh] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
            {agents.filter(agent=>`${agent.nickname} ${agent.role} ${agent.modelId}`.toLowerCase().includes(memberQuery.toLowerCase())).map((agent) => {
              const isSelected = selected.includes(agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  className={`pixel-room-agent-card flex min-w-0 items-center gap-3 p-3 text-left ${isSelected ? "is-selected" : ""}`}
                  aria-pressed={isSelected}
                  onClick={() => toggle(agent.id)}
                >
                  <AgentAvatar src={agent.avatar} label={agent.nickname} size={52} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-bold">{agent.nickname}</span>
                    <span className="block truncate text-xs text-neutral-500">{agent.role || agent.modelId}</span>
                  </span>
                  <span className="pixel-room-agent-check" aria-hidden>{isSelected ? "✓" : "+"}</span>
                </button>
              );
            })}
          </div>
        )}
        {selected.length>0 && <label className="mt-4 block text-sm">{t(kind === "chat" ? "default_responder":"default_executor")}<select className="pixel-input mt-1 w-full px-3 py-2" value={primaryAgentId ?? ""} onChange={event=>setPrimaryAgentId(event.target.value)}>{selected.map(id=><option value={id} key={id}>{agents.find(agent=>agent.id===id)?.nickname ?? id}</option>)}</select></label>}
        {error && <p className="mt-3 text-sm text-red-700">{error}</p>}
        <footer className="mt-5 flex items-center justify-between gap-4 border-t border-neutral-200 pt-4">
          <div className="flex min-w-0 items-center">
            <div className="flex -space-x-2">
              {selected.slice(0, 6).map((id) => {
                const agent = agents.find((item) => item.id === id);
                return agent ? <AgentAvatar key={id} src={agent.avatar} label={agent.nickname} size={30} lively={false} /> : null;
              })}
            </div>
            {selected.length > 6 && <span className="ml-2 text-xs text-neutral-500">+{selected.length - 6}</span>}
          </div>
          <div className="flex shrink-0 gap-3">
            <button className="pixel-button px-4 py-2 text-sm" type="button" onClick={dialog.close}>{t("cancel")}</button>
            <button
              className="pixel-button pixel-button--primary px-5 py-2 text-sm"
              type="submit"
              disabled={submitting || roomDraftBlocker({
                kind,
                title: name,
                agentIds: selected,
                primaryAgentId,
                workspaceSelection: workspaceMode === "temporary" || !workspaceId
                  ? { kind: "managed" }
                  : { kind: "existing", workspaceId },
              }) !== null}
            >
              {t("create_room")}
            </button>
          </div>
        </footer>
      </form>
      {creatingAgent && <AgentEditor onClose={()=>setCreatingAgent(false)} suspended={settingsOpen} onSaved={agent=>{setSelected(current=>[...current,agent.id]);setPrimaryAgentId(current=>current ?? agent.id);}} onSetupProvider={onOpenSettings}/>}
    </div>
  );
}

function RoomMembersDialog({
  roomId,
  memberIds,
  onClose,
}: {
  roomId: string;
  memberIds: string[];
  onClose: () => void;
}) {
  const { agents, addRoomAgent } = useStorePick("agents", "addRoomAgent");
  const t = useT();
  const dialog = useAnimatedDialogClose(onClose);
  const members = memberIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => !!agent);
  const available = agents.filter((agent) => !memberIds.includes(agent.id));
  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <section className="pixel-dialog w-[min(560px,calc(100vw-48px))] p-5" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="pixel-kicker">ROOM ROSTER</div>
            <h3 className="text-lg font-bold">{t("room_members_title")}</h3>
          </div>
          <button
            className="pixel-button h-8 w-8"
            onClick={() => {
              sfx.close();
              dialog.close();
            }}
            aria-label={t("close")}
          >
            ×
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {members.map((agent) => (
            <div key={agent.id} className="pixel-card flex items-center gap-3 p-3">
              <AgentAvatar src={agent.avatar} label={agent.nickname} size={52} />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{agentLabel(agent)}</div>
                <div className="truncate text-xs text-neutral-500">{agent.role || agent.modelId}</div>
              </div>
            </div>
          ))}
        </div>
        <div className="my-5 h-[2px] bg-neutral-200" />
        <h4 className="mb-2 text-sm font-bold">{t("invite_agents")}</h4>
        {available.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("all_agents_joined")}</p>
        ) : (
          <div className="space-y-2">
            {available.map((agent) => (
              <div key={agent.id} className="flex items-center gap-3 border-b border-neutral-200 py-2 last:border-0">
                <AgentAvatar src={agent.avatar} label={agent.nickname} size={42} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{agentLabel(agent)}</div>
                  <div className="truncate text-xs text-neutral-500">{agent.role || agent.modelId}</div>
                </div>
                <button className="pixel-button pixel-button--primary px-3 py-1.5 text-xs" onClick={() => void addRoomAgent(roomId, agent.id)}>
                  + {t("add_to_room")}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

/**
 * Chat / Work 房间协作设置，仅开放运行时已支持的选项。
 * 跨字段合法性用 core 的 validateCollaborationSettings 统一裁决，前后端同一份判断。
 */
function CoworkRoomSettingsDialog({ session, onClose }: { session: ConversationSession; onClose: () => void }) {
  const {
    agents,
    agentCapabilities,
    updateCollaboration,
    restoreCollaborationDefaults,
  } = useStorePick(
    "agents",
    "agentCapabilities",
    "updateCollaboration",
    "restoreCollaborationDefaults",
  );
  const t = useT();
  const dialog = useAnimatedDialogClose(onClose);
  const [draft, setDraft] = useState<RoomCollaborationSettings>(() => createCollaborationDraft({
    kind: session.kind, workspaceId: session.workspaceId, primaryAgentId: session.primaryAgentId,
    agentIds: session.agents.map(member => member.agentId),
  }, session.collaboration));
  const [primaryAgentId, setPrimaryAgentId] = useState(session.primaryAgentId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const memberIds = session.agents.map((agent) => agent.agentId);
  const nameOf = (id: string) => String(session.agents.find(member=>member.agentId===id)?.snapshot.nickname ?? agents.find((agent) => agent.id === id)?.nickname ?? id);
  const shape = {
    kind: session.kind,
    workspaceId: session.workspaceId,
    agentIds: memberIds,
    primaryAgentId,
  };
  const problems = validateCollaborationSettings(shape, draft);
  const patch = (over: Partial<RoomCollaborationSettings>) => { setDraft((current) => ({ ...current, ...over })); setError(null); };
  const patchAssignment = (over: Partial<RoomCollaborationSettings["assignment"]>) =>
    patch({ assignment: { ...draft.assignment, ...over } });
  const patchRouting = (over: Partial<RoomCollaborationSettings["assignment"]["routing"]>) =>
    patchAssignment({ routing: { ...draft.assignment.routing, ...over } });
  const patchDiscussion = (over: Partial<RoomCollaborationSettings["discussion"]>) =>
    patch({ discussion: { ...draft.discussion, ...over } });
  const patchPlan = (over: Partial<RoomCollaborationSettings["planConfirmation"]>) =>
    patch({ planConfirmation: { ...draft.planConfirmation, ...over } });
  const strategyOptions = collaborationStrategyOptions(agentCapabilities?.collaboration).filter(option=>session.kind === "cowork" || option.strategy === "single");

  const save = async () => {
    if (problems.length) { setError(problems[0]); return; }
    setSaving(true);
    try {
      await updateCollaboration(session.id, draft, primaryAgentId);
      dialog.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const memberSelect = (value: string | null, onPick: (id: string | null) => void, placeholder: string) => (
    <select className="pixel-input mt-1 w-full px-3 py-2 text-sm" value={value ?? ""} onChange={(event) => onPick(event.target.value || null)}>
      <option value="">{placeholder}</option>
      {memberIds.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
    </select>
  );
  const executableIds = session.agents
    .filter((member) => session.kind === "chat" || member.executionEligible)
    .map((member) => member.agentId);
  const strategyNeedsCoordinator = draft.strategy !== "single";
  const discussionAvailable = agentCapabilities?.collaboration.discussion === true;
  const routingAvailable = agentCapabilities?.collaboration.routing === true;

  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <section className="pixel-dialog max-h-[calc(100vh-40px)] w-[min(600px,calc(100vw-48px))] overflow-y-auto p-5" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="pixel-kicker">COLLABORATION SETTINGS</div>
            <h3 className="text-lg font-bold">{t("cowork_settings_title")}</h3>
            <p className="mt-1 text-xs text-neutral-500">{session.title}</p>
          </div>
          <button className="pixel-button h-8 w-8" aria-label={t("close")} onClick={() => { sfx.close(); dialog.close(); }}>×</button>
        </div>

        {session.kind === "cowork" && <>
        <label className="block text-sm font-bold">{t("execution_strategy")}</label>
        <div className="mt-1 grid grid-cols-3 gap-2">
          {strategyOptions.map(({ strategy, enabled }) => {
            const enoughMembers = strategy !== "team" || memberIds.length >= 2;
            const available = enabled && enoughMembers;
            return (
            <button
              key={strategy}
              type="button"
              disabled={!available}
              className={`pixel-mode-card p-3 text-left ${draft.strategy === strategy ? "is-selected" : ""}`}
              onClick={() => patch({ strategy })}
            >
              <span className="block text-sm font-bold">{t(`strategy_${strategy}`)}</span>
              <span className="mt-1 block text-[11px] text-neutral-500">
                {!enabled
                  ? t("runtime_unavailable")
                  : !enoughMembers
                    ? t("team_requires_multiple_members")
                    : t(`strategy_${strategy}_desc`)}
              </span>
            </button>
            );
          })}
        </div>

        </>}
        <div className="pixel-card mt-4 space-y-3 p-3">
          <h4 className="text-sm font-bold">{t("agent_assignment")}</h4>
          <label className="block text-sm font-bold">{t("primary_agent")}
            <select className="pixel-input mt-1 w-full px-3 py-2 text-sm" value={primaryAgentId} onChange={(event) => setPrimaryAgentId(event.target.value)}>
              {executableIds.map((id) => <option key={id} value={id}>{nameOf(id)}</option>)}
            </select>
          </label>
          {strategyNeedsCoordinator && (
            <label className="block text-sm font-bold">{t("coordinator_agent")}
              {memberSelect(
                draft.assignment.coordinatorAgentId,
                (id) => patchAssignment({ coordinatorAgentId: id }),
                t("coordinator_placeholder"),
              )}
            </label>
          )}
          {draft.strategy === "adaptive" && (
            <div>
              <div className="text-sm font-bold">{t("callable_members")}</div>
              <div className="mt-1 flex flex-wrap gap-2">
                {memberIds.map((id) => (
                  <label key={id} className="flex items-center gap-1 text-xs">
                    <input
                      type="checkbox"
                      checked={draft.assignment.callableAgentIds.includes(id)}
                      onChange={(event) => patchAssignment({
                        callableAgentIds: event.target.checked
                          ? [...draft.assignment.callableAgentIds, id]
                          : draft.assignment.callableAgentIds.filter((item) => item !== id),
                      })}
                    />
                    {nameOf(id)}
                  </label>
                ))}
              </div>
            </div>
          )}
          {draft.strategy === "team" && (
            <>
              <label className="block text-sm font-bold">{t("routing_mode")}
                <select disabled={!routingAvailable} className="pixel-input mt-1 w-full px-3 py-2 text-sm" value={draft.assignment.routing.mode} onChange={(event) => patchRouting({ mode: event.target.value as "automatic" | "manual" })}>
                  <option value="automatic">{t("routing_automatic")}</option>
                  <option value="manual">{t("routing_manual")}</option>
                </select>
              </label>
              {!routingAvailable && <p className="text-xs text-amber-700">{t("routing_runtime_unavailable")}</p>}
              {draft.assignment.routing.mode === "automatic" ? (
                <label className="block text-sm font-bold">{t("automatic_policy")}
                  <select disabled={!routingAvailable} className="pixel-input mt-1 w-full px-3 py-2 text-sm" value={draft.assignment.routing.automaticPolicy} onChange={(event) => patchRouting({ automaticPolicy: event.target.value as "cost" | "balanced" | "quality" })}>
                    {(["cost", "balanced", "quality"] as const).map((value) => (
                      <option key={value} value={value}>{t(`routing_policy_${value}`)}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  {(["lightweight", "complex", "critical"] as const).map((role) => (
                    <label key={role} className="block text-xs font-bold">{t(`routing_role_${role}`)}
                      <fieldset disabled={!routingAvailable}>
                        {memberSelect(
                          draft.assignment.routing[`${role}AgentId`],
                          (id) => patchRouting({ [`${role}AgentId`]: id }),
                          t("fallback_to_coordinator"),
                        )}
                      </fieldset>
                    </label>
                  ))}
                </div>
              )}
            </>
          )}
        </div>

        <div className="pixel-card mt-4 space-y-3 p-3">
          <label className="flex items-center justify-between gap-3 text-sm font-bold">
            <span>{t(session.kind === "chat" ? "team_discussion":"pre_execution_discussion")}</span>
            <input
              type="checkbox"
              disabled={!discussionAvailable || memberIds.length<2}
              checked={draft.discussion.enabled}
              onChange={(event) => patchDiscussion({ enabled: event.target.checked })}
            />
          </label>
          {draft.discussion.enabled && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <label className="block text-xs font-bold">{t("discussion_mode")}
                  <select className="pixel-input mt-1 w-full px-3 py-2 text-sm" value={draft.discussion.mode} onChange={(event) => patchDiscussion({ mode: event.target.value as "round_robin" | "debate" })}>
                    <option value="round_robin">{t("discussion_mode_round_robin")}</option>
                    <option value="debate" disabled>{t("discussion_mode_debate")} · {t("runtime_unavailable")}</option>
                  </select>
                </label>
                <label className="block text-xs font-bold">{t("max_discussion_rounds")}
                  <input className="pixel-input mt-1 w-full px-3 py-2 text-sm" type="number" min={1} max={20} value={draft.discussion.maxRounds} onChange={(event) => patchDiscussion({ maxRounds: Number(event.target.value) })} />
                </label>
              </div>
              <label className="block text-xs font-bold">{t("discussion_summary_agent")}
                {memberSelect(draft.discussion.summaryAgentId, (id) => patchDiscussion({ summaryAgentId: id }), t("summary_agent_placeholder"))}
              </label>
              <div>
                <div className="text-xs font-bold">{t("speaking_order")}</div>
                <div className="mt-1 space-y-1">
                  {draft.discussion.speakerOrder.map((id, index) => (
                    <div key={id} className="flex items-center justify-between border px-2 py-1 text-xs">
                      <span>{index + 1}. {nameOf(id)}</span>
                      <span className="flex gap-1">
                        <button type="button" disabled={index === 0} onClick={() => patchDiscussion({ speakerOrder: moveAgentId(draft.discussion.speakerOrder, id, -1) })}>↑</button>
                        <button type="button" disabled={index === draft.discussion.speakerOrder.length - 1} onClick={() => patchDiscussion({ speakerOrder: moveAgentId(draft.discussion.speakerOrder, id, 1) })}>↓</button>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>

        {session.kind === "cowork" && <>
        <div className="pixel-card mt-4 space-y-2 p-3">
          <h4 className="text-sm font-bold">{t("plan_confirmation")}</h4>
          {(["coordinator", "user", "reviewer"] as const).map((mode) => (
            <label key={mode} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name="plan-confirmation"
                disabled={agentCapabilities?.collaboration.planConfirmation.includes(mode) !== true}
                checked={draft.planConfirmation.mode === mode}
                onChange={() => patchPlan({ mode })}
              />
              {t(`plan_confirmation_${mode}`)}
              {agentCapabilities?.collaboration.planConfirmation.includes(mode) !== true
                && <span className="text-[10px] text-neutral-500">{t("runtime_unavailable")}</span>}
            </label>
          ))}
          {draft.planConfirmation.mode === "reviewer" && (
            <label className="block text-xs font-bold">{t("designated_reviewer")}
              {memberSelect(draft.planConfirmation.reviewerAgentId, (id) => patchPlan({ reviewerAgentId: id }), t("reviewer_placeholder"))}
            </label>
          )}
        </div>

        <div className="pixel-card mt-4 p-3">
          <h4 className="text-sm font-bold">{t("tool_permission_summary")}</h4>
          <p className="mt-1 text-xs text-neutral-500">
            {t(`tool_policy_${session.approvalPolicy.mode}`)} · {t("plan_approval_not_tool_approval")}
          </p>
        </div>

        </>}
        {(error || problems[0]) && <p role="alert" className="mt-3 text-sm text-red-700">{t(error ?? problems[0])}</p>}
        <div className="mt-5 flex justify-between gap-2">
          <button
            className="pixel-button px-3 py-2 text-sm"
            type="button"
            onClick={() => {
              setSaving(true);
              restoreCollaborationDefaults(session.id)
                .then(dialog.close)
                .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                .finally(() => setSaving(false));
            }}
          >
            {t("restore_global_defaults")}
          </button>
          <div className="flex gap-2">
          <button className="pixel-button px-3 py-2 text-sm" type="button" onClick={dialog.close}>{t("cancel")}</button>
          <button className="pixel-button pixel-button--primary px-4 py-2 text-sm" type="button" disabled={saving || problems.length > 0} onClick={save}>{t("save")}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

/** Co-work 房间的成员管理：可加人、可踢人（会话空闲时；至少保留一人）。加/减人后 mode 由后端重算。 */
function SessionMembersDialog({ session, onClose }: { session: ConversationSession; onClose: () => void }) {
  const { agents, providers, addSessionAgent, removeSessionAgent, applyMemberTemplate, updatePrimaryAgent } = useStorePick("agents", "providers", "addSessionAgent", "removeSessionAgent", "applyMemberTemplate", "updatePrimaryAgent");
  const t = useT();
  const [creatingAgent,setCreatingAgent]=useState(false);
  const [inviteId,setInviteId]=useState<string|null>(null);
  const [removeId,setRemoveId]=useState<string|null>(null);
  const [removing,setRemoving]=useState(false);
  const [error, setError] = useState<string | null>(null);
  const memberIds = session.agents.map((agent) => agent.agentId);
  const members = session.agents.map(member=>({...member.snapshot,id:member.agentId} as unknown as Agent));
  const available = agents.filter((agent) => !memberIds.includes(agent.id));
  const busy = !["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status);
  const run = (op: () => Promise<void>) => op().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));

  return (
    <DetailPanel open drawer title={t("room_members_title")} description={session.title} closeLabel={t("close")} onClose={onClose}>
        {busy && <p className="mb-3 text-xs text-amber-700">{t("active_session_members_locked")}</p>}
        <div className="space-y-2">
          {members.map((agent) => (
            <div key={agent.id} className="flex items-center gap-3 border-b border-neutral-200 py-2 last:border-0">
              <AgentAvatar src={agent.avatar} label={agent.nickname} size={42} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold">{agentLabel(agent)}</div>
                <div className="truncate text-xs text-neutral-500">{agent.role || agent.modelId}</div>
                {!providers.some(provider=>provider.id === agent.providerId) ? <p className="text-xs text-red-700">{t("provider_deleted")}</p> : !providers.find(provider=>provider.id === agent.providerId)?.enabled ? <p className="text-xs text-red-700">{t("provider_disabled")}</p> : null}
                {session.agents.find(member=>member.agentId===agent.id)?.unavailableReason === "multi_provider_key_missing" && <p className="text-xs text-red-700">{t("multi_provider_key_missing")}</p>}
                <details className="mt-1 text-xs"><summary>{t("member_configuration")}</summary><p>{agent.modelId} · {agent.reasoningEffort ?? "auto"} · T={agent.temperature ?? "—"}</p><p className="max-h-24 overflow-auto whitespace-pre-wrap">{agent.systemPrompt}</p></details>
                <div className="mt-2 flex flex-wrap gap-2"><button disabled={busy || session.primaryAgentId === agent.id} className="pixel-button px-2 py-1 text-xs" onClick={()=>void run(()=>updatePrimaryAgent(session.id,agent.id))}>{t(session.primaryAgentId===agent.id ? "default_member":"set_default_member")}</button><button disabled={busy || !agents.some(template=>template.id===agent.id)} className="pixel-button px-2 py-1 text-xs" onClick={()=>void run(()=>applyMemberTemplate(session.id,agent.id))}>{t("apply_template_update")}</button></div>
              </div>
              <button
                className="pixel-button px-3 py-1.5 text-xs text-red-700 disabled:opacity-40"
                disabled={busy || members.length <= 1}
                title={members.length <= 1 ? t("session_requires_at_least_one_member") : t("remove_member")}
                onClick={() => setRemoveId(agent.id)}
              >
                {t("remove_member")}
              </button>
            </div>
          ))}
        </div>
        <div className="my-5 h-[2px] bg-neutral-200" />
        <div className="mb-2 flex items-center justify-between"><h4 className="text-sm font-bold">{t("invite_agents")}</h4><button disabled={busy} className="pixel-button px-2 py-1 text-xs" onClick={()=>setCreatingAgent(true)}>+ {t("agent_create")}</button></div>
        {available.length === 0 ? (
          <p className="text-sm text-neutral-500">{t("all_agents_joined")}</p>
        ) : (
          <div className="space-y-3">
            <ActorPicker label={t("work_pick_member")} placeholder={t("search_members")} emptyLabel={t("work_no_matches")} value={inviteId}
              actors={available.map(agent=>({id:agent.id,label:agentLabel(agent),description:agent.role || agent.modelId,
                avatar:<AgentAvatar src={agent.avatar} label={agent.nickname} size={30}/>,disabled:busy,disabledReason:busy ? t("active_session_members_locked") : undefined}))}
              onChange={setInviteId}/>
            <button type="button" className="pixel-button pixel-button--primary px-3 py-2" disabled={busy || !available.some(agent=>agent.id === inviteId)} onClick={()=>{
              if(inviteId)void run(async()=>{await addSessionAgent(session.id,inviteId);setInviteId(null);notify(t("work_member_added"));});
            }}>+ {t("add_to_room")}</button>
          </div>
        )}
        {error && <ErrorNotice message={t(error)}/>}
      {creatingAgent && <AgentEditor onClose={()=>setCreatingAgent(false)} onSaved={agent=>{void run(()=>addSessionAgent(session.id,agent.id));}}/>}
      <ConfirmationDialog open={removeId !== null} onOpenChange={open=>{if(!open&&!removing)setRemoveId(null);}}
        title={t("work_remove_member")} description={`${members.find(agent=>agent.id === removeId)?.nickname ?? ""} · ${t("work_remove_hint")}`}
        confirmLabel={t("remove_member")} cancelLabel={t("cancel")} pending={removing} error={error ? t(error) : undefined}
        onConfirm={()=>{if(!removeId || removing)return;setRemoving(true);setError(null);
          void removeSessionAgent(session.id,removeId).then(()=>{setRemoveId(null);notify(t("work_member_removed"));}).catch(cause=>setError(String(cause))).finally(()=>setRemoving(false));}}/>
    </DetailPanel>
  );
}

export default function ChatPage({ onOpenSettings, settingsOpen=false }: { onOpenSettings: (section?:SettingsSection) => void; settingsOpen?:boolean }) {
  const { rooms, agents, sessions, workspaces, activeWorkspace, currentRoomId, currentSessionId, config, updateConfig, messages, streaming, activeTaskId, rewindTo, chatError, tasks, usageSummaries, clearChatError, handshake, roomNavigation } =
    useStorePick("rooms", "agents", "sessions", "workspaces", "activeWorkspace", "currentRoomId", "currentSessionId", "config", "updateConfig", "messages", "streaming", "activeTaskId", "rewindTo", "chatError", "tasks", "usageSummaries", "clearChatError", "handshake", "roomNavigation");
  const mode=roomNavigation.mode;
  const bubbleBusy = !!streaming || !!activeTaskId;
  const t = useT();
  const [creating, setCreating] = useState<false | { presetWorkspaceId: string | null }>(false);
  const [showTasks, setShowTasks] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [collabSessionId, setCollabSessionId] = useState<string | null>(null);
  const [dockModes,setDockModes]=useState<Record<string,WorkspaceDockMode>>({});
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  const currentRoom = rooms.find((room) => room.id === currentRoomId);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const boundWorkspaceId = currentSession?.workspaceId ?? null;
  const activeSessionWorkspaceId = workspaces.some((workspace) => workspace.id === boundWorkspaceId && !workspace.archived) ? boundWorkspaceId : null;
  const projectId = currentSession?.workspaceId ?? activeWorkspace?.id ?? null;
  const projectKey = projectId ?? "unbound";
  const [projectContexts,setProjectContexts]=useState<Record<string,WorkContext>>({});
  const workContext=projectContexts[projectKey] ?? "rooms";
  const changeWorkContext=useCallback((context:WorkContext)=>setProjectContexts(current=>({...current,[projectKey]:context})),[projectKey]);
  useEffect(()=>{if(currentSessionId)changeWorkContext("rooms");},[currentSessionId,changeWorkContext]);
  const project=workspaces.find(workspace=>workspace.id === projectId);
  const openRooms=useCallback(()=>changeWorkContext("rooms"),[changeWorkContext]);
  const activeConversationId = currentSessionId ?? currentRoomId;
  const defaultDockMode:WorkspaceDockMode=viewportWidth <= 980 ? "closed" : "overview";
  const dockMode=activeConversationId ? dockModes[activeConversationId] ?? defaultDockMode : "closed";
  const setDockMode=(value:React.SetStateAction<WorkspaceDockMode>)=>{if(activeConversationId) setDockModes(current=>({...current,[activeConversationId]:typeof value === "function" ? value(current[activeConversationId] ?? defaultDockMode) : value}));};
  const collapsed = config?.sidebar.collapsed ?? false;
  const windowState = useWindowChromeState();
  const chromeLayout = deriveWindowChromeLayout({
    sidebarHidden: collapsed,
    fullscreen: windowState.fullscreen,
    platform: windowState.platform,
  });
  const toggleSidebar = () => {
    if (!config) return;
    void updateConfig({ sidebar: { ...config.sidebar, collapsed: !collapsed } });
  };
  const chrome: RoomChromeControls = {
    sidebarHidden: !chromeLayout.sidebarVisible,
    toolbarMode: chromeLayout.toolbarMode,
    onToggleSidebar: toggleSidebar,
    workspaceId: activeSessionWorkspaceId,
    dockMode,
    onSelectDock: (mode) => setDockMode((current) => toggleWorkspaceDock(current, mode, !!activeSessionWorkspaceId)),
  };
  const bottomRef = useRef<HTMLDivElement>(null);
  const followBottom=useRef(true);

  const jumpToTask = (taskId: string) => {
    document.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // A smooth scroll for every token queues animations in WKWebView and makes
  // Enter feel delayed. New turns ease in once; streaming follows immediately.
  useEffect(() => {
    if(followBottom.current) bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);
  useEffect(() => {
    if (streaming?.text && followBottom.current) bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
  }, [streaming?.text]);

  const roomAgents = useMemo(
    () => (currentRoom?.agentIds ?? []).map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [currentRoom, agents],
  );
  const overviewAgents = useMemo<RoomOverviewAgent[]>(() => {
    if (currentSession) return currentSession.agents.map((entry) => ({
      id: entry.agentId,
      nickname: String(entry.snapshot.nickname ?? entry.agentId),
      avatar: String(entry.snapshot.avatar ?? ""),
      modelId: String(entry.snapshot.modelId ?? t("usage_unavailable")),
      role: String(entry.snapshot.role ?? ""),
      contextWindowTokens: typeof (entry.snapshot.modelCapabilities as { contextWindowTokens?: unknown } | undefined)?.contextWindowTokens === "number"
        ? (entry.snapshot.modelCapabilities as { contextWindowTokens: number }).contextWindowTokens : null,
      reasoningEffort: typeof entry.snapshot.reasoningEffort === "string" ? entry.snapshot.reasoningEffort as RoomOverviewAgent["reasoningEffort"] : null,
    }));
    return roomAgents.map((agent) => ({
      id: agent.id,
      nickname: agent.nickname,
      avatar: agent.avatar,
      modelId: agent.modelId,
      role: agent.role,
      contextWindowTokens: typeof agent.modelCapabilities?.contextWindowTokens === "number"
        ? agent.modelCapabilities.contextWindowTokens : null,
      reasoningEffort: agent.reasoningEffort ?? null,
    }));
  }, [currentSession, roomAgents, t]);

  // 时间线：轮次变化处插分隔线
  // 窗口化：只渲染最近 N 条，更早的折叠（DOM 上界；展开后行为与原先一致）
  const [chatLimit, setChatLimit] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setChatLimit(DEFAULT_WINDOW_SIZE), [currentRoomId]);
  const chatWindow = windowTail(messages, chatLimit);
  const timeline: Array<{ kind: "divider"; round: number; key: string } | { kind: "message"; m: StoredMessage }> = [];
  let lastRound: number | undefined;
  let lastTask: string | undefined;
  for (const m of chatWindow.visible) {
    if (m.taskId !== lastTask) lastRound = undefined; // 新任务重新计轮
    if (m.round !== undefined && m.round !== lastRound) {
      timeline.push({ kind: "divider", round: m.round, key: `${m.taskId}-${m.round}` });
      lastRound = m.round;
    }
    lastTask = m.taskId;
    timeline.push({ kind: "message", m });
  }
  const streamingDivider =
    streaming?.round !== undefined && streaming.round !== lastRound && streaming.phase !== "summary";

  const [sidebarWidth, setSidebarWidth] = useState(config?.sidebar.width ?? 256);
  const [dockWidth, setDockWidth] = useState(config?.sidebar.dockWidth ?? 420);
  useEffect(() => setSidebarWidth(config?.sidebar.width ?? 256), [config?.sidebar.width]);
  useEffect(() => setDockWidth(config?.sidebar.dockWidth ?? 420), [config?.sidebar.dockWidth]);
  useEffect(() => {
    let frame = 0;
    const resize = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => setViewportWidth(window.innerWidth)); };
    window.addEventListener("resize", resize);
    return () => { cancelAnimationFrame(frame); window.removeEventListener("resize", resize); };
  }, []);
  const sidebarMax = Math.min(480, Math.max(180, viewportWidth - 720));
  const effectiveSidebarWidth = clampPanelSize(sidebarWidth, 180, sidebarMax);
  const dockMax = Math.min(640, Math.max(300, viewportWidth - (collapsed ? 0 : effectiveSidebarWidth) - 420));
  const effectiveDockWidth = clampPanelSize(dockWidth, 300, dockMax);
  const commitSidebarWidth = useCallback((width: number) => {
    if (config) void updateConfig({ sidebar: { ...config.sidebar, width } });
  }, [config, updateConfig]);
  const commitDockWidth = (width: number) => {
    if (config) void updateConfig({ sidebar: { ...config.sidebar, dockWidth: width } });
  };

  return (
    <div className="flex h-[100dvh]" style={{ "--room-sidebar-width": `${effectiveSidebarWidth}px`, "--workspace-dock-width": `${effectiveDockWidth}px` } as React.CSSProperties}>
      <RoomSidebar onCreate={setCreating} onOpenSettings={onOpenSettings} onCollab={setCollabSessionId} onNavigateRoom={openRooms} width={effectiveSidebarWidth} maxWidth={sidebarMax} onResize={setSidebarWidth} onCommit={commitSidebarWidth} />
      {creating && <NewRoomDialog kind={mode} settingsOpen={settingsOpen} onOpenSettings={()=>onOpenSettings("providers")} onClose={() => setCreating(false)} presetWorkspaceId={creating.presetWorkspaceId} />}
      {collabSessionId && (() => {
        const target = sessions.find((session) => session.id === collabSessionId);
        return target ? <CoworkRoomSettingsDialog session={target} onClose={() => setCollabSessionId(null)} /> : null;
      })()}
      {showMembers && (currentSession
        ? <SessionMembersDialog session={currentSession} onClose={() => setShowMembers(false)} />
        : currentRoom ? <RoomMembersDialog roomId={currentRoom.id} memberIds={currentRoom.agentIds} onClose={() => setShowMembers(false)} /> : null)}

      <div className={mode === "cowork" ? "work-main" : "contents"}>
      {mode === "cowork" && <WorkContextBar context={workContext} project={project?.label} onChange={changeWorkContext}/>}
      {mode === "cowork" && workContext !== "rooms" && <WindowRoomToolbar title={project?.label ?? t("work_project")} sidebarHidden={chrome.sidebarHidden} toolbarMode={chrome.toolbarMode} collapseLabel={t("sidebar_collapse")} expandLabel={t("sidebar_expand")} onToggleSidebar={chrome.onToggleSidebar}/>}
      <section className="pixel-room-content flex min-h-0 min-w-0 flex-1 flex-col" style={mode === "cowork" && workContext !== "rooms" ? {display:"none"} : undefined} inert={mode === "cowork" && workContext !== "rooms" ? true : undefined}>
        {currentSessionId ? (currentSession?.collaboration.strategy === "team" ? <MultiAgentSession key={currentSessionId} chrome={chrome} /> : <SingleAgentSession key={currentSessionId} chrome={chrome} />) : currentRoomId ? (
          <>
            <WindowRoomToolbar
              title={currentRoom?.name ?? "Socrates"}
              sidebarHidden={chrome.sidebarHidden}
              toolbarMode={chrome.toolbarMode}
              collapseLabel={t("sidebar_collapse")}
              expandLabel={t("sidebar_expand")}
              onToggleSidebar={chrome.onToggleSidebar}
            >
              <button className="pixel-button px-2 py-1 text-xs" onClick={()=>setShowMembers(true)}>{t("room_members_title")}</button>
            </WindowRoomToolbar>
            {showTasks && <TaskHistoryPanel onJump={jumpToTask} />}
            <div key={currentRoomId} className="anim-view flex-1 space-y-3 overflow-y-auto p-4" onScroll={event=>{const el=event.currentTarget;followBottom.current=el.scrollHeight-el.scrollTop-el.clientHeight<80;}}>
              {chatWindow.hiddenCount > 0 && (
                <button
                  className="pixel-button mx-auto block px-3 py-1 text-xs"
                  onClick={() => setChatLimit((limit) => expandWindow(limit, messages.length))}
                >
                  {t("show_earlier", { n: chatWindow.hiddenCount })}
                </button>
              )}
              {timeline.map((item) =>
                item.kind === "divider" ? (
                  <RoundDivider key={item.key} round={item.round} />
                ) : (
                  <Bubble key={item.m.id} m={item.m} busy={bubbleBusy} onRewind={(id) => void rewindTo(id)} />
                ),
              )}
              {streaming && streamingDivider && <RoundDivider round={streaming.round!} />}
              {streaming && <StreamingBubble s={streaming} />}
              <div ref={bottomRef} />
            </div>
            <TaskControlBar />
            {chatError && (
              <div className="mx-4 mb-2 flex items-center justify-between rounded border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
                <span className="min-w-0 truncate" title={chatError}>
                  {chatError}
                </span>
                <button className="ml-2 shrink-0 underline" onClick={clearChatError}>
                  {t("close")}
                </button>
              </div>
            )}
            <p role="status" className="p-4 text-xs text-neutral-500">{t("room_session_unavailable")}</p>
          </>
        ) : (
          <>
            <WindowRoomToolbar
              title="Socrates"
              sidebarHidden={chrome.sidebarHidden}
              toolbarMode={chrome.toolbarMode}
              collapseLabel={t("sidebar_collapse")}
              expandLabel={t("sidebar_expand")}
              onToggleSidebar={chrome.onToggleSidebar}
            />
            <div className="flex flex-1 flex-col items-center justify-center gap-5 p-8 text-center">
              <span className="opacity-30"><PixelIcon name="chat" size={72} /></span>
              <div className="space-y-1.5">
                <p className="text-lg font-bold text-neutral-700">{t("pick_room_title")}</p>
                <p className="text-sm text-neutral-500">{t("pick_room")}</p>
              </div>
              <button className="pixel-button pixel-button--primary flex items-center gap-2 px-4 py-2 text-sm" onClick={() => setCreating({ presetWorkspaceId: mode === "cowork" ? activeWorkspace?.id ?? null : null })}>
                <PixelIcon name="plus" size={16} />
                {t("new_room")}
              </button>
            </div>
          </>
        )}
      </section>
      {mode === "cowork" && <WorkProjectHub key={projectKey} workspaceId={projectId} context={workContext} onOpenRoom={openRooms}/>}
      </div>
      {workContext === "rooms" && currentSession?.kind === "cowork" && dockMode !== "closed" && activeConversationId && (
        viewportWidth <= 980 ? <DetailPanel open drawer title={t("workspace_overview")} closeLabel={t("close")} onClose={()=>setDockMode("closed")}>
          <div className="work-dock-drawer">        <WorkspaceDock
          key={activeConversationId}
          handshake={handshake}
          workspaceId={activeSessionWorkspaceId}
          mode={dockMode}
          overview={<RoomOverview
            agents={overviewAgents}
            usage={usageSummaries}
            onManageMembers={() => setShowMembers(true)}
            onShowTasks={currentRoom ? () => setShowTasks((value) => !value) : undefined}
            taskCount={tasks.length}
          />}
          onSelect={setDockMode}
          onClose={() => setDockMode("closed")}
          resize={{ size: effectiveDockWidth, min: 300, max: dockMax, label: t("resize_workspace_dock"), onResize: setDockWidth, onCommit: commitDockWidth }}
        /></div>
        </DetailPanel> :         <WorkspaceDock
          key={activeConversationId}
          handshake={handshake}
          workspaceId={activeSessionWorkspaceId}
          mode={dockMode}
          overview={<RoomOverview
            agents={overviewAgents}
            usage={usageSummaries}
            onManageMembers={() => setShowMembers(true)}
            onShowTasks={currentRoom ? () => setShowTasks((value) => !value) : undefined}
            taskCount={tasks.length}
          />}
          onSelect={setDockMode}
          onClose={() => setDockMode("closed")}
          resize={{ size: effectiveDockWidth, min: 300, max: dockMax, label: t("resize_workspace_dock"), onResize: setDockWidth, onCommit: commitDockWidth }}
        />
      )}
    </div>
  );
}
