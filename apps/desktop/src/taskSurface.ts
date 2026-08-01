import type { RoomCollaborationSettings, TaskState } from "@socrates/core";

export type TaskSurfaceSession = {
  primaryAgentId: string;
  agents: Array<{ agentId: string }>;
  collaboration: RoomCollaborationSettings;
};

export type RoomDerivedTaskConfig = {
  speakingOrder: string[];
  maxRounds: number;
  synthesizerId: string;
  executionAgentId: string;
};

export function deriveRoomTaskConfig(session: TaskSurfaceSession): RoomDerivedTaskConfig {
  const memberIds = session.agents.map((agent) => agent.agentId);
  const members = new Set(memberIds);
  const configuredOrder = session.collaboration.discussion.speakerOrder.filter(
    (id, index, order) => members.has(id) && order.indexOf(id) === index,
  );
  const speakingOrder = configuredOrder.length >= 2 ? configuredOrder : memberIds;
  const candidates = [
    session.collaboration.discussion.summaryAgentId,
    session.collaboration.assignment.coordinatorAgentId,
    session.primaryAgentId,
    memberIds[0],
  ];
  const synthesizerId = candidates.find((id): id is string => Boolean(id && members.has(id)));
  if (!synthesizerId || !members.has(session.primaryAgentId)) {
    throw new Error("room_task_assignment_invalid");
  }
  return {
    speakingOrder,
    maxRounds: session.collaboration.discussion.enabled
      ? session.collaboration.discussion.maxRounds
      : 1,
    synthesizerId,
    executionAgentId: session.primaryAgentId,
  };
}

export function taskStatusKey(state: TaskState | null): string {
  if (!state) return "task_status_idle";
  if (state === "awaiting_plan_approval" || state === "awaiting_tool_approval") {
    return "task_status_awaiting_confirmation";
  }
  if (state === "paused") return "task_status_paused";
  if (state === "failed") return "task_status_failed";
  if (state === "cancelled") return "task_status_cancelled";
  if (state === "completed") return "task_status_completed";
  return "task_status_running";
}
