import { memo, useEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useThrottledValue } from "./useThrottledValue";
import { DEFAULT_WINDOW_SIZE, expandWindow, windowTail } from "./listWindow";
import { useTransientFlag } from "./useTransientFlag";
import { agentLabel, normalizeCollaborationSettings, validateCollaborationSettings, type Agent, type AppMode,
  type ConversationSession, type RoomCollaborationSettings, type WorkspaceRecord,
  type RoomKind, type ReasoningEffort, type SessionMessage, type StoredMessage, type TaskSummary } from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import PixelIcon from "./PixelIcon";
import { roomDraftBlocker, toggleRoomAgentSelection } from "./roomSelection";
import ModeSegmented from "./sidebar/ModeSegmented";
import { chatRooms, coworkGroups, searchSidebar, type SidebarRoom } from "./sidebar/sidebarLists";
import { useT, type MultiPlan, type StreamingTurn } from "./store";
import { useStorePick } from "./selectors";
import { sfx } from "./fx";
import { shouldSubmitComposerEnter } from "./composerIme";
import WorkspaceChip from "./workspace/WorkspaceChip";
import AttachmentTray, { AttachmentImage } from "./attachments/AttachmentTray";
import { canReviewPlan, dropAgentBefore, moveAgentId } from "./multiAgentUi";
import ResizableComposer from "./composer/ResizableComposer";
import { roomTitleOrFallback } from "./workspace/projectSelection";

