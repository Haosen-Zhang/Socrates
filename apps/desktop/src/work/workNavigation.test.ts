import { describe, expect, it } from "bun:test";
import { activityStatusKey, nextWorkContext, projectRoomIds, visibleActivities } from "./workNavigation";

describe("Work navigation boundaries", () => {
  it("normalizes real lifecycle states while keeping undocumented statuses unknown", () => {
    expect(activityStatusKey("preparing")).toBe("task_status_running");
    expect(activityStatusKey("synthesizing")).toBe("task_status_running");
    expect(activityStatusKey("revising_plan")).toBe("task_status_running");
    expect(activityStatusKey("awaiting_approval")).toBe("task_status_awaiting_confirmation");
    expect(activityStatusKey("imaginary_success")).toBe("work_state_unknown");
  });
  it("does not mix Chat or another project's rooms into project activity", () => {
    expect(projectRoomIds([
      { id: "main", kind: "cowork", workspaceId: "project" },
      { id: "old", kind: "cowork", workspaceId: "project", archived: true },
      { id: "chat", kind: "chat", workspaceId: null },
      { id: "other", kind: "cowork", workspaceId: "elsewhere" },
    ], "project")).toEqual(["main", "old"]);
    expect(projectRoomIds([], null)).toEqual([]);
  });
  it("provides roving keyboard navigation without consuming IME candidate selection", () => {
    expect(nextWorkContext("rooms", "ArrowRight", false)).toBe("tasks");
    expect(nextWorkContext("tasks", "ArrowRight", false)).toBe("inbox");
    expect(nextWorkContext("inbox", "ArrowRight", false)).toBe("squads");
    expect(nextWorkContext("rooms", "ArrowLeft", false)).toBe("arena");
    expect(nextWorkContext("squads", "Home", false)).toBe("rooms");
    expect(nextWorkContext("tasks", "End", false)).toBe("arena");
    expect(nextWorkContext("rooms", "ArrowRight", true)).toBeNull();
    expect(nextWorkContext("rooms", "Enter", false)).toBeNull();
    expect(nextWorkContext("squads", "ArrowRight", false)).toBe("memory");
    expect(nextWorkContext("memory", "ArrowRight", false)).toBe("arena");
    expect(nextWorkContext("arena", "ArrowRight", false)).toBe("rooms");
  });
  it("searches only the fetched project facts and keeps waiting and terminal states distinct", () => {
    const rows = [
      { id: "1", prompt: "研究计划", roomId: "main", status: "awaiting_plan_approval" },
      { id: "2", prompt: "Report", roomId: "old", status: "completed" },
      { id: "3", prompt: "Research", roomId: "main", status: "failed" },
    ];
    expect(visibleActivities(rows, "研究", "all").map(row => row.id)).toEqual(["1"]);
    expect(visibleActivities(rows, "report", "all").map(row => row.id)).toEqual(["2"]);
    expect(visibleActivities(rows, "", "attention").map(row => row.id)).toEqual(["1", "3"]);
    expect(visibleActivities(rows, "", "completed").map(row => row.id)).toEqual(["2"]);
  });
});
