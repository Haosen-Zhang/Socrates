import { baselineMigration } from "./001_baseline";
import { agentWorkspaceMigration } from "./002_agent_workspace";
import { runtimeFoundationMigration } from "./003_runtime_foundation";

export const migrations = [baselineMigration, agentWorkspaceMigration, runtimeFoundationMigration] as const;