const DUTY_CLS: Record<string, string> = {
  propose: "bg-blue-100 text-blue-800",
  critique: "bg-red-100 text-red-800",
  synthesize: "bg-purple-100 text-purple-800",
  judge: "bg-amber-100 text-amber-800",
  summarize: "bg-amber-100 text-amber-800",
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
          <Markdown remarkPlugins={[remarkGfm]}>{m.content}</Markdown>
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
          <Markdown remarkPlugins={[remarkGfm]}>{throttledText}</Markdown>
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

function SingleAgentSession() {
  const {
    sessions, currentSessionId, sessionMessages, agentEvents, agentStreamText, pendingApprovals,
    agentRunning, agentError, sendAgentPrompt, decideAgentApproval, cancelAgentRun, rewindSessionTo, workspacePathResults, searchWorkspacePaths, addWorkspaceRef, usageSummaries,
  } = useStorePick("sessions", "currentSessionId", "sessionMessages", "agentEvents", "agentStreamText", "pendingApprovals", "agentRunning", "agentError", "sendAgentPrompt", "decideAgentApproval", "cancelAgentRun", "rewindSessionTo", "workspacePathResults", "searchWorkspacePaths", "addWorkspaceRef", "usageSummaries");
  // 窗口化：长会话只渲染最近 N 条，更早的可展开
  const [sessionLimit, setSessionLimit] = useState(DEFAULT_WINDOW_SIZE);
  useEffect(() => setSessionLimit(DEFAULT_WINDOW_SIZE), [currentSessionId]);
  const sessionWindow = windowTail(sessionMessages, sessionLimit);
  const t = useT();
  const [draft, setDraft] = useState("");
  const [sandbox, setSandbox] = useState<"read-only" | "workspace-write">("read-only");
  const session = sessions.find((item) => item.id === currentSessionId);
  const agentSnapshot = session?.agents[0]?.snapshot;
  const agentUsage = usageSummaries.find((item) => item.agentId === session?.agents[0]?.agentId);
  const usageText = (value: number | null | undefined) => value == null ? t("usage_unavailable") : value.toLocaleString();
  const streamingText = agentStreamText;
  const submit = async () => {
    const prompt = draft.trim();
    if (!prompt || agentRunning) return;
    // Local echo and an empty composer are committed before the network request
    // starts.  Waiting for the stream here made an Enter press look stuck.
    setDraft("");
    void sendAgentPrompt(prompt, sandbox);
  };
  const updateDraft = (value: string) => {
    setDraft(value);
    const match = /(?:^|\s)@([^\s]*)$/u.exec(value);
    if (match) void searchWorkspacePaths(match[1]);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2">
        <div>
          <div className="text-sm font-bold">{session?.title}</div>
          <div className="text-[10px] uppercase tracking-wider text-neutral-500">Single Agent · {sandbox}</div>
        </div>
        <div className="flex items-center gap-2">
          {agentSnapshot && <div className="pixel-card flex items-center gap-2 px-2 py-1"><AgentAvatar src={String(agentSnapshot.avatar ?? "")} label={String(agentSnapshot.nickname ?? "Agent")} size={28} lively={false} /><span className="text-[10px]">{t("usage_current")}: {usageText(agentUsage?.current.totalTokens)}<br />{t("usage_total")}: {usageText(agentUsage?.cumulative.totalTokens)}</span></div>}
          <WorkspaceChip workspaceId={session?.workspaceId} locked />
          <select className="pixel-input px-2 py-1 text-xs" value={sandbox} disabled={agentRunning} onChange={(event) => setSandbox(event.target.value as typeof sandbox)}>
            <option value="read-only">{t("sandbox_read_only")}</option>
            <option value="workspace-write">{t("sandbox_workspace_write")}</option>
          </select>
          {agentRunning && <button className="pixel-button px-2 py-1 text-xs text-red-700" onClick={() => void cancelAgentRun()}>{t("cancel_task")}</button>}
        </div>
      </header>
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        <div className="border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          {sandbox === "read-only" ? t("runtime_native_read_only") : t("runtime_codex_experimental")}
        </div>
        {agentError && <div role="alert" className="border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-700">{agentError}</div>}
        {sessionWindow.hiddenCount > 0 && (
          <button className="pixel-button mx-auto block px-3 py-1 text-xs" onClick={() => setSessionLimit((limit) => expandWindow(limit, sessionMessages.length))}>
            {t("show_earlier", { n: sessionWindow.hiddenCount })}
          </button>
        )}
        {sessionWindow.visible.map((message) => (
          <div key={message.id} className={`anim-msg group flex flex-col ${message.role === "user" ? "items-end" : "items-start"}`}>
            <div className={`pixel-card max-w-[78%] p-3 text-sm ${message.role === "user" ? "whitespace-pre-wrap bg-violet-50" : "md-body bg-white"}`}>
              {message.role === "user" ? message.content : <Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown>}
              {message.parts.filter((part) => part.type !== "text").length > 0 && <div className="mt-2 flex flex-wrap gap-2">
                {message.parts.map((part, index) => part.type === "image"
                  ? <AttachmentImage key={`${part.attachmentId}-${index}`} id={part.attachmentId} alt={part.alt ?? "image"} className="max-h-64 w-auto max-w-full" />
                  : part.type === "file" ? <span key={`${part.attachmentId}-${index}`} className="pixel-chip">{part.filename}</span>
                  : part.type === "workspace_ref" ? <span key={`${part.refId}-${index}`} className="pixel-chip">@{part.relativePath}</span>
                  : null)}
              </div>}
            </div>
            <MsgActions m={message} align={message.role === "user" ? "right" : "left"} busy={agentRunning} onRewind={(messageId) => void rewindSessionTo(messageId)} />
          </div>
        ))}
        {agentRunning && streamingText && <div className="pixel-card max-w-[78%] whitespace-pre-wrap bg-white p-3 text-sm">{streamingText}</div>}
        {agentEvents.filter((event) => event.type === "tool_call").map((event) => event.type === "tool_call" && (
          <div key={event.callId} className="pixel-tool-card p-3 text-xs">
            <div className="font-bold">{event.name}</div>
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap">{JSON.stringify(event.input, null, 2)}</pre>
          </div>
        ))}
        {pendingApprovals.map((approval) => {
          const rawId = approval.subjectId.slice(approval.subjectId.indexOf(":") + 1);
          const call = agentEvents.find((event) => event.type === "tool_call" && event.callId === rawId);
          return (
            <section key={approval.id} className="pixel-approval-card p-4" aria-label={approval.kind}>
              <div className="flex items-center justify-between gap-3"><strong>{approval.kind}</strong><span className="pixel-chip">{approval.risk}</span></div>
              {call?.type === "tool_call" && <pre className="my-3 max-h-48 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(call.input, null, 2)}</pre>}
              <div className="flex flex-wrap gap-2">
                <button className="pixel-button pixel-button--primary px-3 py-1.5 text-xs" onClick={() => void decideAgentApproval(approval.id, "allow_once")}>{t("approval_allow_once")}</button>
                {!approval.freshHumanRequired && <button className="pixel-button px-3 py-1.5 text-xs" onClick={() => void decideAgentApproval(approval.id, "allow_session")}>{t("approval_allow_session")}</button>}
                <button className="pixel-button px-3 py-1.5 text-xs text-red-700" onClick={() => void decideAgentApproval(approval.id, "deny")}>{t("approval_deny")}</button>
              </div>
            </section>
          );
        })}
      </div>
      <form className="composer-dock" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
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
      </form>
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

function MultiAgentSession() {
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
  const [order, setOrder] = useState<string[]>(() => participants.map((item) => item.id));
  const [rounds, setRounds] = useState(1);
  const [synthesizerId, setSynthesizerId] = useState(order[order.length - 1] ?? "");
  const [executionAgentId, setExecutionAgentId] = useState(order[0] ?? "");
  const [effortByAgent, setEffortByAgent] = useState<Record<string, ReasoningEffort>>({});
  const [fallbackOrderByAgent, setFallbackOrderByAgent] = useState<Record<string, string[]>>({});
  const dragging = useRef<string | null>(null);
  const [showCollab, setShowCollab] = useState(false);
  useEffect(() => {
    const ids = participants.map((item) => item.id);
    setOrder(ids); setSynthesizerId(ids[ids.length - 1] ?? ""); setExecutionAgentId(ids[0] ?? "");
    setEffortByAgent(Object.fromEntries(participants.flatMap((item) => typeof item.reasoningEffort === "string" ? [[item.id, item.reasoningEffort as ReasoningEffort]] : [])));
  }, [currentSessionId]);
  // 主实时路径是 SSE delta / turn 事件（见 store.sendMultiTask）；此定时器仅为无 SSE 流阶段
  // （如 executing）的兜底对账，2s 一次，不再是 750ms 的主轮询。
  useEffect(() => {
    if (!currentMultiTask || ["awaiting_plan_approval", "failed", "cancelled", "completed", "paused"].includes(currentMultiTask.state)) return;
    const timer = window.setInterval(() => void loadMultiTask(currentMultiTask.id), 2000);
    return () => window.clearInterval(timer);
  }, [currentMultiTask?.id, currentMultiTask?.state, loadMultiTask]);
  const move = (id: string, delta: number) => setOrder((current) => moveAgentId(current, id, delta));
  const terminal = !currentMultiTask || ["failed", "cancelled", "completed"].includes(currentMultiTask.state);
  const pausable = currentMultiTask && ["preparing", "discussing", "synthesizing", "executing", "awaiting_tool_approval"].includes(currentMultiTask.state);
  return <div className="flex min-h-0 flex-1 flex-col">
    <header className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2">
      <div><div className="text-sm font-bold">{session?.title}</div><div className="text-[10px] uppercase tracking-wider text-neutral-500">Multi-Agent · {currentMultiTask?.state ?? "idle"}</div></div>
      <div className="flex items-center gap-2"><WorkspaceChip workspaceId={session?.workspaceId} locked />{session && <button className="pixel-button flex items-center gap-1 px-2 py-1 text-xs" onClick={() => setShowCollab(true)} title={t("cowork_settings_title")}><PixelIcon name="gear" size={14} />{t("cowork_settings_title")}</button>}<div className="flex -space-x-2">{participants.slice(0, 6).map((agent) => <AgentAvatar key={agent.id} src={String(agent.avatar ?? "")} label={String(agent.nickname ?? agent.id)} size={28} lively={false} />)}</div>{currentMultiTask?.state === "paused" ? <button className="pixel-button pixel-button--primary px-2 py-1 text-xs" onClick={() => void (currentMultiTask.outcomeUnknown || currentMultiTask.requiresExecutionReview ? retryMultiTask() : resumeMultiTask())}>{t(currentMultiTask.outcomeUnknown || currentMultiTask.requiresExecutionReview ? "multi_retry_reviewed" : "multi_resume")}</button> : pausable && <button className="pixel-button px-2 py-1 text-xs" onClick={() => void pauseMultiTask()}>{t("multi_pause")}</button>}{currentMultiTask && !terminal && <button className="pixel-button px-2 py-1 text-xs text-red-700" onClick={() => void cancelMultiTask()}>{t("cancel_task")}</button>}</div>
    </header>
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
          <div className={`md-body pixel-card p-3 text-sm ${message.role === "user" ? "bg-violet-50" : "bg-white"}`}><Markdown remarkPlugins={[remarkGfm]}>{message.content}</Markdown></div>
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
      {currentMultiTask && <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{participants.map((agent) => {
        const usage = currentMultiTask.usageSummaries.find((item) => item.agentId === agent.id);
        const fmt = (value: number | null) => value === null ? t("usage_unavailable") : value.toLocaleString();
        return <div key={agent.id} className="pixel-card flex items-center gap-3 p-2"><AgentAvatar src={String(agent.avatar ?? "")} label={String(agent.nickname ?? agent.id)} size={34} lively={false} /><div className="min-w-0 text-[10px]"><div className="truncate font-bold">{String(agent.nickname ?? agent.id)}</div><div>{t("usage_current")}: {fmt(usage?.current.totalTokens ?? null)} · {t("usage_total")}: {fmt(usage?.cumulative.totalTokens ?? null)}</div><div>{t("usage_cached")}: {fmt(usage?.cumulative.cachedInputTokens ?? null)} · {t("usage_reasoning")}: {fmt(usage?.cumulative.reasoningTokens ?? null)}</div></div></div>;
      })}</div>}
      {currentMultiTask?.plan && <MultiPlanCard plan={currentMultiTask.plan} />}
      {currentMultiTask?.pendingApprovals.map((approval) => <section key={approval.id} className="pixel-approval-card p-4">
        <div className="flex items-center justify-between"><strong>{approval.kind}</strong><span className="pixel-chip">{approval.risk}</span></div>
        <p className="my-2 text-xs text-neutral-600">{approval.kind === "plan_scope_expansion" ? t("multi_scope_expansion") : t("multi_tool_approval_hint")}</p>
        <div className="flex gap-2"><button className="pixel-button pixel-button--primary px-3 py-1.5 text-xs" onClick={() => void decideMultiApproval(approval.id, "allow_once")}>{t("approval_allow_once")}</button>{!approval.freshHumanRequired && <button className="pixel-button px-3 py-1.5 text-xs" onClick={() => void decideMultiApproval(approval.id, "allow_session")}>{t("approval_allow_session")}</button>}<button className="pixel-button px-3 py-1.5 text-xs text-red-700" onClick={() => void decideMultiApproval(approval.id, "deny")}>{t("approval_deny")}</button></div>
      </section>)}
      {terminal && <form className="pixel-card space-y-4 p-4" onSubmit={(event) => { event.preventDefault(); void sendMultiTask({ prompt, speakingOrder: order, maxRounds: rounds, synthesizerId, executionAgentId, effortByAgent, fallbackOrderByAgent }); }}>
        <div><div className="pixel-kicker">DISCUSSION SETUP</div><h3 className="font-bold">{t("multi_new_task")}</h3></div>
        <textarea className="pixel-input min-h-28 w-full p-3 text-sm" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("multi_prompt_placeholder")} />
        <div className="grid gap-4 md:grid-cols-2"><div><div className="mb-2 text-xs font-bold">{t("speaking_order")}</div><div className="max-h-64 space-y-2 overflow-y-auto">
          {order.map((id, index) => { const agent = participants.find((item) => item.id === id); return <div key={id} draggable className="pixel-card flex items-center gap-2 p-2" onDragStart={() => { dragging.current = id; }} onDragOver={(event) => event.preventDefault()} onDrop={() => { const source = dragging.current; if (!source || source === id) return; setOrder((current) => dropAgentBefore(current, source, id)); dragging.current = null; }}>
            <span className="cursor-grab">⠿</span><AgentAvatar src={String(agent?.avatar ?? "")} label={String(agent?.nickname ?? id)} size={30} /><span className="min-w-0 flex-1 truncate text-sm">{agent?.nickname as string ?? id}</span>{Array.isArray((agent?.modelCapabilities as { reasoningEfforts?: unknown } | undefined)?.reasoningEfforts) && ((agent?.modelCapabilities as { reasoningEfforts: ReasoningEffort[] }).reasoningEfforts.length > 0) && <select aria-label={t("reasoning_effort")} className="pixel-input max-w-24 px-1 py-1 text-xs" value={effortByAgent[id] ?? ""} onChange={(event) => setEffortByAgent((current) => event.target.value ? { ...current, [id]: event.target.value as ReasoningEffort } : Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))}><option value="">—</option>{(agent?.modelCapabilities as { reasoningEfforts: ReasoningEffort[] }).reasoningEfforts.map((effort) => <option key={effort}>{effort}</option>)}</select>}<select aria-label={t("multi_fallback")} title={t("multi_fallback")} className="pixel-input max-w-28 px-1 py-1 text-xs" value={fallbackOrderByAgent[id]?.[0] ?? ""} onChange={(event) => setFallbackOrderByAgent((current) => event.target.value ? { ...current, [id]: [event.target.value] } : Object.fromEntries(Object.entries(current).filter(([key]) => key !== id)))}><option value="">{t("multi_no_fallback")}</option>{order.filter((candidate) => candidate !== id).map((candidate) => <option key={candidate} value={candidate}>{String(participants.find((item) => item.id === candidate)?.nickname ?? candidate)}</option>)}</select><button type="button" aria-label="move up" className="pixel-button px-1" disabled={index === 0} onClick={() => move(id, -1)}>↑</button><button type="button" aria-label="move down" className="pixel-button px-1" disabled={index === order.length - 1} onClick={() => move(id, 1)}>↓</button>
          </div>; })}
        </div></div><div className="space-y-3"><label className="block text-xs font-bold">{t("max_rounds")}<input className="pixel-input mt-1 w-full px-3 py-2" type="number" min={1} max={20} value={rounds} onChange={(event) => setRounds(Number(event.target.value))} /></label><label className="block text-xs font-bold">{t("multi_synthesizer")}<select className="pixel-input mt-1 w-full px-3 py-2" value={synthesizerId} onChange={(event) => setSynthesizerId(event.target.value)}>{order.map((id) => <option key={id} value={id}>{String(participants.find((item) => item.id === id)?.nickname ?? id)}</option>)}</select></label><label className="block text-xs font-bold">{t("multi_executor")}<select className="pixel-input mt-1 w-full px-3 py-2" value={executionAgentId} onChange={(event) => setExecutionAgentId(event.target.value)}>{order.map((id) => <option key={id} value={id}>{String(participants.find((item) => item.id === id)?.nickname ?? id)}</option>)}</select></label></div></div>
        <button className="pixel-button pixel-button--primary px-4 py-2 text-sm" disabled={multiRunning || !prompt.trim()}>{multiRunning ? t("multi_discussing") : t("multi_start")}</button>
      </form>}
    </div>
    {showCollab && session && <CoworkRoomSettingsDialog session={session} onClose={() => setShowCollab(false)} />}
  </div>;
}

function NewRoomDialog({ onClose }: { onClose: () => void }) {
  const { agents, workspaces, createRoomFromDraft } = useStorePick("agents", "workspaces", "createRoomFromDraft");
  const t = useT();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState<RoomKind>("chat");
  // Co-work 的工作区必须在这里明确选，不从全局 activeWorkspace 继承
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const dialog = useAnimatedDialogClose(onClose);

  const toggle = (id: string) => {
    setSelected((current) => toggleRoomAgentSelection(current, id));
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
      await createRoomFromDraft({
        kind,
        title: roomTitleOrFallback(name, t("room_untitled")),
        agentIds: selected,
        workspaceId: kind === "cowork" ? workspaceId : null,
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

        <div className="mt-5 grid grid-cols-2 gap-2" role="radiogroup" aria-label={t("room_kind")}>
          {(["chat", "cowork"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={kind === value}
              className={`pixel-mode-card p-3 text-left ${kind === value ? "is-selected" : ""}`}
              onClick={() => {
                setKind(value);
                setError(null);
              }}
            >
              <span className="block text-sm font-bold">{t(`room_kind_${value}`)}</span>
              <span className="mt-1 block text-[11px] text-neutral-500">{t(`room_kind_${value}_desc`)}</span>
            </button>
          ))}
        </div>
        {kind === "cowork" && (
          <label className="mt-3 block text-sm font-bold">
            {t("room_workspace")}
            <select
              className="pixel-input mt-1 w-full px-3 py-2 text-sm"
              value={workspaceId ?? ""}
              onChange={(event) => {
                setWorkspaceId(event.target.value || null);
                setError(null);
              }}
            >
              <option value="">{t("room_workspace_placeholder")}</option>
              {workspaces.filter((workspace) => !workspace.archived).map((workspace) => (
                <option key={workspace.id} value={workspace.id}>{workspace.label || workspace.displayPath}</option>
              ))}
            </select>
            {!workspaceId && <span className="mt-1 block text-xs text-amber-700">{t("workspace_required_hint")}</span>}
          </label>
        )}

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
              disabled={roomDraftBlocker({ kind, title: name, agentIds: selected, workspaceId }) !== null}
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
  const item = "block w-full px-3 py-2 text-left text-sm hover:bg-neutral-100";
  const run = async (operation: () => Promise<void>) => {
    try {
      await operation();
      onClose();
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
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
  const { agents, updateCollaboration } = useStorePick("agents", "updateCollaboration");
  const t = useT();
  const dialog = useAnimatedDialogClose(onClose);
  const [draft, setDraft] = useState<RoomCollaborationSettings>(() => normalizeCollaborationSettings(session.collaboration));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const memberIds = session.agents.map((agent) => agent.agentId);
  const nameOf = (id: string) => agents.find((agent) => agent.id === id)?.nickname ?? id;
  const shape = { kind: session.kind, workspaceId: session.workspaceId, agentIds: memberIds };
  const problems = validateCollaborationSettings(shape, draft);
  const patch = (over: Partial<RoomCollaborationSettings>) => { setDraft((current) => ({ ...current, ...over })); setError(null); };

  const bossOn = draft.collaborationMode === "agent_directed_multi_agent";

  const save = async () => {
    if (problems.length) { setError(problems[0]); return; }
    setSaving(true);
    try {
      await updateCollaboration(session.id, draft);
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

  return (
    <div className={`pixel-dialog-backdrop ${dialog.closing ? "is-closing" : ""}`} role="presentation" onMouseDown={dialog.close}>
      <section className="pixel-dialog max-h-[calc(100vh-40px)] w-[min(600px,calc(100vw-48px))] overflow-y-auto p-5" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="pixel-kicker">CO-WORK POLICY</div>
            <h3 className="text-lg font-bold">{t("cowork_settings_title")}</h3>
            <p className="mt-1 text-xs text-neutral-500">{session.title}</p>
          </div>
          <button className="pixel-button h-8 w-8" aria-label={t("close")} onClick={() => { sfx.close(); dialog.close(); }}>×</button>
        </div>

        {/* 讨论模式：关闭时跳过讨论，直接生成计划（快速提问不再空跑一轮） */}
        <label className="block text-sm font-bold">{t("discussion_mode")}</label>
        <div className="mb-4 mt-1 grid grid-cols-2 gap-2">
          {(["round_robin", "off"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`pixel-mode-card p-3 text-left ${draft.discussionMode === value ? "is-selected" : ""}`}
              onClick={() => patch({ discussionMode: value })}
            >
              <span className="block text-sm font-bold">{t(`discussion_mode_${value}`)}</span>
              <span className="mt-1 block text-[11px] text-neutral-500">{t(`discussion_mode_${value}_desc`)}</span>
            </button>
          ))}
        </div>

        {/* 协作方式：单执行者 vs Boss 统筹（Boss 会真实接管计划整合） */}
        <label className="block text-sm font-bold">{t("collab_mode")}</label>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {(["single_executor", "agent_directed_multi_agent"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={`pixel-mode-card p-3 text-left ${draft.collaborationMode === value ? "is-selected" : ""}`}
              onClick={() => patch(value === "agent_directed_multi_agent"
                ? { collaborationMode: value, boss: { ...draft.boss, enabled: true } }
                : { collaborationMode: value, boss: { enabled: false, bossAgentId: null, allowBossExecution: false } })}
            >
              <span className="block text-sm font-bold">{t(`collab_mode_${value}`)}</span>
              <span className="mt-1 block text-[11px] text-neutral-500">{t(`collab_mode_${value}_desc`)}</span>
            </button>
          ))}
        </div>

        {bossOn && (
          <div className="pixel-card mt-3 space-y-3 p-3">
            <label className="block text-sm font-bold">{t("boss_agent")}
              {memberSelect(draft.boss.bossAgentId, (id) => patch({ boss: { ...draft.boss, bossAgentId: id } }), t("boss_agent_placeholder"))}
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={draft.boss.allowBossExecution} onChange={(event) => patch({ boss: { ...draft.boss, allowBossExecution: event.target.checked } })} />
              {t("boss_allow_execution")}
            </label>
            <p className="text-[11px] text-neutral-500">{t("boss_hint")}</p>
          </div>
        )}

        {/* 审批方式：后两者真跑一次审核 Agent */}
        <label className="mt-5 block text-sm font-bold">{t("approval_mode")}</label>
        <div className="mt-1 space-y-1">
          {(["human", "executor_self_check", "designated_reviewer"] as const).map((value) => (
            <label key={value} className="flex items-start gap-2 text-sm">
              <input type="radio" name="approval" className="mt-1" checked={draft.approvalMode === value} onChange={() => patch({ approvalMode: value })} />
              <span><span className="font-medium">{t(`approval_mode_${value}`)}</span><span className="block text-[11px] text-neutral-500">{t(`approval_mode_${value}_desc`)}</span></span>
            </label>
          ))}
        </div>
        {draft.approvalMode === "designated_reviewer" && (
          <label className="mt-2 block text-sm font-bold">{t("designated_reviewer")}
            {memberSelect(draft.designatedReviewerId, (id) => patch({ designatedReviewerId: id }), t("reviewer_placeholder"))}
          </label>
        )}

        {/* 尚未接入运行时的维度：如实标注，不做成假开关 */}
        <div className="mt-5 rounded border-2 border-dashed border-neutral-300 p-3 opacity-70">
          <div className="text-[11px] font-bold uppercase tracking-wider text-neutral-500">{t("not_wired_yet")}</div>
          <p className="mt-1 text-xs text-neutral-500">{t("supervision_not_wired_desc")}</p>
        </div>

        {error && <p className="mt-3 text-sm text-red-700">{t(error)}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <button className="pixel-button px-3 py-2 text-sm" type="button" onClick={dialog.close}>{t("cancel")}</button>
          <button className="pixel-button pixel-button--primary px-4 py-2 text-sm" type="button" disabled={saving || problems.length > 0} onClick={save}>{t("save")}</button>
        </div>
      </section>
    </div>
  );
}

export default function ChatPage({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { rooms, agents, sessions, workspaces, activeWorkspace, currentRoomId, currentSessionId, config, updateConfig, messages, streaming, activeTaskId, rewindTo, chatError, tasks, usageSummaries, selectRoom, selectAgentSession, setActiveWorkspace, clearChatError } =
    useStorePick("rooms", "agents", "sessions", "workspaces", "activeWorkspace", "currentRoomId", "currentSessionId", "config", "updateConfig", "messages", "streaming", "activeTaskId", "rewindTo", "chatError", "tasks", "usageSummaries", "selectRoom", "selectAgentSession", "setActiveWorkspace", "clearChatError");
  const bubbleBusy = !!streaming || !!activeTaskId;
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [renameTarget, setRenameTarget] = useState<RenameTarget | null>(null);
  const [sidebarError, setSidebarError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [collabSessionId, setCollabSessionId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [foldedGroups, setFoldedGroups] = useState<string[]>([]);
  const collapsed = config?.sidebar.collapsed ?? false;
  const bottomRef = useRef<HTMLDivElement>(null);

  // 侧栏统一视图：rooms（Chat）与 sessions（Co-work）折算成同一种行，
  // source 决定点击走 selectRoom 还是 selectAgentSession。
  const entries = useMemo<SidebarEntry[]>(() => [
    ...rooms.map((room) => ({ id: room.id, name: room.name, kind: "chat" as const, workspaceId: null, archived: room.archived, source: "room" as const })),
    ...sessions.map((session) => ({ id: session.id, name: session.title, kind: session.kind, workspaceId: session.workspaceId, archived: session.archived, source: "session" as const })),
  ], [rooms, sessions]);

  // 顶层模式跟随当前选中的房间，而不是另存一份会不同步的副本
  const currentEntry = entries.find((entry) => entry.id === (currentSessionId ?? currentRoomId));
  const [modeOverride, setModeOverride] = useState<AppMode | null>(null);
  const mode: AppMode = modeOverride ?? currentEntry?.kind ?? "chat";
  useEffect(() => setModeOverride(null), [currentRoomId, currentSessionId]);

  const memberNamesByRoom = useMemo(() => {
    const named = (ids: string[]) => ids.map((id) => agents.find((agent) => agent.id === id)?.nickname ?? "");
    return Object.fromEntries([
      ...rooms.map((room) => [room.id, named(room.agentIds)] as const),
      ...sessions.map((session) => [session.id, named(session.agents.map((agent) => agent.agentId))] as const),
    ]);
  }, [rooms, sessions, agents]);

  const openEntry = (entry: SidebarEntry) =>
    void (entry.source === "room" ? selectRoom(entry.id) : selectAgentSession(entry.id));

  const searchHits = searchSidebar(query, mode, {
    rooms: entries,
    workspaces: workspaces.map((workspace) => ({ ...workspace, path: workspace.canonicalPath })),
    memberNamesByRoom,
  });

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
        <PixelIcon name={entry.kind === "cowork" ? "robot" : "chat"} size={18} />
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

  const createInWorkspace = async (workspaceId: string | null) => {
    try {
      await setActiveWorkspace(workspaceId);
      setCreating(true);
    } catch (error) {
      setSidebarError(error instanceof Error ? error.message : String(error));
    }
  };

  /** Co-work 的工作区分组；展开与选中互不影响（展开状态由 collapsedGroups 单独持有）。 */
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
          {!collapsed && <button className="pixel-project-action" title={t("new_room")} aria-label={t("new_room")} onClick={() => void createInWorkspace(workspace.id)}><PixelIcon name="plus" size={15} /></button>}
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

  const currentRoom = rooms.find((r) => r.id === currentRoomId);
  const currentSession = sessions.find((session) => session.id === currentSessionId);
  const roomAgents = useMemo(
    () => (currentRoom?.agentIds ?? []).map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [currentRoom, agents],
  );

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
    <div className="flex h-[calc(100dvh-var(--app-header-height))]">
      <aside className={`pixel-room-sidebar flex shrink-0 flex-col p-3 ${collapsed ? "w-14" : "w-64"}`}>
        <div className="flex items-center gap-2">
          {!collapsed && (
            <button
              className="pixel-new-room-button flex min-w-0 flex-1 items-center justify-center gap-2 px-3 py-2.5 text-sm font-bold"
              onClick={() => setCreating(true)}
            >
              <PixelIcon name="plus" size={20} />
              {t("new_room")}
            </button>
          )}
          <button
            className="pixel-button h-9 w-9 shrink-0"
            aria-label={t(collapsed ? "sidebar_expand" : "sidebar_collapse")}
            title={t(collapsed ? "sidebar_expand" : "sidebar_collapse")}
            aria-expanded={!collapsed}
            onClick={() => void updateConfig({ sidebar: { ...config!.sidebar, collapsed: !collapsed } })}
          >
            {collapsed ? "»" : "«"}
          </button>
        </div>
        {collapsed && (
          <button className="pixel-button mt-2 h-9 w-9 self-center" aria-label={t("new_room")} title={t("new_room")} onClick={() => setCreating(true)}>
            <PixelIcon name="plus" size={18} />
          </button>
        )}

        <div className="mt-3">
          <ModeSegmented
            mode={mode}
            onChange={setModeOverride}
            collapsed={collapsed}
            labels={{ chat: t("room_kind_chat"), cowork: t("room_kind_cowork") }}
          />
        </div>

        {!collapsed && (
          <input
            type="search"
            className="pixel-input mt-2 w-full px-2 py-1.5 text-xs"
            placeholder={t("sidebar_search_placeholder")}
            aria-label={t("sidebar_search_placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        )}
        {!collapsed && mode === "cowork" && <div className="mt-2"><WorkspaceChip /></div>}
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
          ) : mode === "chat" ? (
            <div className="space-y-1 px-1">
              {chatRooms(entries).length === 0 && <p className="px-2 py-1 text-[10px] text-neutral-400">{t("project_empty")}</p>}
              {(chatRooms(entries) as SidebarEntry[]).map(entryRow)}
            </div>
          ) : (
            coworkGroups(entries, workspaces).map((group) => workspaceGroup({ ...group, workspace: workspaces.find((item) => item.id === group.workspace.id)! }))
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
      {creating && <NewRoomDialog onClose={() => setCreating(false)} />}
      {renameTarget && <RenameDialog target={renameTarget} onClose={() => setRenameTarget(null)} />}
      {menu && <SidebarEntityMenu menu={menu} onClose={() => setMenu(null)} onRename={setRenameTarget} onCollab={setCollabSessionId} onError={setSidebarError} />}
      {collabSessionId && (() => {
        const target = sessions.find((session) => session.id === collabSessionId);
        return target ? <CoworkRoomSettingsDialog session={target} onClose={() => setCollabSessionId(null)} /> : null;
      })()}
      {showMembers && currentRoom && (
        <RoomMembersDialog roomId={currentRoom.id} memberIds={currentRoom.agentIds} onClose={() => setShowMembers(false)} />
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        {currentSessionId ? (currentSession?.mode === "multi_agent" ? <MultiAgentSession /> : <SingleAgentSession />) : currentRoomId ? (
          <>
            <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2">
              <span className="text-sm font-bold">{currentRoom?.name}</span>
              <div className="flex items-center gap-2">
                {roomAgents.slice(0, 3).map((agent) => { const usage = usageSummaries.find((item) => item.agentId === agent.id); return <span key={agent.id} className="pixel-chip text-[10px]" title={`${t("usage_current")}: ${usage?.current.totalTokens ?? t("usage_unavailable")} · ${t("usage_total")}: ${usage?.cumulative.totalTokens ?? t("usage_unavailable")}`}>{agent.nickname}: {usage?.cumulative.totalTokens ?? "—"}</span>; })}
                <button className="pixel-member-button flex items-center gap-1 px-2 py-1" onClick={() => setShowMembers(true)} title={t("room_members_title")}>
                  <span className="flex -space-x-2">
                    {roomAgents.slice(0, 4).map((agent) => <AgentAvatar key={agent.id} src={agent.avatar} label={agent.nickname} size={26} lively={false} />)}
                  </span>
                  <span className="ml-1 text-xs">{roomAgents.length}</span>
                </button>
                <button
                  className={`pixel-button px-2 py-1 text-xs ${showTasks ? "pixel-button--primary" : ""}`}
                  onClick={() => setShowTasks((v) => !v)}
                >
                  {t("task_history", { n: tasks.length })}
                </button>
              </div>
            </div>
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
          <p className="p-6 text-sm text-neutral-500">{t("pick_room")}</p>
        )}
      </section>
    </div>
  );
}
