import { describe, expect, it } from "bun:test";
import {
  DEFAULT_COLLABORATION_SETTINGS,
  isRoomKind,
  resolveRoomRuntime,
  reviewerConflictsWithExecutor,
  validateRoomShape,
  type RoomShape,
} from "./room-kind";

const chat = (agentIds: string[] = ["a"]): RoomShape => ({
  kind: "chat",
  workspaceId: null,
  agentIds,
});
const cowork = (agentIds: string[] = ["a"]): RoomShape => ({
  kind: "cowork",
  workspaceId: "ws1",
  agentIds,
});

describe("validateRoomShape", () => {
  it("chat must not bind a workspace; cowork must have one", () => {
    expect(validateRoomShape(chat())).toEqual([]);
    expect(validateRoomShape({ kind: "chat", workspaceId: "ws1", agentIds: ["a"] }))
      .toContain("chat_room_must_not_bind_workspace");
    expect(validateRoomShape(cowork())).toEqual([]);
    expect(validateRoomShape({ kind: "cowork", workspaceId: null, agentIds: ["a"] }))
      .toContain("cowork_room_requires_workspace");
  });

  it("both kinds accept unique members and reject empty or duplicated rosters", () => {
    expect(validateRoomShape(chat(["a", "b", "c"]))).toEqual([]);
    expect(validateRoomShape(cowork(["a", "b", "c"]))).toEqual([]);
    expect(validateRoomShape(chat([]))).toContain("room_requires_at_least_one_member");
    expect(validateRoomShape(chat(["a", "a"]))).toContain("room_members_must_be_unique");
  });
});

describe("resolveRoomRuntime", () => {
  it("resolves by room kind, strategy, and member count", () => {
    expect(resolveRoomRuntime(chat(["a"]), DEFAULT_COLLABORATION_SETTINGS)).toBe("single_chat");
    expect(resolveRoomRuntime(chat(["a", "b"]), DEFAULT_COLLABORATION_SETTINGS)).toBe("multi_chat");
    expect(resolveRoomRuntime(cowork(["a", "b"]), DEFAULT_COLLABORATION_SETTINGS)).toBe("single_agent");
    expect(resolveRoomRuntime(
      cowork(["a", "b"]),
      { ...DEFAULT_COLLABORATION_SETTINGS, strategy: "team" },
    )).toBe("multi_agent");
  });
});

describe("room collaboration helpers", () => {
  it("detects reviewer/executor conflicts", () => {
    expect(reviewerConflictsWithExecutor("a", "a")).toBeTrue();
    expect(reviewerConflictsWithExecutor("a", "b")).toBeFalse();
    expect(reviewerConflictsWithExecutor(null, "a")).toBeFalse();
  });

  it("accepts only the two persisted top-level room kinds", () => {
    expect(isRoomKind("chat")).toBeTrue();
    expect(isRoomKind("cowork")).toBeTrue();
    expect(isRoomKind("single_agent")).toBeFalse();
    expect(isRoomKind("multi_agent")).toBeFalse();
  });
});
