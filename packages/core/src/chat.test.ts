import { describe, expect, it } from "bun:test";
import {
  AGENT_AVATARS,
  agentIdentityFromSeed,
  agentLabel,
  encodeSseEvent,
  historyToChatMessages,
  parseSseChunk,
  randomAgentIdentity,
  type StoredMessage,
  type StreamEvent,
} from "./chat";

const msg = (over: Partial<StoredMessage>): StoredMessage => ({
  id: "m1",
  roomId: "r1",
  role: "user",
  content: "hi",
  createdAt: "2026-07-10T00:00:00Z",
  ...over,
});

describe("sse codec", () => {
  it("round-trips events through chunked buffers", () => {
    const events: StreamEvent[] = [
      { type: "turn_started", agentId: "a", agentName: "GPT", model: "gpt-5.4" },
      { type: "delta", text: "你好" },
      { type: "delta", text: "！\n\n换段" },
    ];
    const wire = events.map(encodeSseEvent).join("");
    // 任意切分点都不丢事件
    const cut = 17;
    const first = parseSseChunk(wire.slice(0, cut));
    const second = parseSseChunk(first.rest + wire.slice(cut));
    const all = [...first.events, ...second.events];
    expect(all).toEqual(events);
    expect(second.rest).toBe("");
  });

  it("ignores non-protocol noise lines", () => {
    const { events } = parseSseChunk("noise\ndata: {broken\n\ndata: {\"type\":\"delta\",\"text\":\"x\"}\n\n");
    expect(events).toEqual([{ type: "delta", text: "x" }]);
  });
});

describe("historyToChatMessages", () => {
  it("maps roles and drops empty messages", () => {
    const history = [
      msg({ role: "user", content: "问题" }),
      msg({ id: "m2", role: "agent", content: "回答", agentName: "DS" }),
      msg({ id: "m3", role: "agent", content: "" }),
    ];
    expect(historyToChatMessages(history)).toEqual([
      { role: "user", content: "问题" },
      { role: "assistant", content: "回答" },
    ]);
  });
});

describe("agent identity", () => {
  it("assigns a catalog avatar and formats the model label", () => {
    const identity = randomAgentIdentity(() => 0.51);
    expect(AGENT_AVATARS).toContain(identity.avatar);
    expect(agentLabel({ ...identity, modelId: "gpt-5.4" })).toBe(`${identity.nickname} (gpt-5.4)`);
    expect(agentIdentityFromSeed("agent-1")).toEqual(agentIdentityFromSeed("agent-1"));
  });
});
