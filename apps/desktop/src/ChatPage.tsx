import { useEffect, useMemo, useRef, useState } from "react";
import { agentLabel, type Agent, type StoredMessage, type TaskSummary } from "@socrates/core";
import AgentAvatar from "./AgentAvatar";
import { useStore, useT, type StreamingTurn } from "./store";

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

function Bubble({ m }: { m: StoredMessage }) {
  if (m.role === "user") {
    return (
      // 任务的用户消息作为回放跳转锚点
      <div className="flex justify-end" id={m.taskId ? `task-${m.taskId}` : undefined}>
        <div className="max-w-[70%] rounded-lg bg-neutral-900 px-3 py-2 text-sm whitespace-pre-wrap text-white">
          {m.content}
        </div>
      </div>
    );
  }
  const isSummary = m.phase === "summary";
  return (
    <div className="flex justify-start">
      <div className={isSummary ? "w-full max-w-[85%]" : "max-w-[70%]"}>
        <AgentHeader name={m.agentName} avatar={m.agentAvatar} model={m.model} duty={m.duty ?? (isSummary ? "summarize" : undefined)} />
        <div
          className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
            isSummary ? "border-2 border-amber-300 bg-amber-50" : "border border-neutral-200 bg-white"
          }`}
        >
          {m.content}
        </div>
      </div>
    </div>
  );
}

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
  return (
    <div className="flex justify-start">
      <div className={s.phase === "summary" ? "w-full max-w-[85%]" : "max-w-[70%]"}>
        <AgentHeader name={s.agentName} avatar={s.agentAvatar} model={s.model} duty={s.duty ?? (s.phase === "summary" ? "summarize" : undefined)} />
        <div
          className={`rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
            s.phase === "summary" ? "border-2 border-amber-300 bg-amber-50" : "border border-neutral-200 bg-white"
          }`}
        >
          {s.text}
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
  const { tasks, lang } = useStore();
  const t = useT();
  if (tasks.length === 0) {
    return <p className="border-b border-neutral-200 bg-white px-4 py-2 text-xs text-neutral-500">{t("no_tasks")}</p>;
  }
  return (
    <ul className="max-h-56 divide-y divide-neutral-100 overflow-y-auto border-b border-neutral-200 bg-white">
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
  const { activeTaskId, failedTurn, streaming, cancelTask, decideTurn } = useStore();
  const t = useT();
  if (!activeTaskId) return null;
  if (failedTurn) {
    return (
      <div className="mx-4 mb-2 flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
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
    <div className="mx-4 mb-2 flex items-center justify-between rounded border border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
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
function TaskComposer({ agents }: { agents: Agent[] }) {
  const { streaming, activeTaskId, sendTask } = useStore();
  const t = useT();
  const busy = !!streaming || !!activeTaskId;
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

  const dragOver = (e: React.DragEvent, overId: string) => {
    e.preventDefault();
    if (!dragId || dragId === overId) return;
    setItems((prev) => {
      const from = prev.findIndex((i) => i.id === dragId);
      const to = prev.findIndex((i) => i.id === overId);
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = prompt.trim();
    if (!p || (mode === "round_robin" && speakingOrder.length === 0)) return;
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
    <form onSubmit={submit} className="space-y-2 border-t border-neutral-200 bg-white p-3">
      {showConfig && (
        <div className="flex gap-4 rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm">
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
                        {a.displayName}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
            </div>
          ) : (
            <div className="min-w-0 flex-1">
              <div className="mb-1 text-neutral-500">{t("order_hint")}</div>
              <ul className="max-h-44 space-y-1 overflow-y-auto pr-1">
                {items.map((item) => {
                  const a = agentOf(item.id);
                  if (!a) return null;
                  const position = item.enabled ? speakingOrder.indexOf(item.id) + 1 : null;
                  return (
                    <li
                      key={item.id}
                      draggable
                      onDragStart={() => setDragId(item.id)}
                      onDragEnd={() => setDragId(null)}
                      onDragOver={(e) => dragOver(e, item.id)}
                      className={`flex cursor-grab items-center gap-2 rounded border bg-white px-2 py-1 ${
                        dragId === item.id ? "border-neutral-400 opacity-60" : "border-neutral-200"
                      } ${item.enabled ? "" : "text-neutral-400"}`}
                    >
                      <span className="select-none text-neutral-400">⠿</span>
                      <input type="checkbox" checked={item.enabled} onChange={() => toggle(item.id)} />
                      <span className="w-5 text-xs text-neutral-400">{position ? `${position}.` : "—"}</span>
                      <span className="min-w-0 flex-1 truncate">{a.displayName}</span>
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
                      {a.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
        </div>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          className="rounded border border-neutral-300 px-2 text-sm text-neutral-500 hover:bg-neutral-100"
          title={t("config_tooltip")}
          onClick={() => setShowConfig((v) => !v)}
        >
          ⚙
        </button>
        <input
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
          placeholder={
            busy
              ? t("task_running")
              : mode === "debate"
                ? t("debate_placeholder", { m: maxRounds })
                : t("rr_placeholder", { n: speakingOrder.length, m: maxRounds })
          }
          value={prompt}
          disabled={busy}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <button
          className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
          disabled={busy || !prompt.trim() || (mode === "round_robin" && speakingOrder.length === 0)}
          type="submit"
        >
          {mode === "debate" ? t("start_debate") : t("start_discussion")}
        </button>
      </div>
    </form>
  );
}

function SimpleComposer() {
  const { streaming, sendMessage } = useStore();
  const t = useT();
  const [draft, setDraft] = useState("");
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await sendMessage(content);
  };
  return (
    <form onSubmit={submit} className="flex gap-2 border-t border-neutral-200 bg-white p-3">
      <input
        className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
        placeholder={streaming ? t("replying") : t("message_placeholder")}
        value={draft}
        disabled={!!streaming}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        disabled={!!streaming || !draft.trim()}
        type="submit"
      >
        {t("send")}
      </button>
    </form>
  );
}

function NewRoomForm({ onDone }: { onDone: () => void }) {
  const { agents, createRoom } = useStore();
  const t = useT();
  const [name, setName] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createRoom(name, selected);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <form onSubmit={submit} className="space-y-2 rounded border border-neutral-200 bg-white p-3">
      <input
        className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm"
        placeholder={t("room_name")}
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="max-h-32 space-y-1 overflow-y-auto">
        {agents.length === 0 && <p className="text-xs text-neutral-500">{t("create_agent_first")}</p>}
        {agents.map((a) => (
          <label key={a.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
            {a.displayName}
            <span className="text-xs text-neutral-400">{a.modelId}</span>
          </label>
        ))}
      </div>
      {error && <p className="text-xs text-red-700">{error}</p>}
      <div className="flex gap-2">
        <button className="rounded bg-neutral-900 px-2 py-1 text-xs text-white" type="submit">
          {t("create")}
        </button>
        <button className="rounded border border-neutral-300 px-2 py-1 text-xs" type="button" onClick={onDone}>
          {t("cancel")}
        </button>
      </div>
    </form>
  );
}

/** 房间右键菜单（类 Codex/OpenCode）：归档/恢复、删除（二次点击确认） */
type MenuState = { roomId: string; x: number; y: number };

function RoomContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const { rooms, archiveRoom, removeRoom } = useStore();
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const room = rooms.find((r) => r.id === menu.roomId);

  useEffect(() => {
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent && e.key !== "Escape") return;
      onClose();
    };
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);

  if (!room) return null;
  const item = "block w-full px-3 py-1.5 text-left text-sm hover:bg-neutral-100";
  return (
    <div
      className="fixed z-50 w-36 overflow-hidden rounded-md border border-neutral-200 bg-white py-1 shadow-lg"
      style={{ left: menu.x, top: menu.y }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <button
        className={item}
        onClick={() => {
          void archiveRoom(room.id, !room.archived);
          onClose();
        }}
      >
        {room.archived ? t("unarchive") : t("archive")}
      </button>
      <button
        className={`${item} ${confirming ? "font-medium text-red-700" : "text-red-600"}`}
        onClick={() => {
          if (!confirming) {
            setConfirming(true);
            return;
          }
          void removeRoom(room.id);
          onClose();
        }}
      >
        {confirming ? t("confirm_delete") : t("delete")}
      </button>
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
  const { agents, addRoomAgent } = useStore();
  const t = useT();
  const members = memberIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is Agent => !!agent);
  const available = agents.filter((agent) => !memberIds.includes(agent.id));
  return (
    <div className="pixel-dialog-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="pixel-dialog w-[min(560px,calc(100vw-48px))] p-5" role="dialog" aria-modal="true" onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-4 flex items-start justify-between">
          <div>
            <div className="pixel-kicker">ROOM ROSTER</div>
            <h3 className="text-lg font-bold">{t("room_members_title")}</h3>
          </div>
          <button className="pixel-button h-8 w-8" onClick={onClose} aria-label={t("close")}>×</button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          {members.map((agent) => (
            <div key={agent.id} className="pixel-card flex items-center gap-3 p-3">
              <AgentAvatar src={agent.avatar} label={agent.nickname} size={52} />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{agentLabel(agent)}</div>
                <div className="truncate text-xs text-neutral-500">{agent.displayName}</div>
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
                  <div className="truncate text-xs text-neutral-500">{agent.displayName}</div>
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

export default function ChatPage() {
  const { rooms, agents, currentRoomId, messages, streaming, chatError, tasks, selectRoom, clearChatError } =
    useStore();
  const t = useT();
  const [creating, setCreating] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const activeRooms = rooms.filter((r) => !r.archived);
  const archivedRooms = rooms.filter((r) => r.archived);

  const roomRow = (r: (typeof rooms)[number]) => (
    <div
      key={r.id}
      className={`group flex cursor-pointer items-center rounded px-2 py-1.5 text-sm ${
        r.id === currentRoomId ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"
      } ${r.archived ? "opacity-60" : ""}`}
      onClick={() => void selectRoom(r.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ roomId: r.id, x: e.clientX, y: e.clientY });
      }}
    >
      <span className="min-w-0 flex-1 truncate">{r.name}</span>
      {/* macOS WKWebView 不可靠派发 contextmenu，用常驻 ⋯ 按钮作主入口，右键作补充 */}
      <button
        title={t("room_menu")}
        className={`ml-1 shrink-0 rounded px-1 text-sm opacity-0 group-hover:opacity-100 ${
          r.id === currentRoomId ? "text-neutral-300 hover:bg-neutral-700" : "text-neutral-400 hover:bg-neutral-200"
        } ${menu?.roomId === r.id ? "opacity-100" : ""}`}
        onClick={(e) => {
          e.stopPropagation();
          const rect = e.currentTarget.getBoundingClientRect();
          setMenu({ roomId: r.id, x: rect.right - 144, y: rect.bottom + 4 });
        }}
      >
        ⋯
      </button>
      <span
        className={`ml-1 shrink-0 text-[10px] ${r.id === currentRoomId ? "text-neutral-400" : "text-neutral-300"}`}
      >
        {t("room_members", { n: r.agentIds.length })}
      </span>
    </div>
  );

  const jumpToTask = (taskId: string) => {
    document.getElementById(`task-${taskId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming?.text]);

  const currentRoom = rooms.find((r) => r.id === currentRoomId);
  const roomAgents = useMemo(
    () => (currentRoom?.agentIds ?? []).map((id) => agents.find((a) => a.id === id)).filter((a): a is Agent => !!a),
    [currentRoom, agents],
  );

  // 时间线：轮次变化处插分隔线
  const timeline: Array<{ kind: "divider"; round: number; key: string } | { kind: "message"; m: StoredMessage }> = [];
  let lastRound: number | undefined;
  let lastTask: string | undefined;
  for (const m of messages) {
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
    <div className="flex h-[calc(100vh-53px)]">
      <aside className="w-56 shrink-0 space-y-2 overflow-y-auto border-r border-neutral-200 bg-white p-3">
        <button
          className="w-full rounded border border-neutral-300 px-2 py-1.5 text-sm hover:bg-neutral-100"
          onClick={() => setCreating(true)}
        >
          {t("new_room")}
        </button>
        {creating && <NewRoomForm onDone={() => setCreating(false)} />}
        {activeRooms.map(roomRow)}
        {archivedRooms.length > 0 && (
          <div className="pt-2">
            <button
              className="w-full px-2 text-left text-xs text-neutral-400 hover:text-neutral-600"
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? "▾" : "▸"} {t("archived_section", { n: archivedRooms.length })}
            </button>
            {showArchived && <div className="mt-1 space-y-1">{archivedRooms.map(roomRow)}</div>}
          </div>
        )}
      </aside>
      {menu && <RoomContextMenu menu={menu} onClose={() => setMenu(null)} />}
      {showMembers && currentRoom && (
        <RoomMembersDialog roomId={currentRoom.id} memberIds={currentRoom.agentIds} onClose={() => setShowMembers(false)} />
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        {currentRoomId ? (
          <>
            <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2">
              <span className="text-sm font-bold">{currentRoom?.name}</span>
              <div className="flex items-center gap-2">
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
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {timeline.map((item) =>
                item.kind === "divider" ? (
                  <RoundDivider key={item.key} round={item.round} />
                ) : (
                  <Bubble key={item.m.id} m={item.m} />
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
