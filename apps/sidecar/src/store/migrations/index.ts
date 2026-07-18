import { baselineMigration } from "./001_baseline";
import { agentWorkspaceMigration } from "./002_agent_workspace";
import { runtimeFoundationMigration } from "./003_runtime_foundation";
import { p2ConversationMigration } from "./004_p2_conversations";
import { mcpMigration } from "./005_mcp";
import { multiAgentMigration } from "./006_multi_agent";
import { usageAndRecoveryMigration } from "./007_usage_and_recovery";
import { projectConversationOrganizationMigration } from "./008_project_conversation_organization";

export const migrations = [baselineMigration, agentWorkspaceMigration, runtimeFoundationMigration, p2ConversationMigration, mcpMigration, multiAgentMigration, usageAndRecoveryMigration, projectConversationOrganizationMigration] as const;
