import type {
  CollaborationRuntimeCapabilities,
  ExecutionStrategy,
  TaskState,
} from "@socrates/core";

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
