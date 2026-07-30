import { describe, expect, it } from "bun:test";
import {
  isOwnedManagedWorkspace,
  roomCreatePayload,
  roomDraftBlocker,
  toggleRoomAgentSelection,
} from "./roomSelection";

const draft = (over: Partial<Parameters<typeof roomDraftBlocker>[0]> = {}) => ({
  title: "t",
  agentIds: ["a"],
  primaryAgentId: "a",
  workspaceSelection: { kind: "managed" as const },
  ...over,
});

describe("room draft", () => {
  it("accepts 1..N members for one unified working-room shape", () => {
    expect(roomDraftBlocker(draft({ agentIds: ["a", "b", "c"] }))).toBeNull();
    expect(roomDraftBlocker(draft({
      agentIds: ["a", "b"],
      primaryAgentId: "b",
      workspaceSelection: { kind: "existing", workspaceId: "w" },
    }))).toBeNull();
  });

  it("blocks an empty room, an invalid primary Agent, and a missing existing workspace", () => {
    expect(roomDraftBlocker(draft({ agentIds: [] }))).toBe("room_requires_member");
    expect(roomDraftBlocker(draft({ primaryAgentId: null }))).toBe("room_requires_primary_agent");
    expect(roomDraftBlocker(draft({
      workspaceSelection: { kind: "existing", workspaceId: null },
    }))).toBe("room_requires_workspace");
  });
});

describe("create payload", () => {
  it("derives runtime mode from member count without exposing a room type", () => {
    expect(roomCreatePayload(draft()).mode).toBe("single_agent");
    expect(roomCreatePayload(draft({ agentIds: ["a", "b"], primaryAgentId: "b" })).mode).toBe("multi_agent");
    expect(roomCreatePayload(draft()).kind).toBe("cowork");
  });

  it("keeps the explicit managed or existing workspace choice", () => {
    expect(roomCreatePayload(draft()).workspaceSelection).toEqual({ kind: "managed" });
    expect(roomCreatePayload(draft({
      workspaceSelection: { kind: "existing", workspaceId: "w2" },
    })).workspaceSelection).toEqual({ kind: "existing", workspaceId: "w2" });
  });

  it("persists the explicit primary Agent independent of member order", () => {
    const payload = roomCreatePayload(draft({
      agentIds: ["second", "primary"],
      primaryAgentId: "primary",
    }));
    expect(payload.primaryAgentId).toBe("primary");
  });
});

describe("member toggle", () => {
  it("adds then removes", () => {
    expect(toggleRoomAgentSelection(["a"], "b")).toEqual(["a", "b"]);
    expect(toggleRoomAgentSelection(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("managed workspace ownership", () => {
  const workspace = {
    id: "w",
    canonicalPath: "/w",
    displayPath: "/w",
    identityHash: "hash",
    label: "w",
    ownership: "managed" as const,
    ownerSessionId: "room",
    archived: false,
    createdAt: "now",
    lastOpenedAt: "now",
  };
  it("requires both managed ownership and the matching room", () => {
    expect(isOwnedManagedWorkspace(workspace, "room")).toBe(true);
    expect(isOwnedManagedWorkspace(workspace, "other")).toBe(false);
    expect(isOwnedManagedWorkspace({ ...workspace, ownership: "external", ownerSessionId: null }, "room"))
      .toBe(false);
  });
});
