import { describe, expect, it } from "bun:test";
import {
  AGENT_AVATARS,
  agentIdentityFromSeed,
  agentLabel,
  encodeSseEvent,
  historyToChatMessages,
  parseSseChunk,
  randomAgentIdentity,
  randomUniqueAgentIdentity,
  normalizeAgentNickname,
  isAgentAvatarSource,
  isGeneratedAgentAvatar,
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
  it("retains Hono event IDs written after data, across arbitrary chunk boundaries", () => {
    const wire = 'event: runtime.event\ndata: {"type":"delta","text":"x"}\nid: 7\n\n';
    for (let cut = 1; cut < wire.length; cut++) {
      const first = parseSseChunk(wire.slice(0, cut));
      const second = parseSseChunk(first.rest + wire.slice(cut));
      expect([...first.events, ...second.events]).toEqual([{ type: "delta", text: "x", _sseId: "7" }]);
    }
  });
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
  it("assigns a generated avatar and formats the model label", () => {
    const identity = randomAgentIdentity(() => 0.51);
    expect(isGeneratedAgentAvatar(identity.avatar)).toBe(true);
    expect(agentLabel({ ...identity, modelId: "gpt-5.4" })).toBe(`${identity.nickname} (gpt-5.4)`);
    expect(agentIdentityFromSeed("agent-1")).toEqual(agentIdentityFromSeed("agent-1"));
  });

  it("normalizes nicknames and chooses an unused random identity", () => {
    expect(normalizeAgentNickname("  Ａlice\nSmith  ")).toBe("alice smith");
    const first = randomAgentIdentity(() => 0);
    const unique = randomUniqueAgentIdentity([first.nickname], () => 0);
    expect(normalizeAgentNickname(unique.nickname)).not.toBe(normalizeAgentNickname(first.nickname));
  });

  it("accepts bundled and common uploaded avatars but rejects unsafe data URLs", () => {
    expect(isAgentAvatarSource(AGENT_AVATARS[0])).toBe(true);
    expect(isAgentAvatarSource("data:image/png;base64,iVBORw0KGgo=")).toBe(true);
    expect(isAgentAvatarSource("data:image/svg+xml;base64,PHN2Zz4=")).toBe(false);
    expect(isAgentAvatarSource("data:text/html;base64,PGgxPng8L2gxPg==")).toBe(false);
  });
});
