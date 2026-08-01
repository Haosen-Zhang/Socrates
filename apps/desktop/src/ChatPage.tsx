import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MD_COMPONENTS } from "./markdownLink";
import { useThrottledValue } from "./useThrottledValue";
import { DEFAULT_WINDOW_SIZE, expandWindow, windowTail } from "./listWindow";
import { useTransientFlag } from "./useTransientFlag";
import { agentLabel, normalizeCollaborationSettings, validateCollaborationSettings, type Agent,
  type ConversationSession, type RoomCollaborationSettings, type WorkspaceRecord,
  type SessionMessage, type StoredMessage, type TaskSummary,
  type ToolApprovalMode } from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import PixelIcon from "./PixelIcon";
import { isOwnedManagedWorkspace, roomDraftBlocker, toggleRoomAgentSelection } from "./roomSelection";
import { searchSidebar, topLevelRooms, workspaceGroups, type SidebarRoom } from "./sidebar/sidebarLists";
import { useT, type MultiPlan, type StreamingTurn } from "./store";
import { useStorePick } from "./selectors";
import { sfx } from "./fx";
import { shouldSubmitComposerEnter } from "./composerIme";
import { prepareNewRoomWorkspace, selectableProjectWorkspaces } from "./workspace/newRoomWorkspace";
import WorkspaceDock from "./workspace/WorkspaceDock";
import WorkspaceDockButtons from "./workspace/WorkspaceDockButtons";
import RoomOverview, { type RoomOverviewAgent } from "./workspace/RoomOverview";
import { toggleWorkspaceDock, type WorkspaceDockMode } from "./workspace/workspaceDockState";
import AttachmentTray, { AttachmentImage } from "./attachments/AttachmentTray";
import { canReviewPlan, moveAgentId } from "./multiAgentUi";
import ResizableComposer from "./composer/ResizableComposer";
import { roomTitleOrFallback } from "./workspace/projectSelection";
import {
  ApprovalShelf,
  PublicReasoningPanel,
  ToolActivityTimeline,
} from "./tooling/ToolActivityTimeline";
import { projectPublicReasoning, projectToolActivities, toolActivityId } from "./tooling/toolActivity";
import { approvalModeOptions } from "./approvalPolicyUi";
import { resolveSidebarRevealPath, revealResolvedSidebarTarget } from "./sidebar/revealInFinder";
import { agentRunErrorKey } from "./agentRunErrorUi";
import { canEditCollaboration, collaborationStrategyOptions } from "./collaborationSettingsUi";
import { taskStatusKey } from "./taskSurface";
import RoomTaskComposer from "./TaskComposer";
import WindowRoomToolbar from "./window/WindowRoomToolbar";
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

/** Let modal close transitions finish before their parent unmounts the dialog. */
function useAnimatedDialogClose(onClose: () => void) {
  const [closing, setClosing] = useState(false);
  const timeoutRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (timeoutRef.current !== null) window.clearTimeout(timeoutRef.current);
  }, []);
  return {
    closing,
    close: () => {
      if (closing) return;
      setClosing(true);
      timeoutRef.current = window.setTimeout(onClose, 150);
    },
  };
}

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

/** 发言顺序条目：勾选决定是否参与本次讨论，列表顺序即发言顺序 */
type OrderItem = { id: string; enabled: boolean };

