import { useEffect, useMemo, useRef, useState } from "react";
import type { Agent, StoredMessage, TaskSummary } from "@socrates/core";
import { useStore, type StreamingTurn } from "./store";

const STATUS_BADGE: Record<TaskSummary["status"], [string, string]> = {
  running: ["进行中", "bg-blue-100 text-blue-800"],
  completed: ["已完成", "bg-green-100 text-green-800"],
  failed: ["失败", "bg-red-100 text-red-800"],
  cancelled: ["已取消", "bg-neutral-200 text-neutral-600"],
};

/** 历史任务面板：时间、模式、状态、token 合计；点击定位到时间线中的回放位置 */
function TaskHistoryPanel({ onJump }: { onJump: (taskId: string) => void }) {
  const { tasks } = useStore();
  if (tasks.length === 0) {
    return <p className="border-b border-neutral-200 bg-white px-4 py-2 text-xs text-neutral-500">还没有讨论任务。</p>;
  }
  return (
    <ul className="max-h-56 divide-y divide-neutral-100 overflow-y-auto border-b border-neutral-200 bg-white">
      {tasks.map((t) => {
        const [text, cls] = STATUS_BADGE[t.status];
        return (
          <li
            key={t.id}
            className="flex cursor-pointer items-center gap-2 px-4 py-2 text-sm hover:bg-neutral-50"
            onClick={() => onJump(t.id)}
          >
            <span className="shrink-0 text-xs text-neutral-400">
              {new Date(t.createdAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="shrink-0 rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600">
              {t.mode === "debate" ? "辩论" : "轮流"}
            </span>
            <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${cls}`} title={t.error}>
              {text}
            </span>
            <span className="min-w-0 flex-1 truncate">{t.prompt}</span>
            <span className="shrink-0 text-[10px] text-neutral-400">
              ↑{t.inputTokens} ↓{t.outputTokens}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

const DUTY_BADGE: Record<string, [string, string]> = {
  propose: ["提案", "bg-blue-100 text-blue-800"],
  critique: ["质疑", "bg-red-100 text-red-800"],
  synthesize: ["综合", "bg-purple-100 text-purple-800"],
  judge: ["裁决", "bg-amber-100 text-amber-800"],
  summarize: ["最终总结", "bg-amber-100 text-amber-800"],
};

function AgentHeader({ name, model, duty }: { name?: string; model?: string; duty?: string }) {
  const badge = duty ? DUTY_BADGE[duty] : undefined;
  return (
    <div className="mb-0.5 text-xs text-neutral-500">
      {name} · {model}
      {badge && (
        <span className={`ml-2 rounded px-1.5 py-0.5 text-[10px] font-medium ${badge[1]}`}>{badge[0]}</span>
      )}
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
        <AgentHeader name={m.agentName} model={m.model} duty={m.duty ?? (isSummary ? "summarize" : undefined)} />
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
  return (
    <div className="flex items-center gap-3 py-1">
      <div className="h-px flex-1 bg-neutral-200" />
      <span className="text-xs text-neutral-400">第 {round} 轮</span>
      <div className="h-px flex-1 bg-neutral-200" />
    </div>
  );
}

function StreamingBubble({ s }: { s: StreamingTurn }) {
  return (
    <div className="flex justify-start">
      <div className={s.phase === "summary" ? "w-full max-w-[85%]" : "max-w-[70%]"}>
        <AgentHeader name={s.agentName} model={s.model} duty={s.duty ?? (s.phase === "summary" ? "summarize" : undefined)} />
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

/** 运行中任务的控制条：取消；turn 失败时给出 重试/跳过/终止 三选 */
function TaskControlBar() {
  const { activeTaskId, failedTurn, streaming, cancelTask, decideTurn } = useStore();
  if (!activeTaskId) return null;
  if (failedTurn) {
    return (
      <div className="mx-4 mb-2 flex items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        <span className="min-w-0 flex-1 truncate" title={failedTurn.message}>
          「{failedTurn.agentName}」发言失败：{failedTurn.message}
        </span>
        <button
          className="shrink-0 rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100"
          onClick={() => void decideTurn("retry")}
        >
          重试
        </button>
        <button
          className="shrink-0 rounded border border-amber-400 px-2 py-0.5 hover:bg-amber-100"
          onClick={() => void decideTurn("skip")}
        >
          跳过该 Agent
        </button>
        <button
          className="shrink-0 rounded border border-red-300 px-2 py-0.5 text-red-700 hover:bg-red-50"
          onClick={() => void decideTurn("abort")}
        >
          终止任务
        </button>
      </div>
    );
  }
  return (
    <div className="mx-4 mb-2 flex items-center justify-between rounded border border-neutral-200 bg-neutral-100 px-3 py-2 text-sm text-neutral-600">
      <span className="flex items-center gap-2">
        <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-green-600" />
        {streaming ? `「${streaming.agentName}」发言中…` : "讨论进行中…"}
      </span>
      <button
        className="rounded border border-neutral-300 bg-white px-2 py-0.5 hover:bg-neutral-50"
        onClick={() => void cancelTask()}
      >
        取消任务
      </button>
    </div>
  );
}

/** 发言顺序条目：勾选决定是否参与本次讨论，列表顺序即发言顺序 */
type OrderItem = { id: string; enabled: boolean };

/** 多 Agent 房间的任务发起表单：需求、参与者与发言顺序（拖拽）、轮数、最终总结者 */
function TaskComposer({ agents }: { agents: Agent[] }) {
  const { streaming, activeTaskId, sendTask } = useStore();
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
            <span className="text-neutral-500">模式</span>
            {(
              [
                ["round_robin", "轮流发言"],
                ["debate", "辩论"],
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
                  ["proposerId", "提案者"],
                  ["skepticId", "质疑者"],
                  ["synthesizerId", "综合者"],
                  ["judgeId", "裁决者"],
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
            <div className="mb-1 text-neutral-500">参与者与发言顺序（拖动排序）：</div>
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
            {speakingOrder.length === 0 && <p className="mt-1 text-xs text-red-600">至少勾选一位参与者</p>}
          </div>
          )}
          <div className="flex shrink-0 flex-col gap-2">
            <label className="flex items-center justify-between gap-1">
              <span className="text-neutral-500">轮数</span>
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
                <span className="text-neutral-500">总结者</span>
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
          title="发言顺序 / 轮数 / 总结者"
          onClick={() => setShowConfig((v) => !v)}
        >
          ⚙
        </button>
        <input
          className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
          placeholder={
            busy
              ? "讨论进行中…"
              : mode === "debate"
                ? `描述议题，四角色辩论 ${maxRounds} 轮后裁决`
                : `描述任务，${speakingOrder.length} 位 Agent 将讨论 ${maxRounds} 轮`
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
          {mode === "debate" ? "发起辩论" : "发起讨论"}
        </button>
      </div>
    </form>
  );
}

function SimpleComposer() {
  const { streaming, sendMessage } = useStore();
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
        placeholder={streaming ? "回复中…" : "输入消息，回车发送"}
        value={draft}
        disabled={!!streaming}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-40"
        disabled={!!streaming || !draft.trim()}
        type="submit"
      >
        发送
      </button>
    </form>
  );
}

function NewRoomForm({ onDone }: { onDone: () => void }) {
  const { agents, createRoom } = useStore();
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
        placeholder="房间名"
        required
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <div className="max-h-32 space-y-1 overflow-y-auto">
        {agents.length === 0 && <p className="text-xs text-neutral-500">先到「设置」里创建 Agent</p>}
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
          创建
        </button>
        <button className="rounded border border-neutral-300 px-2 py-1 text-xs" type="button" onClick={onDone}>
          取消
        </button>
      </div>
    </form>
  );
}

export default function ChatPage() {
  const { rooms, agents, currentRoomId, messages, streaming, chatError, tasks, selectRoom, removeRoom, clearChatError } =
    useStore();
  const [creating, setCreating] = useState(false);
  const [showTasks, setShowTasks] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

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
          + 新建房间
        </button>
        {creating && <NewRoomForm onDone={() => setCreating(false)} />}
        {rooms.map((r) => (
          <div
            key={r.id}
            className={`group flex cursor-pointer items-center rounded px-2 py-1.5 text-sm ${
              r.id === currentRoomId ? "bg-neutral-900 text-white" : "hover:bg-neutral-100"
            }`}
            onClick={() => void selectRoom(r.id)}
          >
            <span className="min-w-0 flex-1 truncate">{r.name}</span>
            <span
              className={`ml-1 shrink-0 text-[10px] ${
                r.id === currentRoomId ? "text-neutral-400" : "text-neutral-300"
              }`}
            >
              {r.agentIds.length}人
            </span>
            <button
              className={`ml-1 hidden text-xs group-hover:block ${
                r.id === currentRoomId ? "text-neutral-300" : "text-neutral-400"
              }`}
              onClick={(e) => {
                e.stopPropagation();
                void removeRoom(r.id);
              }}
            >
              删
            </button>
          </div>
        ))}
      </aside>

      <section className="flex min-w-0 flex-1 flex-col">
        {currentRoomId ? (
          <>
            <div className="flex items-center justify-between border-b border-neutral-200 bg-white px-4 py-2">
              <span className="text-sm font-medium">{currentRoom?.name}</span>
              <button
                className={`rounded border px-2 py-0.5 text-xs ${
                  showTasks ? "border-neutral-900 bg-neutral-900 text-white" : "border-neutral-300 text-neutral-600 hover:bg-neutral-100"
                }`}
                onClick={() => setShowTasks((v) => !v)}
              >
                历史任务 {tasks.length}
              </button>
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
                  关闭
                </button>
              </div>
            )}
            {roomAgents.length > 1 ? <TaskComposer agents={roomAgents} /> : <SimpleComposer />}
          </>
        ) : (
          <p className="p-6 text-sm text-neutral-500">选择或新建一个房间开始讨论。</p>
        )}
      </section>
    </div>
  );
}
