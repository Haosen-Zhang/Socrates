import { baselineMigration } from "./001_baseline";
import { agentWorkspaceMigration } from "./002_agent_workspace";
import { runtimeFoundationMigration } from "./003_runtime_foundation";
import { p2ConversationMigration } from "./004_p2_conversations";

export const migrations = [baselineMigration, agentWorkspaceMigration, runtimeFoundationMigration, p2ConversationMigration] as const;
