import {
  resolveCollaborationDefaults,
  type RoomCollaborationSettings,
  type RoomShape,
  type CollaborationRuntimeCapabilities,
  type ExecutionStrategy,
  type TaskState,
} from "@socrates/core";

/** Old Chat rooms can have empty discussion defaults until discussion is enabled. */
export function createCollaborationDraft(room: RoomShape & { primaryAgentId: string }, settings: RoomCollaborationSettings): RoomCollaborationSettings {
  return resolveCollaborationDefaults(settings, room, room.primaryAgentId);
}

const STRATEGIES: ExecutionStrategy[] = ["single", "adaptive", "team"];

export function collaborationStrategyOptions(
  capabilities: CollaborationRuntimeCapabilities | null | undefined,
): Array<{ strategy: ExecutionStrategy; enabled: boolean }> {
  return STRATEGIES.map((strategy) => ({
    strategy,
    enabled: capabilities?.supportedStrategies.includes(strategy) === true,
  }));
}

export function canEditCollaboration(state: TaskState | null | undefined): boolean {
  return !state || ["failed", "cancelled", "completed"].includes(state);
}