/** 多 Agent 房间的任务发起表单：需求、参与者与发言顺序（拖拽）、轮数、最终总结者 */
/** 自适应高度的输入框：Enter 发送、Shift+Enter 换行；中文输入法组词中的 Enter 不触发发送 */
function ComposerTextarea({
  value,
  placeholder,
  disabled,
  onChange,
  onSubmit,
}: {
  value: string;
  placeholder?: string;
  disabled?: boolean;
  onChange: (v: string) => void;
  onSubmit: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const lastCompositionEndAt = useRef(Number.NEGATIVE_INFINITY);
  return (
    <textarea
      ref={ref}
      rows={1}
      className="flex-1 px-1 py-1.5 text-sm"
      style={{ resize: "none" }}
      placeholder={placeholder}
      disabled={disabled}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onCompositionStart={() => {
        composingRef.current = true;
      }}
      onCompositionEnd={() => {
        composingRef.current = false;
        lastCompositionEndAt.current = Date.now();
      }}
      onKeyDown={(e) => {
        const native = e.nativeEvent as globalThis.KeyboardEvent & { keyCode?: number };
        if (
          shouldSubmitComposerEnter(
            {
              key: e.key,
              shiftKey: e.shiftKey,
              isComposing: native.isComposing,
              keyCode: native.keyCode,
            },
            {
              composing: composingRef.current,
              lastCompositionEndAt: lastCompositionEndAt.current,
            },
          )
        ) {
          e.preventDefault();
          onSubmit();
        }
      }}
    />
  );
}

function TaskComposer({ agents }: { agents: Agent[] }) {
  const { streaming, roomSending, activeTaskId, sendTask } = useStorePick("streaming", "roomSending", "activeTaskId", "sendTask");
  const t = useT();
  const busy = !!streaming || roomSending || !!activeTaskId;
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState<"round_robin" | "debate">("round_robin");
  const [items, setItems] = useState<OrderItem[]>(agents.map((a) => ({ id: a.id, enabled: true })));
  const [dragId, setDragId] = useState<string | null>(null);
  const [maxRounds, setMaxRounds] = useState(2);
  const [summarizerId, setSummarizerId] = useState(agents[agents.length - 1]?.id ?? "");
  const defaultRoles = () => ({
    proposerId: agents[0]?.id ?? "",
    skepticId: agents[1]?.id ?? agents[0]?.id ?? "",
    synthesizerId: agents[2]?.id ?? agents[0]?.id ?? "",
    judgeId: agents[agents.length - 1]?.id ?? "",
  });
  const [roles, setRoles] = useState(defaultRoles);
  const [showConfig, setShowConfig] = useState(false);

  // 房间成员变化时重置顺序、总结者与辩论角色
  useEffect(() => {
    setItems(agents.map((a) => ({ id: a.id, enabled: true })));
    setSummarizerId(agents[agents.length - 1]?.id ?? "");
    setRoles({
      proposerId: agents[0]?.id ?? "",
      skepticId: agents[1]?.id ?? agents[0]?.id ?? "",
      synthesizerId: agents[2]?.id ?? agents[0]?.id ?? "",
      judgeId: agents[agents.length - 1]?.id ?? "",
    });
  }, [agents]);

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const speakingOrder = items.filter((i) => i.enabled).map((i) => i.id);

  const toggle = (id: string) =>
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, enabled: !i.enabled } : i)));

  // WKWebView 不可靠支持 HTML5 DnD（同 #23 的 contextmenu），用 pointer 事件自实现拖拽
  const listRef = useRef<HTMLUListElement>(null);
  const moveDragOver = (clientY: number) => {
    if (!dragId || !listRef.current) return;
    const rows = Array.from(listRef.current.querySelectorAll<HTMLElement>("[data-order-id]"));
    const over = rows.find((row) => {
      const r = row.getBoundingClientRect();
      return clientY >= r.top && clientY <= r.bottom;
    });
    const overId = over?.dataset.orderId;
    if (!overId || overId === dragId) return;
    setItems((prev) => {
      const from = prev.findIndex((i) => i.id === dragId);
      const to = prev.findIndex((i) => i.id === overId);
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const doSubmit = async () => {
    const p = prompt.trim();
    if (busy || !p || (mode === "round_robin" && speakingOrder.length === 0)) return;
    setPrompt("");
    await sendTask({
      prompt: p,
      mode,
      speakingOrder,
      maxRounds,
      finalSummarizerId: summarizerId,
      debate: mode === "debate" ? roles : undefined,
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void doSubmit();
      }}
      className="composer-dock space-y-2"
    >
      {showConfig && (
        <div className="pixel-composer-config anim-panel flex gap-4 px-3 py-2 text-sm">
          <div className="flex shrink-0 flex-col gap-1">
            <span className="text-neutral-500">{t("mode")}</span>
            {(
              [
                ["round_robin", t("mode_round_robin")],
                ["debate", t("mode_debate")],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                className={`rounded px-2 py-1 text-xs ${
                  mode === value ? "bg-neutral-900 text-white" : "border border-neutral-300 bg-white hover:bg-neutral-100"
                }`}
                onClick={() => setMode(value)}
              >
                {label}
              </button>
            ))}
          </div>
          {mode === "debate" ? (
            <div className="grid flex-1 grid-cols-2 gap-2">
              {(
                [
                  ["proposerId", t("debate_proposer")],
                  ["skepticId", t("debate_skeptic")],
                  ["synthesizerId", t("debate_synthesizer")],
                  ["judgeId", t("debate_judge")],
                ] as const
              ).map(([key, label]) => (
                <label key={key} className="flex items-center gap-1">
                  <span className="w-12 shrink-0 text-neutral-500">{label}</span>
                  <select
                    className="min-w-0 flex-1 rounded border border-neutral-300 px-1.5 py-0.5 text-sm"
                    value={roles[key]}
                    onChange={(e) => setRoles({ ...roles, [key]: e.target.value })}
                  >
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {agentLabel(a)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-neutral-500">{t("order_hint")}</div>
              <ul ref={listRef} className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {items.map((item) => {
                  const a = agentOf(item.id);
                  if (!a) return null;
                  const position = item.enabled ? speakingOrder.indexOf(item.id) + 1 : null;
                  return (
                    <li
                      key={item.id}
                      data-order-id={item.id}
                      className={`flex items-center gap-2 rounded border bg-white px-2 py-1 ${
                        dragId === item.id ? "border-neutral-400 opacity-60" : "border-neutral-200"
                      } ${item.enabled ? "" : "text-neutral-400"}`}
                    >
                      <span
                        className="cursor-grab touch-none select-none px-1 text-neutral-400 active:cursor-grabbing"
                        onPointerDown={(e) => {
                          e.preventDefault();
                          e.currentTarget.setPointerCapture(e.pointerId);
                          setDragId(item.id);
                        }}
                        onPointerMove={(e) => moveDragOver(e.clientY)}
                        onPointerUp={() => setDragId(null)}
                        onPointerCancel={() => setDragId(null)}
                      >
                        ⠿
                      </span>
                      <input type="checkbox" checked={item.enabled} onChange={() => toggle(item.id)} />
                      <span className="w-5 text-xs text-neutral-400">{position ? `${position}.` : "—"}</span>
                      <span className="min-w-0 flex-1 truncate">{a.nickname}</span>
                      <span className="shrink-0 text-xs text-neutral-400">{a.modelId}</span>
                    </li>
                  );
                })}
              </ul>
              {speakingOrder.length === 0 && <p className="mt-1 text-xs text-red-600">{t("order_need_one")}</p>}
            </div>
          )}
          <div className="flex shrink-0 flex-col gap-2">
            <label className="flex items-center justify-between gap-1">
              <span className="text-neutral-500">{t("rounds")}</span>
              <input
                type="number"
                min={1}
                max={20}
                className="w-14 rounded border border-neutral-300 px-1.5 py-0.5 text-sm"
                value={maxRounds}
                onChange={(e) => setMaxRounds(Number(e.target.value))}
              />
            </label>
            {mode === "round_robin" && (
              <label className="flex items-center justify-between gap-1">
                <span className="text-neutral-500">{t("summarizer")}</span>
                <select
                  className="rounded border border-neutral-300 px-1.5 py-0.5 text-sm"
                  value={summarizerId}
                  onChange={(e) => setSummarizerId(e.target.value)}
                >
                  {agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {agentLabel(a)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      )}
      <ResizableComposer configured={showConfig} label={t("composer_resize")}>
        <button
          type="button"
          className={`pixel-composer-tool shrink-0 ${showConfig ? "is-active" : ""}`}
          title={t("config_tooltip")}
          aria-label={t("config_tooltip")}
          aria-pressed={showConfig}
          onClick={() => setShowConfig((v) => !v)}
        >
          <PixelIcon name="gear" size={18} />
        </button>
        <span className="pixel-composer-chevron mb-1.5 shrink-0">›</span>
        <ComposerTextarea
          placeholder={
            busy
              ? t("task_running")
              : mode === "debate"
                ? t("debate_placeholder", { m: maxRounds })
                : t("rr_placeholder", { n: speakingOrder.length, m: maxRounds })
          }
          value={prompt}
          disabled={busy}
          onChange={setPrompt}
          onSubmit={() => void doSubmit()}
        />
        <button
          className="pixel-send shrink-0"
          title={mode === "debate" ? t("start_debate") : t("start_discussion")}
          aria-label={mode === "debate" ? t("start_debate") : t("start_discussion")}
          disabled={busy || !prompt.trim() || (mode === "round_robin" && speakingOrder.length === 0)}
          type="submit"
        >
          <PixelIcon name="send" size={18} />
        </button>
      </ResizableComposer>
    </form>
  );
}

function SimpleComposer() {
  const { streaming, roomSending, sendMessage } = useStorePick("streaming", "roomSending", "sendMessage");
  const t = useT();
  const [draft, setDraft] = useState("");
  const doSubmit = async () => {
    const content = draft.trim();
    if (!content || streaming || roomSending) return;
    setDraft("");
    await sendMessage(content);
  };
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void doSubmit();
      }}
      className="composer-dock"
    >
      <ResizableComposer label={t("composer_resize")}>
        <span className="pixel-composer-chevron mb-1.5 shrink-0">›</span>
        <ComposerTextarea
          placeholder={streaming || roomSending ? t("replying") : t("message_placeholder")}
          value={draft}
          disabled={!!streaming || roomSending}
          onChange={setDraft}
          onSubmit={() => void doSubmit()}
        />
        <button
          className="pixel-send shrink-0"
          title={t("send")}
          aria-label={t("send")}
          disabled={!!streaming || roomSending || !draft.trim()}
          type="submit"
        >
          <PixelIcon name="send" size={18} />
        </button>
      </ResizableComposer>
    </form>
  );
}

function SingleAgentSession({ chrome }: { chrome: RoomChromeControls }) {
  const {
    sessions, currentSessionId, sessionMessages, agentEvents, agentStreamText, pendingApprovals,
    agentRunning, activeAgentRunId, agentError, agentCapabilities, sendAgentPrompt, updateApprovalPolicy, decideAgentApproval, cancelAgentRun, rewindSessionTo, workspacePathResults, searchWorkspacePaths, addWorkspaceRef, workspaces,
  } = useStorePick("sessions", "currentSessionId", "sessionMessages", "agentEvents", "agentStreamText", "pendingApprovals", "agentRunning", "activeAgentRunId", "agentError", "agentCapabilities", "sendAgentPrompt", "updateApprovalPolicy", "decideAgentApproval", "cancelAgentRun", "rewindSessionTo", "workspacePathResults", "searchWorkspacePaths", "addWorkspaceRef", "workspaces");
  // 窗口化：长会话只渲染最近 N 条，更早的可展开
  const [sessionLimit, setSessionLimit] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setSessionLimit(DEFAULT_WINDOW_SIZE), [currentSessionId]);
  const sessionWindow = windowTail(sessionMessages, sessionLimit);
  const t = useT();
  const [draft, setDraft] = useState("");
  const [showCollab, setShowCollab] = useState(false);
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
  const strategyStatus = `${t(`strategy_${strategy}`)} · ${t(status)}`;
  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || agentRunning) return;
    // Local echo and an empty composer are committed before the network request
    // starts.  Waiting for the stream here made an Enter press look stuck.
    setDraft("");
    void sendAgentPrompt(prompt);
  };
  const updateDraft = (value: string) => {
    setDraft(value);
    const match = /(?:^|\s)@([^\s]*)$/u.exec(value);
    if (match) void searchWorkspacePaths(match[1]);
  };
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
          <WorkspaceDockButtons mode={chrome.dockMode} onSelect={chrome.onSelectDock} />
          {session && <button className="pixel-button pixel-toolbar-icon-action" onClick={() => setShowCollab(true)} title={t("cowork_settings_title")} aria-label={t("cowork_settings_title")}><PixelIcon name="gear" size={16} /></button>}
          {agentRunning && <button className="pixel-button px-2 py-1 text-xs text-red-700" onClick={() => void cancelAgentRun()}>{t("cancel_task")}</button>}
        </div>
      </WindowRoomToolbar>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
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
          return (
            <Fragment key={message.id}>
              {messageReasoning.length > 0 && <PublicReasoningPanel summaries={messageReasoning} running={messageReasoning.some((summary) => summary.running)} />}
              <div className={`anim-msg group flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
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
        {agentRunning && streamingText && <div className="pixel-card max-w-[78%] whitespace-pre-wrap bg-white p-3 text-sm">{streamingText}</div>}
      </div>
      <form className="composer-dock" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {agentError && (
          <div role="alert" className="pixel-card mb-2 border-red-400 bg-red-50 px-3 py-2 text-xs text-red-800">
            <div className="font-bold">{t("agent_run_failed")}</div>
            <div className="mt-1">{t(agentRunErrorKey(agentError))}</div>
          </div>
        )}
        <ApprovalShelf
          approvals={pendingApprovals}
          activities={toolActivities}
          workspaceLabel={workspaceLabel}
          busy={false}
          onDecision={decideAgentApproval}
        />
        {workspacePathResults.length > 0 && (
          <div className="pixel-card mb-2 max-h-48 overflow-y-auto p-2">
            {workspacePathResults.filter((result) => result.kind === "file").slice(0, 12).map((result) => (
              <button key={result.relativePath} type="button" className="block w-full px-2 py-1 text-left text-xs hover:bg-neutral-100" onClick={() => {
                void addWorkspaceRef(result.relativePath);
                setDraft((current) => current.replace(/@[^\s]*$/u, `@${result.relativePath} `));
              }}>@{result.relativePath}</button>
            ))}
          </div>
        )}
        <AttachmentTray />
        <ResizableComposer label={t("composer_resize")}>
          <span className="pixel-composer-chevron mb-1.5 shrink-0">›</span>
          <ComposerTextarea placeholder={agentRunning ? t("replying") : t("message_placeholder")} value={draft} disabled={agentRunning} onChange={updateDraft} onSubmit={() => void submit()} />
          <button className="pixel-send shrink-0" type="submit" disabled={agentRunning || !draft.trim()} aria-label={t("send")}><PixelIcon name="send" size={18} /></button>
        </ResizableComposer>
        {session && (
          <label className="mt-2 flex items-center gap-2 px-1 text-[11px] text-neutral-600">
            <span>{t("approval_policy_label")}</span>
            <select
              className="pixel-input min-w-44 px-2 py-1 text-xs"
              value={session.approvalPolicy.mode}
              title={t(`approval_mode_${session.approvalPolicy.mode}_description`)}
              onChange={(event) => void updateApprovalPolicy(session.id, event.target.value as ToolApprovalMode)}
            >
              {approvalOptions.map(({ mode, supported, labelKey }) => (
                <option
                  key={mode}
                  value={mode}
                  disabled={!supported}
                >
                  {t(labelKey)}
                </option>
              ))}
            </select>
            <span className="truncate" title={t(`approval_mode_${session.approvalPolicy.mode}_description`)}>
              {t(`approval_mode_${session.approvalPolicy.mode}_description`)}
            </span>
          </label>
        )}
      </form>
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
            {step.verification.length > 0 && <p className="mt-1 text-xs text-green-700">✓ {step.verification.join(" · ")}</p>}
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
    sessions, currentSessionId, sessionMessages, currentMultiTask, multiRunning, multiError, multiStreamAgentId, multiStreamText,
    sendMultiTask, loadMultiTask, decideMultiApproval, cancelMultiTask, pauseMultiTask, resumeMultiTask, retryMultiTask, rewindSessionTo,
  } = useStorePick("sessions", "currentSessionId", "sessionMessages", "currentMultiTask", "multiRunning", "multiError", "multiStreamAgentId", "multiStreamText", "sendMultiTask", "loadMultiTask", "decideMultiApproval", "cancelMultiTask", "pauseMultiTask", "resumeMultiTask", "retryMultiTask", "rewindSessionTo");
  // 窗口化：长会话只渲染最近 N 条，更早的可展开
  const [sessionLimit, setSessionLimit] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setSessionLimit(DEFAULT_WINDOW_SIZE), [currentSessionId]);
  const sessionWindow = windowTail(sessionMessages, sessionLimit);
  const t = useT();
  const session = sessions.find((item) => item.id === currentSessionId);
  const participants: Array<{ id: string; nickname?: unknown; avatar?: unknown; modelId?: unknown; [key: string]: unknown }> = session?.agents.map((item) => ({ id: item.agentId, ...item.snapshot })) ?? [];
  const [prompt, setPrompt] = useState("");
  const [showCollab, setShowCollab] = useState(false);
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
    multiError ? "failed" : multiRunning && !currentMultiTask ? "preparing" : currentMultiTask?.state ?? null,
  );
  const strategyStatus = `${t(`strategy_${strategy}`)} · ${t(status)}`;
  return <div className="flex min-h-0 flex-1 flex-col">
    <WindowRoomToolbar title={session?.title ?? "Socrates"} subtitle={strategyStatus} sidebarHidden={chrome.sidebarHidden} toolbarMode={chrome.toolbarMode} collapseLabel={t("sidebar_collapse")} expandLabel={t("sidebar_expand")} onToggleSidebar={chrome.onToggleSidebar}>
      <div className="pixel-window-toolbar__room-actions"><WorkspaceDockButtons mode={chrome.dockMode} onSelect={chrome.onSelectDock} />{session && canEditCollaboration(currentMultiTask?.state) && <button className="pixel-button pixel-toolbar-icon-action" onClick={() => setShowCollab(true)} title={t("cowork_settings_title")} aria-label={t("cowork_settings_title")}><PixelIcon name="gear" size={16} /></button>}{currentMultiTask?.state === "paused" ? <button className="pixel-button pixel-toolbar-task-action pixel-button--primary px-2 py-1 text-xs" onClick={() => void (currentMultiTask.outcomeUnknown || currentMultiTask.requiresExecutionReview ? retryMultiTask() : resumeMultiTask())}>{t(currentMultiTask.outcomeUnknown || currentMultiTask.requiresExecutionReview ? "multi_retry_reviewed" : "multi_resume")}</button> : pausable && <button className="pixel-button pixel-toolbar-task-action px-2 py-1 text-xs" onClick={() => void pauseMultiTask()}>{t("multi_pause")}</button>}{currentMultiTask && !terminal && <button className="pixel-button pixel-toolbar-task-action px-2 py-1 text-xs text-red-700" onClick={() => void cancelMultiTask()}>{t("cancel_task")}</button>}</div>
    </WindowRoomToolbar>
    <div className="flex-1 space-y-4 overflow-y-auto p-4">
      {multiError && <div role="alert" className="border border-red-300 bg-red-50 p-3 text-xs text-red-700">{multiError}</div>}
      {/* 执行是脱离 SSE 的后台任务，失败原因不会走 task_failed 事件——直接读 terminalReason 展示 */}
      {!multiError && currentMultiTask?.state === "failed" && currentMultiTask.terminalReason && (
        <div role="alert" className="border border-red-300 bg-red-50 p-3 text-xs text-red-700">{t("multi_failed_reason", { reason: currentMultiTask.terminalReason })}</div>
      )}
      {currentMultiTask?.state === "paused" && currentMultiTask.outcomeUnknown && <div role="alert" className="border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900">{t("multi_outcome_unknown")}</div>}
      {currentMultiTask?.state === "paused" && currentMultiTask.requiresExecutionReview && <div role="alert" className="border border-amber-400 bg-amber-50 p-3 text-xs text-amber-900">{t("multi_execution_review")}</div>}
      {sessionWindow.hiddenCount > 0 && (
          <button className="pixel-button mx-auto block px-3 py-1 text-xs" onClick={() => setSessionLimit((limit) => expandWindow(limit, sessionMessages.length))}>
            {t("show_earlier", { n: sessionWindow.hiddenCount })}
          </button>
        )}
        {sessionWindow.visible.map((message) => {
        const author = participants.find((item) => item.id === message.authorId);
        return <div key={message.id} className={`anim-msg group flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}><div className={`max-w-[82%] ${message.role === "user" ? "" : "flex gap-3"}`}>
          {message.role !== "user" && <AgentAvatar src={String(author?.avatar ?? "")} label={String(author?.nickname ?? "Agent")} size={34} />}
          <div className={`md-body pixel-card p-3 text-sm ${message.role === "user" ? "bg-violet-50" : "bg-white"}`}><Markdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>{message.content}</Markdown></div>
        </div><MsgActions m={message} align={message.role === "user" ? "right" : "left"} busy={multiRunning} onRewind={(messageId) => void rewindSessionTo(messageId)} /></div>;
      })}
      {currentMultiTask?.turns.filter((turn) => turn.status === "running").map((turn) => {
        const live = multiStreamAgentId === turn.agentId ? multiStreamText : "";
        return (
          <div key={turn.id} className={`pixel-card p-3 text-sm ${live ? "" : "animate-pulse"}`}>
            <div className="mb-1 text-xs text-neutral-500">{String(turn.snapshot.nickname ?? turn.agentId)} {live ? "" : t("multi_thinking")}</div>
            {live && <div className="md-body whitespace-pre-wrap">{live}<span className="animate-pulse">▋</span></div>}
          </div>
        );
      })}
      {currentMultiTask?.plan && <MultiPlanCard plan={currentMultiTask.plan} />}
      {currentMultiTask?.pendingApprovals.map((approval) => <section key={approval.id} className="pixel-approval-card p-4">
        <div className="flex items-center justify-between"><strong>{approval.kind}</strong><span className="pixel-chip">{approval.risk}</span></div>
        <p className="my-2 text-xs text-neutral-600">{approval.kind === "plan_scope_expansion" ? t("multi_scope_expansion") : t("multi_tool_approval_hint")}</p>
        <div className="flex gap-2"><button className="pixel-button pixel-button--primary px-3 py-1.5 text-xs" onClick={() => void decideMultiApproval(approval.id, "allow_once")}>{t("approval_allow_once")}</button>{!approval.freshHumanRequired && <button className="pixel-button px-3 py-1.5 text-xs" onClick={() => void decideMultiApproval(approval.id, "allow_session")}>{t("approval_allow_session")}</button>}<button className="pixel-button px-3 py-1.5 text-xs text-red-700" onClick={() => void decideMultiApproval(approval.id, "deny")}>{t("approval_deny")}</button></div>
      </section>)}
      {terminal && <RoomTaskComposer
        prompt={prompt}
        summary={strategyStatus}
        running={multiRunning}
        title={t("multi_new_task")}
        settingsLabel={t("cowork_settings_title")}
        promptLabel={t("task_prompt_label")}
        placeholder={t("multi_prompt_placeholder")}
        startLabel={t("multi_start")}
        runningLabel={t("multi_discussing")}
        onPromptChange={setPrompt}
        onOpenSettings={() => setShowCollab(true)}
        onSubmit={() => void sendMultiTask(prompt)}
      />}
    </div>
    {showCollab && session && <CoworkRoomSettingsDialog session={session} onClose={() => setShowCollab(false)} />}
  </div>;
}

function NewRoomDialog({ onClose, presetWorkspaceId }: { onClose: () => void; presetWorkspaceId?: string | null }) {
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
      if (event.key === "Escape") dialog.close();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [dialog]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const workspaceSelection = await prepareNewRoomWorkspace({
        mode: workspaceMode,
        workspaceId,
        pickAndRegisterWorkspace,
      });
      if (!workspaceSelection) return;
      await createRoomFromDraft({
        title: roomTitleOrFallback(name, t("room_untitled")),
        agentIds: selected,
        primaryAgentId,
        workspaceSelection,
      });
      dialog.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
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
            <p className="mt-1 text-sm text-neutral-500">{t("new_room_subtitle")}</p>
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

        <div className="mt-5">
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
        </div>

        <div className="mb-2 mt-5 flex items-center justify-between">
          <h3 className="text-sm font-bold">{t("choose_agents")}</h3>
          <span className="pixel-chip">{t("selected_agents", { n: selected.length })}</span>
        </div>
        {agents.length === 0 ? (
          <div className="pixel-empty p-6 text-center text-sm text-neutral-500">{t("create_agent_first")}</div>
        ) : (
          <div className="grid max-h-[42vh] grid-cols-2 gap-3 overflow-y-auto p-1 sm:grid-cols-3">
            {agents.map((agent) => {
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
              disabled={roomDraftBlocker({
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
    </div>
  );
}

/** Side-bar entities all share the same predictable rename/archive/remove menu. */
type SidebarEntityKind = "room" | "session" | "workspace";
/** 侧栏统一行：rooms 与 sessions 折算成同一形状，source 决定打开哪条路径 */
type SidebarEntry = SidebarRoom & { source: "room" | "session" };
type MenuState = { kind: SidebarEntityKind; id: string; x: number; y: number };
type RenameTarget = { kind: SidebarEntityKind; id: string; value: string };

function SidebarEntityMenu({
  menu,
  onClose,
  onRename,
  onCollab,
  onError,
}: {
  menu: MenuState;
  onClose: () => void;
  onRename: (target: RenameTarget) => void;
  onCollab: (sessionId: string) => void;
  onError: (message: string) => void;
}) {
  const {
    rooms, sessions, workspaces,
    archiveRoom, removeRoom, archiveSession, removeSession, archiveWorkspace, removeWorkspace,
  } = useStorePick("rooms", "sessions", "workspaces", "archiveRoom", "removeRoom", "archiveSession", "removeSession", "archiveWorkspace", "removeWorkspace");
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const entity = menu.kind === "room"
    ? rooms.find((room) => room.id === menu.id)
    : menu.kind === "session"
      ? sessions.find((session) => session.id === menu.id)
      : workspaces.find((workspace) => workspace.id === menu.id);

  useEffect(() => {
    const closeOnPointerDown = (event: PointerEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      onClose();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    // The trigger is a click. Closing on window click made a newly mounted menu
    // consume that very same event and disappear before it could be seen.
    window.addEventListener("pointerdown", closeOnPointerDown);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOnPointerDown);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  if (!entity) return null;
  const value = "name" in entity ? entity.name : "title" in entity ? entity.title : entity.label;
  const archived = entity.archived;
  const managedSessionWorkspace = menu.kind === "session" && "workspaceId" in entity
    ? workspaces.find((workspace) => (
      workspace.id === entity.workspaceId && isOwnedManagedWorkspace(workspace, entity.id)
    ))
    : null;
  const revealTarget = resolveSidebarRevealPath(menu, sessions, workspaces);
  const item = "block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100";
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
      onClose();
    } catch (error) {
      onError(error instanceof Error && error.message === "workspace_not_found"
        ? t("reveal_workspace_missing")
        : error instanceof Error ? error.message : String(error));
      onClose();
    }
  };
  return (
    <div
      ref={menuRef}
      className="pixel-card anim-panel fixed z-[90] w-48 overflow-hidden py-1"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className={item}
        onClick={() => {
          onRename({ kind: menu.kind, id: menu.id, value });
          onClose();
        }}
      >
        {t("rename")}
      </button>
      {revealTarget && (
        <button
          className={item}
          onClick={() => void run(() => revealResolvedSidebarTarget(revealTarget))}
        >
          {t("reveal_in_finder")}
        </button>
      )}
      {menu.kind === "session" && "kind" in entity && entity.kind === "cowork" && (
        <button
          className={item}
          onClick={() => {
            onCollab(menu.id);
            onClose();
          }}
        >
          {t("cowork_settings_title")}
        </button>
      )}
      <button
        className={item}
        onClick={() => {
          sfx.delete();
          void run(() => menu.kind === "room"
            ? archiveRoom(menu.id, !archived)
            : menu.kind === "session"
              ? archiveSession(menu.id, !archived)
              : archiveWorkspace(menu.id, !archived));
        }}
      >
        {archived ? t("unarchive") : t("archive")}
      </button>
      {confirming && managedSessionWorkspace ? (
        <>
          <div className="px-3 py-2 text-xs text-neutral-600">{t("managed_workspace_delete_prompt")}</div>
          <button className={`${item} text-red-700`} onClick={() => {
            sfx.delete();
            void run(() => removeSession(menu.id, "keep"));
          }}>{t("delete_room_keep_files")}</button>
          <button className={`${item} font-medium text-red-700`} onClick={() => {
            sfx.delete();
            void run(() => removeSession(menu.id, "delete"));
          }}>{t("delete_room_and_files")}</button>
        </>
      ) : (
        <button
          className={`${item} ${confirming ? "font-medium text-red-700" : "text-red-600"}`}
          onClick={() => {
            if (!confirming) {
              setConfirming(true);
              return;
            }
            sfx.delete();
            void run(() => menu.kind === "room"
              ? removeRoom(menu.id)
              : menu.kind === "session"
                ? removeSession(menu.id)
                : removeWorkspace(menu.id));
          }}
        >
          {confirming ? t("confirm_delete") : menu.kind === "workspace" ? t("remove_from_socrates") : t("delete")}
        </button>
      )}
    </div>
  );
}

function RenameDialog({ target, onClose }: { target: RenameTarget; onClose: () => void }) {
  const { renameRoom, renameSession, renameWorkspace } = useStorePick("renameRoom", "renameSession", "renameWorkspace");
  const t = useT();
  const dialog = useAnimatedDialogClose(onClose);
  const [value, setValue] = useState(target.value);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    try {
      const next = value.trim();
      if (!next) throw new Error("name_required");
      if (target.kind === "room") await renameRoom(target.id, next);
      else if (target.kind === "session") await renameSession(target.id, next);
      else await renameWorkspace(target.id, next);
      dialog.close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <form className="pixel-dialog w-[min(440px,calc(100vw-40px))] p-5" role="dialog" aria-modal="true" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between gap-3">
          <div><div className="pixel-kicker">RENAME</div><h2 className="text-lg font-bold">{t(`rename_${target.kind}`)}</h2></div>
          <button className="pixel-button h-8 w-8" type="button" aria-label={t("close")} onClick={dialog.close}>×</button>
        </div>
        <input autoFocus className="pixel-input w-full px-3 py-2 text-sm" value={value} maxLength={80} onChange={(event) => { setValue(event.target.value); setError(null); }} />
        {error && <p className="mt-2 text-xs text-red-700">{error}</p>}
        <div className="mt-5 flex justify-end gap-2"><button className="pixel-button px-3 py-2 text-sm" type="button" onClick={dialog.close}>{t("cancel")}</button><button className="pixel-button pixel-button--primary px-4 py-2 text-sm" disabled={!value.trim()}>{t("save")}</button></div>
      </form>
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
 * Co-work 房间协作设置（C5）。
 *
 * 只把**运行时真实生效**的项做成开关：Boss 统筹（Boss 整合计划、默认不执行）与
 * 审批方式（人工 / 执行者自检 / 指定审核者，后两者会真跑一次审核 Agent）。
 * 讨论与监督暂未接入运行时，显式标注「尚未接入」而不是造假开关。
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
  const [draft, setDraft] = useState<RoomCollaborationSettings>(() => normalizeCollaborationSettings(session.collaboration));
  const [primaryAgentId, setPrimaryAgentId] = useState(session.primaryAgentId);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const memberIds = session.agents.map((agent) => agent.agentId);
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.nickname ?? id;
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
  const strategyOptions = collaborationStrategyOptions(agentCapabilities?.collaboration);

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
    .filter((member) => member.executionEligible)
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
            <span>{t("pre_execution_discussion")}</span>
            <input
              type="checkbox"
              disabled={!discussionAvailable}
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
                    <option value="debate">{t("discussion_mode_debate")}</option>
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

        {error && <p className="mt-3 text-sm text-red-700">{t(error)}</p>}
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
  const { agents, addSessionAgent, removeSessionAgent } = useStorePick("agents", "addSessionAgent", "removeSessionAgent");
  const t = useT();
  const dialog = useAnimatedDialogClose(onClose);
  const [error, setError] = useState<string | null>(null);
  const memberIds = session.agents.map((agent) => agent.agentId);
  const members = memberIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => !!agent);
  const available = agents.filter((agent) => !memberIds.includes(agent.id));
  const busy = !["idle", "completed", "failed", "cancelled", "interrupted"].includes(session.status);
  const run = (op: () => Promise<void>) => op().catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));

  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <section className="pixel-dialog max-h-[calc(100vh-40px)] w-[min(560px,calc(100vw-48px))] overflow-y-auto p-5" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="pixel-kicker">ROOM ROSTER</div>
            <h3 className="text-lg font-bold">{t("room_members_title")}</h3>
            <p className="mt-1 text-xs text-neutral-500">{session.title}</p>
          </div>
          <button className="pixel-button h-8 w-8" aria-label={t("close")} onClick={() => { sfx.close(); dialog.close(); }}>×</button>
        </div>
        {busy && <p className="mb-3 text-xs text-amber-700">{t("active_session_members_locked")}</p>}
        <div className="space-y-2">
          {members.map((agent) => (
            <div key={agent.id} className="flex items-center gap-3 border-b border-neutral-200 py-2 last:border-0">
              <AgentAvatar src={agent.avatar} label={agent.nickname} size={42} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-bold">{agentLabel(agent)}</div>
                <div className="truncate text-xs text-neutral-500">{agent.role || agent.modelId}</div>
              </div>
              <button
                className="pixel-button px-3 py-1.5 text-xs text-red-700 disabled:opacity-40"
                disabled={busy || members.length <= 1}
                title={members.length <= 1 ? t("session_requires_at_least_one_member") : t("remove_member")}
                onClick={() => void run(() => removeSessionAgent(session.id, agent.id))}
              >
                {t("remove_member")}
              </button>
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
                <button
                  className="pixel-button pixel-button--primary px-3 py-1.5 text-xs disabled:opacity-40"
                  disabled={busy}
                  onClick={() => void run(() => addSessionAgent(session.id, agent.id))}
                >
                  + {t("add_to_room")}
                </button>
              </div>
            ))}
          </div>
        )}
        {error && <p className="mt-3 text-sm text-red-700">{t(error)}</p>}
      </section>
    </div>
  );
}

export default function ChatPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { rooms, agents, sessions, workspaces, activeWorkspace, currentRoomId, currentSessionId, config, updateConfig, messages, streaming, activeTaskId, rewindTo, chatError, tasks, usageSummaries, selectRoom, selectAgentSession, setActiveWorkspace, clearChatError, handshake } =
    useStorePick("rooms", "agents", "sessions", "workspaces", "activeWorkspace", "currentRoomId", "currentSessionId", "config", "updateConfig", "messages", "streaming", "activeTaskId", "rewindTo", "chatError", "tasks", "usageSummaries", "selectRoom", "selectAgentSession", "setActiveWorkspace", "clearChatError", "handshake");
  const bubbleBusy = !!streaming || !!activeTaskId;
  const t = useT();
  const [creating, setCreating] = useState<false | { presetWorkspaceId: string | null }>(false);
  const [showTasks, setShowTasks] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [collabSessionId, setCollabSessionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [foldedGroups, setFoldedGroups] = useState<string[]>([]);
  const [dockMode, setDockMode] = useState<WorkspaceDockMode>("overview");
  const currentRoom = rooms.find((room) => room.id === currentRoomId);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const boundWorkspaceId = currentSession?.workspaceId ?? null;
  const activeSessionWorkspaceId = workspaces.some((workspace) => workspace.id === boundWorkspaceId && !workspace.archived) ? boundWorkspaceId : null;
  const activeConversationId = currentSessionId ?? currentRoomId;
  useEffect(() => setDockMode(activeConversationId ? "overview" : "closed"), [activeConversationId]);
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

  // 侧栏统一视图：历史 rooms 与 workspace sessions 折算成同一种行，
  // source 决定点击走 selectRoom 还是 selectAgentSession。
  const entries = useMemo<SidebarEntry[]>(() => [
    ...rooms.map((room) => ({ id: room.id, name: room.name, kind: "chat" as const, workspaceId: null, archived: room.archived, source: "room" as const })),
    ...sessions.map((session) => ({ id: session.id, name: session.title, kind: session.kind, workspaceId: session.workspaceId, archived: session.archived, source: "session" as const })),
  ], [rooms, sessions]);

  const memberNamesByRoom = useMemo(() => {
    const named = (ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)?.nickname ?? "");
    return Object.fromEntries([
      ...rooms.map((room) => [room.id, named(room.agentIds)] as const),
      ...sessions.map((session) => [session.id, named(session.agents.map((agent) => agent.agentId))] as const),
    ]);
  }, [rooms, sessions, agents]);

  const openEntry = (entry: SidebarEntry) =>
    void (entry.source === "room" ? selectRoom(entry.id) : selectAgentSession(entry.id));

  const searchHits = searchSidebar(query, {
    rooms: entries,
    workspaces: workspaces.map((workspace) => ({ ...workspace, path: workspace.canonicalPath })),
    memberNamesByRoom,
  });
  const topLevelEntries = useMemo(() => topLevelRooms(entries, workspaces) as SidebarEntry[], [entries, workspaces]);
  const projectGroups = useMemo(() => workspaceGroups(entries, workspaces), [entries, workspaces]);

  const archivedRooms = rooms.filter((r) => r.archived);
  const archivedSessions = sessions.filter((session) => session.archived);
  const archivedWorkspaces = workspaces.filter((workspace) => workspace.archived);

  const entryRow = (entry: SidebarEntry) => {
    const active = entry.id === (entry.source === "room" ? currentRoomId : currentSessionId);
    const menuKind: SidebarEntityKind = entry.source;
    return (
      <div
        key={`${entry.source}-${entry.id}`}
        className={`pixel-room-row group flex cursor-pointer items-center gap-2 px-2 py-2 text-sm ${active ? "is-active" : ""} ${entry.archived ? "opacity-60" : ""}`}
        onClick={() => openEntry(entry)}
        title={collapsed ? entry.name : undefined}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ kind: menuKind, id: entry.id, x: event.clientX, y: event.clientY });
        }}
      >
        <PixelIcon name="robot" size={18} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1 truncate font-medium">{entry.name}</span>
            <button
              title={t("room_menu")}
              className={`pixel-room-more shrink-0 px-1 text-sm opacity-0 group-hover:opacity-100 ${menu?.id === entry.id ? "opacity-100" : ""}`}
              onClick={(event) => {
                event.stopPropagation();
                const rect = event.currentTarget.getBoundingClientRect();
                setMenu({ kind: menuKind, id: entry.id, x: rect.right - 176, y: rect.bottom + 4 });
              }}
            >
              ⋯
            </button>
          </>
        )}
      </div>
    );
  };

  // 从工作区分组的「＋」建房：直接锁定该工作区，不再走全局 activeWorkspace、不让重选
  const createInWorkspace = (workspaceId: string) => setCreating({ presetWorkspaceId: workspaceId });

  /** 工作区分组；展开与选中互不影响（展开状态由 foldedGroups 单独持有）。 */
  const workspaceGroup = (group: { workspace: WorkspaceRecord; rooms: SidebarRoom[] }) => {
    const { workspace } = group;
    const folded = foldedGroups.includes(workspace.id);
    return (
      <section key={workspace.id} className={`pixel-project-group ${activeWorkspace?.id === workspace.id ? "is-current" : ""}`}>
        <div className="pixel-project-heading group flex items-center gap-1 px-1 py-1.5">
          <button
            className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs font-bold"
            title={workspace.canonicalPath}
            aria-expanded={!folded}
            onClick={() => setFoldedGroups((current) => current.includes(workspace.id) ? current.filter((id) => id !== workspace.id) : [...current, workspace.id])}
          >
            <PixelIcon name="folder" size={18} />
            {!collapsed && (
              <>
                <span className="truncate">{workspace.label}</span>
                {group.rooms.length > 0 && <span className="text-[10px] font-normal text-neutral-400">{group.rooms.length}</span>}
              </>
            )}
          </button>
          {!collapsed && <button className="pixel-project-action" title={t("new_room")} aria-label={t("new_room")} onClick={() => createInWorkspace(workspace.id)}><PixelIcon name="plus" size={15} /></button>}
          {!collapsed && <button className="pixel-project-action" title={t("room_menu")} aria-label={t("room_menu")} onClick={(event) => { event.stopPropagation(); const rect = event.currentTarget.getBoundingClientRect(); setMenu({ kind: "workspace", id: workspace.id, x: rect.right - 176, y: rect.bottom + 4 }); }}>⋯</button>}
        </div>
        {!folded && (
          <div className="space-y-1 px-1 pb-2">
            {(group.rooms as SidebarEntry[]).map(entryRow)}
            {group.rooms.length === 0 && !collapsed && <p className="px-2 py-1 text-[10px] text-neutral-400">{t("project_empty")}</p>}
          </div>
        )}
      </section>
    );
  };

  const jumpToTask = (taskId: string) => {
    document.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  // A smooth scroll for every token queues animations in WKWebView and makes
  // Enter feel delayed. New turns ease in once; streaming follows immediately.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages.length]);
  useEffect(() => {
    if (streaming?.text) bottomRef.current?.scrollIntoView({ behavior: "auto", block: "end" });
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
    }));
    return roomAgents.map((agent) => ({
      id: agent.id,
      nickname: agent.nickname,
      avatar: agent.avatar,
      modelId: agent.modelId,
      role: agent.role,
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

  return (
    <div className="flex h-[100dvh]" style={{ "--room-sidebar-width": `${config?.sidebar.width ?? 256}px` } as React.CSSProperties}>
      <aside
        className={`pixel-room-sidebar flex shrink-0 flex-col p-3 ${collapsed ? "is-hidden" : ""}`}
        aria-hidden={collapsed}
        inert={collapsed ? true : undefined}
      >
        <div className="pixel-sidebar-brand" data-tauri-drag-region>
          <span>Socrates</span>
        </div>
        <button
          className="pixel-new-room-button flex min-w-0 items-center justify-center gap-2 px-3 py-2.5 text-sm font-bold"
          onClick={() => setCreating({ presetWorkspaceId: null })}
        >
          <PixelIcon name="plus" size={20} />
          {t("new_room")}
        </button>

        {!collapsed && (
          <input
            type="search"
            className="pixel-input mt-3 w-full px-2 py-1.5 text-xs"
            placeholder={t("sidebar_search_placeholder")}
            aria-label={t("sidebar_search_placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {sidebarError && <div role="alert" className="mt-2 border border-red-300 bg-red-50 px-2 py-1 text-[10px] text-red-700">{sidebarError}</div>}

        <div className="pixel-room-list mt-3 flex-1 overflow-y-auto pr-1">
          {query.trim() ? (
            searchHits.length === 0 ? (
              <p className="px-2 py-1 text-[10px] text-neutral-400">{t("sidebar_search_empty")}</p>
            ) : (
              <div className="space-y-1 px-1">
                {searchHits.map((hit) =>
                  hit.kind === "room" ? (
                    entryRow(hit.room as SidebarEntry)
                  ) : (
                    <button
                      key={`ws-${hit.workspaceId}`}
                      className="pixel-room-row flex w-full items-center gap-2 px-2 py-2 text-left text-sm"
                      onClick={() => void setActiveWorkspace(hit.workspaceId).catch((error: unknown) => setSidebarError(error instanceof Error ? error.message : String(error)))}
                    >
                      <PixelIcon name="folder" size={18} />
                      <span className="truncate">{hit.label}</span>
                    </button>
                  ),
                )}
              </div>
            )
          ) : (
            <div className="space-y-2">
              {topLevelEntries.length > 0 && (
                <div className="space-y-1 px-1">
                  {topLevelEntries.map(entryRow)}
                </div>
              )}
              {projectGroups.map((group) => workspaceGroup({
                ...group,
                workspace: workspaces.find((item) => item.id === group.workspace.id)!,
              }))}
              {topLevelEntries.length === 0 && projectGroups.length === 0 && (
                <p className="px-2 py-1 text-[10px] text-neutral-400">{t("project_empty")}</p>
              )}
            </div>
          )}
        </div>
        <div className="pixel-archive-dock mt-3 pt-3">
          {!collapsed && showArchived && archivedRooms.length + archivedSessions.length + archivedWorkspaces.length > 0 && (
            <div className="pixel-archive-panel mb-2 max-h-56 space-y-1 overflow-y-auto p-2">
              {(entries.filter((entry) => entry.archived) as SidebarEntry[]).map(entryRow)}
              {/* 归档的工作区自己成一行（可能没有房间）——否则它只加计数却不显示 */}
              {archivedWorkspaces.map((workspace) => (
                <div
                  key={`ws-${workspace.id}`}
                  className="pixel-room-row group flex items-center gap-2 px-2 py-2 text-sm opacity-60"
                  onContextMenu={(event) => {
                    event.preventDefault();
                    setMenu({ kind: "workspace", id: workspace.id, x: event.clientX, y: event.clientY });
                  }}
                >
                  <PixelIcon name="folder" size={18} />
                  <span className="min-w-0 flex-1 truncate font-medium">{workspace.label}</span>
                  <button
                    title={t("room_menu")}
                    className="pixel-room-more shrink-0 px-1 text-sm opacity-0 group-hover:opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ kind: "workspace", id: workspace.id, x: rect.right - 176, y: rect.bottom + 4 });
                    }}
                  >
                    ⋯
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            className="pixel-archive-button flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
            onClick={() => setShowArchived((v) => !v)}
            title={t("archived_section", { n: archivedRooms.length + archivedSessions.length + archivedWorkspaces.length })}
          >
            <PixelIcon name="archive" size={20} />
            {!collapsed && (
              <>
                <span className="min-w-0 flex-1">{t("archived_section", { n: archivedRooms.length + archivedSessions.length + archivedWorkspaces.length })}</span>
                <span>{showArchived ? "▾" : "▸"}</span>
              </>
            )}
          </button>
          {/* Settings 固定在左下角；打开的是 overlay，不改变当前房间导航状态 */}
          <button
            className="pixel-archive-button mt-2 flex w-full items-center gap-2 px-3 py-2 text-left text-xs"
            onClick={onOpenSettings}
            title={`${t("settings_title")} (⌘,)`}
          >
            <PixelIcon name="gear" size={20} />
            {!collapsed && <span className="min-w-0 flex-1">{t("settings_title")}</span>}
          </button>
        </div>
      </aside>
      {creating && <NewRoomDialog onClose={() => setCreating(false)} presetWorkspaceId={creating.presetWorkspaceId} />}
      {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />}
      {menu && <SidebarEntityMenu menu={menu} onClose={() => setMenu(null)} onRename={setRenameTarget} onCollab={setCollabSessionId} onError={setSidebarError} />}
      {collabSessionId && (() => {
        const target = sessions.find((session) => session.id === collabSessionId);
        return target ? <CoworkRoomSettingsDialog session={target} onClose={() => setCollabSessionId(null)} /> : null;
      })()}
      {showMembers && (currentSession
        ? <SessionMembersDialog session={currentSession} onClose={() => setShowMembers(false)} />
        : currentRoom ? <RoomMembersDialog roomId={currentRoom.id} memberIds={currentRoom.agentIds} onClose={() => setShowMembers(false)} /> : null)}

      <section className="pixel-room-content flex min-w-0 flex-1 flex-col">
        {currentSessionId ? (currentSession?.collaboration.strategy === "team" ? <MultiAgentSession chrome={chrome} /> : <SingleAgentSession chrome={chrome} />) : currentRoomId ? (
          <>
            <WindowRoomToolbar
              title={currentRoom?.name ?? "Socrates"}
              sidebarHidden={chrome.sidebarHidden}
              toolbarMode={chrome.toolbarMode}
              collapseLabel={t("sidebar_collapse")}
              expandLabel={t("sidebar_expand")}
              onToggleSidebar={chrome.onToggleSidebar}
            >
              <WorkspaceDockButtons mode={chrome.dockMode} onSelect={chrome.onSelectDock} />
            </WindowRoomToolbar>
            {showTasks && <TaskHistoryPanel onJump={jumpToTask} />}
            <div key={currentRoomId} className="anim-view flex-1 space-y-3 overflow-y-auto p-4">
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
            {roomAgents.length > 1 ? <TaskComposer agents={roomAgents} /> : <SimpleComposer />}
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
              <button className="pixel-button pixel-button--primary flex items-center gap-2 px-4 py-2 text-sm" onClick={() => setCreating({ presetWorkspaceId: null })}>
                <PixelIcon name="plus" size={16} />
                {t("new_room")}
              </button>
            </div>
          </>
        )}
      </section>
      {dockMode !== "closed" && activeConversationId && (
        <WorkspaceDock
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
        />
      )}
    </div>
  );
}
