import { describe, expect, it } from "bun:test";
import { roomCreatePayload, roomDraftBlocker, toggleRoomAgentSelection } from "./roomSelection";

const draft = (over: Partial<Parameters<typeof roomDraftBlocker>[0]> = {}) => ({
  kind: "chat" as const, title: "t", agentIds: ["a"], workspaceId: null, ...over,
});

describe("room draft", () => {
  it("both kinds accept 1..N members", () => {
    expect(roomDraftBlocker(draft({ agentIds: ["a", "b", "c"] }))).toBeNull();
    expect(roomDraftBlocker(draft({ kind: "cowork", agentIds: ["a"], workspaceId: "w" }))).toBeNull();
    expect(roomDraftBlocker(draft({ kind: "cowork", agentIds: ["a", "b"], workspaceId: "w" }))).toBeNull();
  });

  it("blocks an empty room and a workspace-less co-work room", () => {
    expect(roomDraftBlocker(draft({ agentIds: [] }))).toBe("room_requires_member");
    expect(roomDraftBlocker(draft({ kind: "cowork", workspaceId: null }))).toBe("cowork_room_requires_workspace");
  });

  it("chat never needs a workspace", () => {
    expect(roomDraftBlocker(draft({ workspaceId: null }))).toBeNull();
  });
});

describe("create payload", () => {
  it("sends workspaceId: null explicitly for chat, even if one was picked", () => {
    const payload = roomCreatePayload(draft({ workspaceId: "w" }));
    expect(payload.workspaceId).toBeNull();
    expect("workspaceId" in payload).toBeTrue();
    expect(payload.mode).toBe("chat");
  });

  it("derives co-work runtime mode from member count", () => {
    expect(roomCreatePayload(draft({ kind: "cowork", agentIds: ["a"], workspaceId: "w" })).mode).toBe("single_agent");
    expect(roomCreatePayload(draft({ kind: "cowork", agentIds: ["a", "b"], workspaceId: "w" })).mode).toBe("multi_agent");
  });

  it("keeps the explicitly chosen co-work workspace", () => {
    expect(roomCreatePayload(draft({ kind: "cowork", workspaceId: "w2" })).workspaceId).toBe("w2");
  });
});

describe("member toggle", () => {
  it("adds then removes", () => {
    expect(toggleRoomAgentSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleRoomAgentSelection(["a", "b"], "a")).toEqual(["b"]);
  });
});
