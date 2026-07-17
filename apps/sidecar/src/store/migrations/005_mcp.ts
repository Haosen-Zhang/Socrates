import type { Migration } from "../migrations";
import { migrationChecksum } from "../migrations";

export const mcpMigration: Migration = {
  version: 5,
  name: "mcp_servers_and_tool_snapshots",
  checksum: migrationChecksum("005:mcp:v2:servers-tools-catalog-policies-owner-leases"),
  up(db) {
    db.exec(`
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL,
        workspace_id TEXT, transport TEXT NOT NULL, config_json TEXT NOT NULL,
        secret_refs_json TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'disabled', generation INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY (workspace_id) REFERENCES workspaces(id)
      );
      CREATE UNIQUE INDEX idx_mcp_servers_scope_name
        ON mcp_servers (scope, COALESCE(workspace_id, ''), name);
      CREATE TABLE mcp_tool_snapshots (
        server_id TEXT NOT NULL, generation INTEGER NOT NULL, tool_name TEXT NOT NULL,
        namespaced_name TEXT NOT NULL, description TEXT NOT NULL, input_schema_json TEXT NOT NULL,
        schema_hash TEXT NOT NULL, risk TEXT NOT NULL, enabled INTEGER NOT NULL,
        PRIMARY KEY (server_id, generation, tool_name),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_mcp_tool_snapshot_name ON mcp_tool_snapshots (namespaced_name, generation);
      CREATE TABLE mcp_catalog_snapshots (
        server_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL,
        name TEXT NOT NULL, uri TEXT NOT NULL DEFAULT '', description TEXT,
        mime_type TEXT, trust TEXT NOT NULL DEFAULT 'untrusted',
        PRIMARY KEY (server_id, generation, kind, name, uri),
        FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
      CREATE TABLE mcp_tool_policies (
        server_id TEXT NOT NULL, tool_name TEXT NOT NULL, effect TEXT NOT NULL DEFAULT 'ask',
        risk_override TEXT, updated_at TEXT NOT NULL,
        PRIMARY KEY (server_id, tool_name), FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
      CREATE TABLE mcp_owner_leases (
        task_id TEXT NOT NULL, server_id TEXT NOT NULL, owner_kind TEXT NOT NULL,
        owner_id TEXT NOT NULL, generation INTEGER NOT NULL, acquired_at TEXT NOT NULL,
        PRIMARY KEY (task_id, server_id), FOREIGN KEY (server_id) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
    `);
  },
};
