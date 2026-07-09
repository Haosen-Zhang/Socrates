import { useEffect, useRef, useState } from "react";
import type { StoredMessage } from "@socrates/core";
import { useStore } from "./store";

function Bubble({ m }: { m: StoredMessage }) {
  if (m.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[70%] rounded-lg bg-neutral-900 px-3 py-2 text-sm whitespace-pre-wrap text-white">
          {m.content}
        </div>
      </div>
    );
  }
  return (
    <div className="flex justify-start">
      <div className="max-w-[70%]">
        <div className="mb-0.5 text-xs text-neutral-500">
          {m.agentName} · {m.model}
        </div>
        <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm whitespace-pre-wrap">
          {m.content}
        </div>
      </div>
    </div>
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
  const {
    rooms,
    currentRoomId,
    messages,
    streaming,
    chatError,
    selectRoom,
    removeRoom,
    sendMessage,
    clearChatError,
  } = useStore();
  const [draft, setDraft] = useState("");
  const [creating, setCreating] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, streaming?.text]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = draft.trim();
    if (!content) return;
    setDraft("");
    await sendMessage(content);
  };

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
            <button
              className={`hidden text-xs group-hover:block ${
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
            <div className="flex-1 space-y-3 overflow-y-auto p-4">
              {messages.map((m) => (
                <Bubble key={m.id} m={m} />
              ))}
              {streaming && (
                <div className="flex justify-start">
                  <div className="max-w-[70%]">
                    <div className="mb-0.5 text-xs text-neutral-500">
                      {streaming.agentName} · {streaming.model}
                    </div>
                    <div className="rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm whitespace-pre-wrap">
                      {streaming.text}
                      <span className="animate-pulse">▍</span>
                    </div>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
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
          </>
        ) : (
          <p className="p-6 text-sm text-neutral-500">选择或新建一个房间开始讨论。</p>
        )}
      </section>
    </div>
  );
}
