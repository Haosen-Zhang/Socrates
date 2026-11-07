export type WorkContext = "rooms" | "tasks" | "squads";
export const WORK_CONTEXTS: readonly WorkContext[] = ["rooms", "tasks", "squads"];
export function activityStatusKey(status: string): string {
  if (["queued", "running", "dispatching", "preparing", "discussing", "synthesizing", "revising_plan", "executing", "planning", "reviewing", "summarizing", "waiting_workspace"].includes(status)) return "task_status_running";
  if (["awaiting_approval", "awaiting_plan_approval", "awaiting_tool_approval"].includes(status)) return "task_status_awaiting_confirmation";
  if (["paused", "interrupted"].includes(status)) return "task_status_paused";
  if (["idle", "failed", "cancelled", "completed"].includes(status)) return `task_status_${status}`;
  return "work_state_unknown";
}
export function nextWorkContext(current: WorkContext, key: string, composing: boolean): WorkContext | null {
  if (composing) return null;
  if (key === "Home") return "rooms";
  if (key === "End") return "squads";
  if (key !== "ArrowLeft" && key !== "ArrowRight") return null;
  return WORK_CONTEXTS[(WORK_CONTEXTS.indexOf(current) + (key === "ArrowRight" ? 1 : 2)) % 3]!;
}
export function projectRoomIds(rooms: readonly {id: string; kind: string; workspaceId: string|null; archived?: boolean}[], workspaceId: string|null): string[] {
  return workspaceId ? rooms.filter(room => room.kind === "cowork" && room.workspaceId === workspaceId).map(room => room.id) : [];
}
export type ActivityFilter = "all" | "attention" | "completed";
export function visibleActivities<T extends {prompt: string; roomId: string; status: string}>(rows: readonly T[], query: string, filter: ActivityFilter): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return rows.filter(row => (!needle || row.prompt.toLocaleLowerCase().includes(needle)) && (filter === "all"
    || filter === "completed" && row.status === "completed"
    || filter === "attention" && ["awaiting_plan_approval", "awaiting_tool_approval", "paused", "interrupted", "failed", "outcome_unknown", "awaiting_approval"].includes(row.status)));
}
