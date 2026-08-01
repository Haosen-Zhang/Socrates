import { describe, expect, it } from "bun:test";
import { searchSidebar, topLevelRooms, workspaceGroups, type SidebarRoom } from "./sidebarLists";

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

describe("one unified room navigation", () => {
  it("keeps live workspace-less rooms visible without a Chat mode", () => {
    expect(topLevelRooms(rooms, workspaces).map((room) => room.id)).toEqual(["c1", "c2"]);
  });

  it("keeps a room visible when its persisted workspace no longer exists", () => {
    const orphan = cowork("orphan", "待修复工作区", "missing-workspace");
    expect(topLevelRooms([...rooms, orphan], workspaces).map((room) => room.id)).toEqual(["c1", "c2", "orphan"]);
  });

  it("groups every live workspace-bound room under its persisted workspace", () => {
    expect(workspaceGroups(rooms, workspaces).map((group) => [group.workspace.id, group.rooms.map((room) => room.id)])).toEqual([
      ["w1", ["k1"]],
      ["w2", ["k2"]],
    ]);
  });

  it("projects every live room exactly once", () => {
    const ids = [
      ...topLevelRooms(rooms, workspaces).map((room) => room.id),
      ...workspaceGroups(rooms, workspaces).flatMap((group) => group.rooms.map((room) => room.id)),
    ];
    expect(ids).toEqual(["c1", "c2", "k1", "k2"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps an archived workspace visible while it owns a live room", () => {
    const archivedWorkspace = wsRec("wz", "Archived", "/z", true);
    const groups = workspaceGroups([...rooms, cowork("kz", "活着的房间", "wz")], [...workspaces, archivedWorkspace]);
    expect(groups.find((group) => group.workspace.id === "wz")?.rooms.map((room) => room.id)).toEqual(["kz"]);
  });
});

describe("unified sidebar search", () => {
  const data = { rooms, workspaces, memberNamesByRoom: { c1: ["紫镜狐狸"], k1: ["月面记录官"] } };

  it("searches room names and member nicknames across legacy and workspace rooms", () => {
    expect(searchSidebar("论文", data)).toEqual([{ kind: "room", room: rooms[0] }]);
    expect(searchSidebar("紫镜", data)).toEqual([{ kind: "room", room: rooms[0] }]);
    expect(searchSidebar("重构", data)).toEqual([{ kind: "room", room: rooms[3] }]);
    expect(searchSidebar("月面", data)).toEqual([{ kind: "room", room: rooms[3] }]);
  });

  it("searches workspace labels and paths", () => {
    expect(searchSidebar("Socrates", data)).toEqual([{ kind: "workspace", workspaceId: "w1", label: "Socrates" }]);
    expect(searchSidebar("/srv", data)).toEqual([{ kind: "workspace", workspaceId: "w2", label: "Website" }]);
  });

  it("excludes archived entities and leaves input data untouched", () => {
    const before = JSON.stringify(data);
    expect(searchSidebar("旧的", data)).toEqual([]);
    expect(searchSidebar("归档的", data)).toEqual([]);
    expect(searchSidebar("", data)).toEqual([]);
    expect(JSON.stringify(data)).toBe(before);
  });
});
