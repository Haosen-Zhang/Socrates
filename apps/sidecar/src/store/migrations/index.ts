import { baselineMigration } from "./001_baseline";
import { agentWorkspaceMigration } from "./002_agent_workspace";
import { runtimeFoundationMigration } from "./003_runtime_foundation";
import { p2ConversationMigration } from "./004_p2_conversations";
import { mcpMigration } from "./005_mcp";

export const migrations = [baselineMigration, agentWorkspaceMigration, runtimeFoundationMigration, p2ConversationMigration, mcpMigration] as const;
