import type {
  CollaborationRuntimeCapabilities,
  ExecutionStrategy,
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
