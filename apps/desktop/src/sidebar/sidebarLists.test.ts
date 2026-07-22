import { describe, expect, it } from "bun:test";
import { chatRooms, coworkGroups, searchSidebar, type SidebarRoom } from "./sidebarLists";
import { isSegmentKey, nextSegment } from "./segmented";

const chat = (id: string, name: string, archived = false): SidebarRoom => ({
  id,
  name,
  kind: "chat",
  workspaceId: null,
  archived,
});
const cowork = (id: string, name: string, workspaceId: string, archived = false): SidebarRoom => ({
  id,
  name,
  kind: "cowork",
  workspaceId,
  archived,
});
const wsRec = (id: string, label: string, path?: string, archived = false) => ({ id, label, path, archived });

const rooms = [
  chat("c1", "论文讨论"),
  chat("c2", "闲聊"),
  chat("c3", "旧的", true),
  cowork("k1", "重构编排", "w1"),
  cowork("k2", "修 bug", "w2"),
  cowork("k3", "归档的", "w1", true),
];
const workspaces = [wsRec("w1", "Socrates", "/Users/me/Socrates"), wsRec("w2", "Website", "/srv/web")];

describe("mode filtering keeps the two lists disjoint", () => {
  it("chat list contains only live chat rooms", () => {
    expect(chatRooms(rooms).map((r) => r.id)).toEqual(["c1", "c2"]);
  });

  it("no cowork room ever appears in the chat list", () => {
    expect(chatRooms(rooms).every((room) => room.kind === "chat")).toBeTrue();
  });

  it("cowork tree groups rooms under their own workspace only", () => {
    const groups = coworkGroups(rooms, workspaces);
    expect(groups.map((g) => [g.workspace.id, g.rooms.map((r) => r.id)])).toEqual([
      ["w1", ["k1"]],
      ["w2", ["k2"]],
    ]);
  });

  it("no chat room is ever placed inside the workspace tree", () => {
    const all = coworkGroups(rooms, workspaces).flatMap((g) => g.rooms);
    expect(all.every((room) => room.kind === "cowork")).toBeTrue();
  });

  it("archived workspaces and rooms are excluded", () => {
    const groups = coworkGroups(rooms, [...workspaces, wsRec("w9", "Old", "/old", true)]);
    expect(groups.map((g) => g.workspace.id)).toEqual(["w1", "w2"]);
    expect(groups.flatMap((g) => g.rooms).some((r) => r.id === "k3")).toBeFalse();
  });
});

describe("search is scoped by top-level mode", () => {
  const data = { rooms, workspaces, memberNamesByRoom: { c1: ["紫镜狐狸"], k1: ["月面记录官"] } };

  it("chat mode searches chat room names and member names only", () => {
    expect(searchSidebar("论文", "chat", data)).toEqual([{ kind: "room", room: rooms[0] }]);
    expect(searchSidebar("紫镜", "chat", data)).toEqual([{ kind: "room", room: rooms[0] }]);
    // cowork 房间不会出现在 chat 搜索结果里
    expect(searchSidebar("重构", "chat", data)).toEqual([]);
  });

  it("cowork mode searches workspace label, workspace path and cowork rooms", () => {
    expect(searchSidebar("重构", "cowork", data).map((h) => (h.kind === "room" ? h.room.id : h.workspaceId))).toEqual([
      "k1",
    ]);
    expect(searchSidebar("Socrates", "cowork", data).map((h) => (h.kind === "workspace" ? h.workspaceId : ""))).toEqual([
      "w1",
    ]);
    expect(searchSidebar("/srv", "cowork", data).map((h) => (h.kind === "workspace" ? h.workspaceId : ""))).toEqual([
      "w2",
    ]);
    // chat 房间不会出现在 cowork 搜索结果里
    expect(searchSidebar("闲聊", "cowork", data)).toEqual([]);
  });

  it("an empty query clears results rather than listing everything", () => {
    expect(searchSidebar("", "chat", data)).toEqual([]);
    expect(searchSidebar("   ", "cowork", data)).toEqual([]);
  });

  it("search never mutates the underlying data", () => {
    const before = JSON.stringify(data);
    searchSidebar("a", "chat", data);
    searchSidebar("a", "cowork", data);
    expect(JSON.stringify(data)).toBe(before);
  });
});

describe("segmented control keyboard navigation", () => {
  const options = ["chat", "cowork"] as const;

  it("arrow keys move between segments and wrap", () => {
    expect(nextSegment(options, "chat", "ArrowRight")).toBe("cowork");
    expect(nextSegment(options, "cowork", "ArrowLeft")).toBe("chat");
    expect(nextSegment(options, "cowork", "ArrowRight")).toBe("chat"); // wrap
    expect(nextSegment(options, "chat", "ArrowLeft")).toBe("cowork"); // wrap
  });

  it("Home/End jump to the ends and unrelated keys are ignored", () => {
    expect(nextSegment(options, "cowork", "Home")).toBe("chat");
    expect(nextSegment(options, "chat", "End")).toBe("cowork");
    expect(nextSegment(options, "chat", "a")).toBe("chat");
    expect(nextSegment(options, "chat", "Enter")).toBe("chat"); // Enter 由 button 语义处理
  });

  it("recognises only the keys it handles", () => {
    expect(isSegmentKey("ArrowLeft")).toBeTrue();
    expect(isSegmentKey("End")).toBeTrue();
    expect(isSegmentKey("Enter")).toBeFalse();
  });
});
