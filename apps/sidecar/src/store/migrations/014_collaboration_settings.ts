import {
  normalizeCollaborationSettings,
  resolveCollaborationDefaults,
} from "@socrates/core";
import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const collaborationSettingsMigration: Migration = {
  version: 14,
  name: "collaboration_settings_v2",
  checksum: migrationChecksum("014:collaboration-settings:v2:strategy-assignment-discussion-plan-confirmation"),
  up(db) {
    const rows = db.query<{
      id: string;
      workspace_id: string | null;
      primary_agent_id: string | null;
      collaboration_json: string | null;
    }, []>(
      `SELECT id, workspace_id, primary_agent_id, collaboration_json
       FROM sessions WHERE kind = 'cowork'`,
    ).all();
    const update = db.query("UPDATE sessions SET collaboration_json = ? WHERE id = ?");
    for (const row of rows) {
      let raw: unknown = null;
      try {
        raw = row.collaboration_json ? JSON.parse(row.collaboration_json) : null;
      } catch {
        raw = null;
      }
      const agentIds = db.query<{ agent_id: string }, [string]>(
        `SELECT agent_id FROM session_agents
         WHERE session_id = ? ORDER BY position`,
      ).all(row.id).map((agent) => agent.agent_id);
      const primaryAgentId = row.primary_agent_id && agentIds.includes(row.primary_agent_id)
        ? row.primary_agent_id
        : agentIds[0];
      const normalized = normalizeCollaborationSettings(raw);
      const resolved = primaryAgentId
        ? resolveCollaborationDefaults(
            normalized,
            {
              kind: "cowork",
              workspaceId: row.workspace_id,
              agentIds,
              primaryAgentId,
            },
            primaryAgentId,
          )
        : normalized;
      update.run(JSON.stringify(resolved), row.id);
    }
  },
};
