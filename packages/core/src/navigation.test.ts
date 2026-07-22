import { describe, expect, it } from "bun:test";
import {
  isTargetValid,
  modeOfTarget,
  repairTarget,
  targetForMode,
  targetForRoom,
  workspaceOfTarget,
  type NavRoom,
  type NavWorkspace,
  type NavigationTarget,
} from "./navigation";

const chatRoom = (id: string, archived = false): NavRoom => ({ id, kind: "chat", workspaceId: null, archived });
const coworkRoom = (id: string, workspaceId: string | null, archived = false): NavRoom => ({
  id,
  kind: "cowork",
  workspaceId,
  archived,
});
const ws = (id: string, archived = false): NavWorkspace => ({ id, archived });

const data = (rooms: NavRoom[], workspaces: NavWorkspace[] = [ws("w1")]) => ({ rooms, workspaces });

describe("workspace derivation", () => {
  it("a chat target never derives a workspace", () => {
    expect(workspaceOfTarget({ kind: "chat_room", roomId: "c1" })).toBeNull();
    expect(workspaceOfTarget(null)).toBeNull();
  });

  it("a cowork target derives only its own persisted workspace", () => {
    expect(workspaceOfTarget({ kind: "cowork_room", roomId: "k1", workspaceId: "w1" })).toBe("w1");
    expect(workspaceOfTarget({ kind: "cowork_workspace", workspaceId: "w2" })).toBe("w2");
  });

  it("selecting a workspace cannot inject one into a chat target", () => {
    // 模拟「先看 workspace，再点开 Chat」——Chat 的派生 workspace 仍为 null
    const afterWorkspace: NavigationTarget = { kind: "cowork_workspace", workspaceId: "w1" };
    expect(workspaceOfTarget(afterWorkspace)).toBe("w1");
    const afterChat: NavigationTarget = { kind: "chat_room", roomId: "c1" };
    expect(workspaceOfTarget(afterChat)).toBeNull();
  });
});

describe("mode derivation", () => {
  it("mode follows the target, so the two can never disagree", () => {
    expect(modeOfTarget({ kind: "chat_room", roomId: "c1" })).toBe("chat");
    expect(modeOfTarget({ kind: "cowork_room", roomId: "k1", workspaceId: "w1" })).toBe("cowork");
    expect(modeOfTarget({ kind: "cowork_workspace", workspaceId: "w1" })).toBe("cowork");
  });
});

describe("targetForRoom", () => {
  it("builds a chat target without workspace and a cowork target from the room's own workspace", () => {
    expect(targetForRoom(chatRoom("c1"))).toEqual({ kind: "chat_room", roomId: "c1" });
    expect(targetForRoom(coworkRoom("k1", "w1"))).toEqual({ kind: "cowork_room", roomId: "k1", workspaceId: "w1" });
  });

  it("refuses to build a target for a cowork room missing its workspace (recovery required)", () => {
    expect(targetForRoom(coworkRoom("k1", null))).toBeNull();
  });
});

describe("isTargetValid", () => {
  const d = data([chatRoom("c1"), coworkRoom("k1", "w1")]);

  it("accepts well-formed targets", () => {
    expect(isTargetValid({ kind: "chat_room", roomId: "c1" }, d)).toBeTrue();
    expect(isTargetValid({ kind: "cowork_room", roomId: "k1", workspaceId: "w1" }, d)).toBeTrue();
    expect(isTargetValid({ kind: "cowork_workspace", workspaceId: "w1" }, d)).toBeTrue();
  });

  it("rejects kind mismatches and stale workspace bindings", () => {
    // 把 cowork 房间当 chat 打开
    expect(isTargetValid({ kind: "chat_room", roomId: "k1" }, d)).toBeFalse();
    // 把 chat 房间当 cowork 打开
    expect(isTargetValid({ kind: "cowork_room", roomId: "c1", workspaceId: "w1" }, d)).toBeFalse();
    // workspace 与房间实际绑定不符
    expect(isTargetValid({ kind: "cowork_room", roomId: "k1", workspaceId: "w9" }, d)).toBeFalse();
  });

  it("rejects missing or archived entities", () => {
    expect(isTargetValid({ kind: "chat_room", roomId: "gone" }, d)).toBeFalse();
    const archived = data([chatRoom("c1", true)], [ws("w1")]);
    expect(isTargetValid({ kind: "chat_room", roomId: "c1" }, archived)).toBeFalse();
    const archivedWs = data([coworkRoom("k1", "w1")], [ws("w1", true)]);
    expect(isTargetValid({ kind: "cowork_room", roomId: "k1", workspaceId: "w1" }, archivedWs)).toBeFalse();
  });
});

describe("repairTarget — restore and post-delete fallback", () => {
  it("keeps a valid target untouched", () => {
    const d = data([chatRoom("c1")]);
    const t: NavigationTarget = { kind: "chat_room", roomId: "c1" };
    expect(repairTarget(t, d)).toEqual(t);
  });

  it("falls back within the same mode after the current room is deleted", () => {
    const d = data([chatRoom("c2")]);
    expect(repairTarget({ kind: "chat_room", roomId: "deleted" }, d)).toEqual({ kind: "chat_room", roomId: "c2" });
  });

  it("falls back to the other mode when the preferred one is empty", () => {
    const d = data([coworkRoom("k1", "w1")]);
    expect(repairTarget({ kind: "chat_room", roomId: "deleted" }, d)).toEqual({
      kind: "cowork_room",
      roomId: "k1",
      workspaceId: "w1",
    });
  });

  it("never returns an illegal combination — a workspace-less cowork room is skipped", () => {
    const d = data([coworkRoom("broken", null), coworkRoom("k2", "w1")]);
    const repaired = repairTarget({ kind: "cowork_room", roomId: "broken", workspaceId: "w1" }, d);
    expect(repaired).toEqual({ kind: "cowork_room", roomId: "k2", workspaceId: "w1" });
  });

  it("falls back to a workspace overview when cowork has no usable room", () => {
    const d = data([coworkRoom("broken", null)], [ws("w1")]);
    expect(repairTarget({ kind: "cowork_workspace", workspaceId: "gone" }, d)).toEqual({
      kind: "cowork_workspace",
      workspaceId: "w1",
    });
  });

  it("returns null (empty state) when nothing legal exists", () => {
    expect(repairTarget({ kind: "chat_room", roomId: "x" }, data([], []))).toBeNull();
  });
});

describe("targetForMode — switching the segmented control", () => {
  const d = data([chatRoom("c1"), coworkRoom("k1", "w1")]);

  it("restores the remembered target of that mode", () => {
    const remembered: NavigationTarget = { kind: "cowork_room", roomId: "k1", workspaceId: "w1" };
    expect(targetForMode("cowork", d, remembered)).toEqual(remembered);
  });

  it("ignores a remembered target belonging to the other mode", () => {
    const rememberedChat: NavigationTarget = { kind: "chat_room", roomId: "c1" };
    expect(targetForMode("cowork", d, rememberedChat)).toEqual({
      kind: "cowork_room",
      roomId: "k1",
      workspaceId: "w1",
    });
  });

  it("switching modes never rewrites room kinds or workspace bindings", () => {
    const before = JSON.stringify(d);
    targetForMode("cowork", d, null);
    targetForMode("chat", d, null);
    expect(JSON.stringify(d)).toBe(before);
  });
});
