import type { Database } from "bun:sqlite";
import {
  validateMcpServerInput,
  type McpConnectionState,
  type McpServerInput,
  type McpServerRecord,
  type McpTransportConfig,
  type ToolRisk,
} from "@socrates/core";
import type { SecretStore } from "../secrets";

type McpRow = {
  id: string; name: string; scope: McpServerRecord["scope"]; workspace_id: string | null;
  transport: McpTransportConfig["transport"]; config_json: string; secret_refs_json: string;
  enabled: number; state: McpConnectionState; generation: number; last_error: string | null;
  created_at: string; updated_at: string;
};

const toRecord = (row: McpRow): McpServerRecord => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  workspaceId: row.workspace_id,
  config: JSON.parse(row.config_json),
  enabled: row.enabled === 1,
  state: row.state,
  generation: row.generation,
  lastError: row.last_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class McpStore {
  constructor(private readonly db: Database, private readonly secrets: SecretStore) {}

  list(workspaceId?: string | null): McpServerRecord[] {
    const rows = workspaceId
      ? this.db.query<McpRow, [string]>("SELECT * FROM mcp_servers WHERE scope = 'global' OR workspace_id = ? ORDER BY name").all(workspaceId)
      : this.db.query<McpRow, []>("SELECT * FROM mcp_servers WHERE scope = 'global' ORDER BY name").all();
    return rows.map(toRecord);
  }

  listAll(): McpServerRecord[] {
    return this.db.query<McpRow, []>("SELECT * FROM mcp_servers ORDER BY name").all().map(toRecord);
  }

  get(id: string): McpServerRecord | null {
    const row = this.db.query<McpRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id);
    return row ? toRecord(row) : null;
  }

  create(input: McpServerInput, secretValues: Record<string, string> = {}): McpServerRecord {
    const errors = validateMcpServerInput(input);
    if (errors.length) throw new Error(errors[0]);
    this.assertNameAvailable(input);
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const refs = this.storeSecrets(id, input.config, secretValues);
    try {
      this.db.query(`
        INSERT INTO mcp_servers
        (id, name, scope, workspace_id, transport, config_json, secret_refs_json, enabled, state, generation, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'disabled', 0, ?, ?)
      `).run(id, input.name, input.scope, input.workspaceId ?? null, input.config.transport, JSON.stringify(input.config), JSON.stringify(refs), now, now);
    } catch (error) {
      Object.values(refs).forEach((ref) => this.secrets.delete(ref));
      if (String(error).includes("UNIQUE")) throw new Error("mcp_server_name_conflict");
      throw error;
    }
    return this.get(id)!;
  }

  update(id: string, input: McpServerInput, secretValues: Record<string, string> = {}): McpServerRecord {
    const current = this.getRow(id);
    if (!current) throw new Error("mcp_server_not_found");
    const errors = validateMcpServerInput(input);
    if (errors.length) throw new Error(errors[0]);
    this.assertNameAvailable(input, id);
    const oldRefs = JSON.parse(current.secret_refs_json) as Record<string, string>;
    const refs = this.storeSecrets(id, input.config, secretValues, oldRefs);
    const now = new Date().toISOString();
    try {
      this.db.query(`
        UPDATE mcp_servers SET name = ?, scope = ?, workspace_id = ?, transport = ?, config_json = ?,
          secret_refs_json = ?, state = CASE WHEN enabled = 1 THEN 'disconnected' ELSE 'disabled' END,
          last_error = NULL, updated_at = ? WHERE id = ?
      `).run(input.name, input.scope, input.workspaceId ?? null, input.config.transport, JSON.stringify(input.config), JSON.stringify(refs), now, id);
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("mcp_server_name_conflict");
      throw error;
    }
    for (const [key, ref] of Object.entries(oldRefs)) if (!refs[key]) this.secrets.delete(ref);
    return this.get(id)!;
  }

  setEnabled(id: string, enabled: boolean): McpServerRecord {
    if (!this.get(id)) throw new Error("mcp_server_not_found");
    this.db.query("UPDATE mcp_servers SET enabled = ?, state = ?, last_error = NULL, updated_at = ? WHERE id = ?")
      .run(enabled ? 1 : 0, enabled ? "disconnected" : "disabled", new Date().toISOString(), id);
    return this.get(id)!;
  }

  updateState(id: string, state: McpConnectionState, input: { generation?: number; error?: string | null } = {}): McpServerRecord {
    const current = this.get(id);
    if (!current) throw new Error("mcp_server_not_found");
    this.db.query("UPDATE mcp_servers SET state = ?, generation = ?, last_error = ?, updated_at = ? WHERE id = ?")
      .run(state, input.generation ?? current.generation, input.error ?? null, new Date().toISOString(), id);
    return this.get(id)!;
  }

  resolveSecrets(id: string): Record<string, string> {
    const row = this.getRow(id);
    if (!row) throw new Error("mcp_server_not_found");
    const refs = JSON.parse(row.secret_refs_json) as Record<string, string>;
    return Object.fromEntries(Object.entries(refs).flatMap(([key, ref]) => {
      const value = this.secrets.get(ref);
      return value === null ? [] : [[key, value]];
    }));
  }

  remove(id: string): void {
    const row = this.getRow(id);
    if (!row) throw new Error("mcp_server_not_found");
    const refs = JSON.parse(row.secret_refs_json) as Record<string, string>;
    this.db.query("DELETE FROM mcp_servers WHERE id = ?").run(id);
    Object.values(refs).forEach((ref) => this.secrets.delete(ref));
  }

  exportRedacted(workspaceId?: string | null): { servers: McpServerRecord[]; secrets: "redacted" } {
    return { servers: this.list(workspaceId), secrets: "redacted" };
  }

  diagnostics(id: string): {
    server: McpServerRecord;
    tools: { total: number; enabled: number; disabled: number };
    secretStatus: Record<string, "set" | "missing">;
  } {
    const server = this.get(id);
    const row = this.getRow(id);
    if (!server || !row) throw new Error("mcp_server_not_found");
    const tools = this.listTools(id);
    const refs = JSON.parse(row.secret_refs_json) as Record<string, string>;
    return {
      server,
      tools: { total: tools.length, enabled: tools.filter((tool) => tool.enabled).length, disabled: tools.filter((tool) => !tool.enabled).length },
      secretStatus: Object.fromEntries(Object.entries(refs).map(([key, ref]) => [key, this.secrets.get(ref) === null ? "missing" : "set"])),
    };
  }

  listTools(serverId: string): Array<{
    name: string; namespacedName: string; description: string; generation: number; risk: ToolRisk;
    enabled: boolean; effect: "allow" | "ask" | "deny"; riskOverride: ToolRisk | null;
  }> {
    return this.db.query<{
      tool_name: string; namespaced_name: string; description: string; generation: number; risk: string;
      enabled: number; effect: "allow" | "ask" | "deny" | null; risk_override: string | null;
    }, [string]>(`
      SELECT snapshot.tool_name, snapshot.namespaced_name, snapshot.description, snapshot.generation,
        snapshot.risk, snapshot.enabled, policy.effect, policy.risk_override
      FROM mcp_tool_snapshots snapshot
      JOIN mcp_servers server ON server.id = snapshot.server_id AND server.generation = snapshot.generation
      LEFT JOIN mcp_tool_policies policy ON policy.server_id = snapshot.server_id AND policy.tool_name = snapshot.tool_name
      WHERE snapshot.server_id = ? ORDER BY snapshot.tool_name
    `).all(serverId).map((row) => ({
      name: row.tool_name, namespacedName: row.namespaced_name, description: row.description,
      generation: row.generation, risk: row.risk as ToolRisk, enabled: row.enabled === 1,
      effect: row.effect ?? "ask", riskOverride: row.risk_override as ToolRisk | null,
    }));
  }

  listCatalog(serverId: string): Array<{ kind: string; name: string; uri: string; description: string | null; mimeType: string | null; trust: "untrusted" }> {
    return this.db.query<{
      kind: string; name: string; uri: string; description: string | null; mime_type: string | null; trust: "untrusted";
    }, [string]>(`
      SELECT catalog.kind, catalog.name, catalog.uri, catalog.description, catalog.mime_type, catalog.trust
      FROM mcp_catalog_snapshots catalog
      JOIN mcp_servers server ON server.id = catalog.server_id AND server.generation = catalog.generation
      WHERE catalog.server_id = ? ORDER BY catalog.kind, catalog.name
    `).all(serverId).map((row) => ({
      kind: row.kind, name: row.name, uri: row.uri, description: row.description,
      mimeType: row.mime_type, trust: row.trust,
    }));
  }

  setToolPolicy(serverId: string, toolName: string, input: { effect: "allow" | "ask" | "deny"; riskOverride?: ToolRisk | null }): void {
    if (!this.get(serverId)) throw new Error("mcp_server_not_found");
    if (!this.db.query("SELECT 1 FROM mcp_tool_snapshots WHERE server_id = ? AND tool_name = ? LIMIT 1").get(serverId, toolName)) {
      throw new Error("mcp_tool_not_found");
    }
    if (input.riskOverride != null && !["low", "medium", "high", "destructive"].includes(input.riskOverride)) throw new Error("mcp_risk_invalid");
    this.db.query(`
      INSERT INTO mcp_tool_policies (server_id, tool_name, effect, risk_override, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(server_id, tool_name) DO UPDATE SET effect = excluded.effect,
        risk_override = excluded.risk_override, updated_at = excluded.updated_at
    `).run(serverId, toolName, input.effect, input.riskOverride ?? null, new Date().toISOString());
  }

  private getRow(id: string): McpRow | null {
    return this.db.query<McpRow, [string]>("SELECT * FROM mcp_servers WHERE id = ?").get(id) ?? null;
  }

  private assertNameAvailable(input: McpServerInput, excludingId?: string): void {
    const existing = this.db.query<{ id: string }, [string, string, string]>(`
      SELECT id FROM mcp_servers WHERE scope = ? AND COALESCE(workspace_id, '') = COALESCE(?, '') AND name = ?
    `).get(input.scope, input.workspaceId ?? "", input.name);
    if (existing && existing.id !== excludingId) throw new Error("mcp_server_name_conflict");
  }

  private storeSecrets(
    id: string,
    config: McpTransportConfig,
    values: Record<string, string>,
    existing: Record<string, string> = {},
  ): Record<string, string> {
    const keys = config.transport === "stdio" ? config.envKeys : config.headerKeys;
    const refs: Record<string, string> = {};
    for (const key of keys) {
      const ref = existing[key] ?? `mcp:${id}:${config.transport}:${key}`;
      const value = values[key];
      if (typeof value === "string" && value.length) this.secrets.set(ref, value);
      refs[key] = ref;
    }
    return refs;
  }
}
