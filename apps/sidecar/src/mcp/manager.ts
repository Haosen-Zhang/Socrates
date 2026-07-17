import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  mcpToolName,
  validateMcpToolSchema,
  type JsonSchema,
  type ToolDefinition,
  type ToolRisk,
} from "@socrates/core";
import type { McpClientAdapter, McpConnection, McpDiscoveredTool } from "./adapter";
import type { McpStore } from "./store";
import { redactDiagnostic, redactObject } from "../security/redaction";

type ActiveConnection = { connection: McpConnection; generation: number; definitions: ToolDefinition[] };
type Timer = ReturnType<typeof setTimeout>;
type Scheduler = (callback: () => void, delay: number) => Timer;

function riskOf(tool: McpDiscoveredTool): ToolRisk {
  if (tool.annotations?.destructiveHint || tool.annotations?.openWorldHint) return "high";
  if (tool.annotations?.readOnlyHint) return "low";
  return "medium";
}

function errorCategory(error: unknown, exactSecrets: readonly string[] = []): { state: "needs_auth" | "failed"; message: string } {
  const message = redactDiagnostic(error, exactSecrets);
  return { state: /unauthor|forbidden|\b401\b|\b403\b/iu.test(message) ? "needs_auth" : "failed", message: message.slice(0, 500) };
}

export class McpManager {
  private readonly active = new Map<string, ActiveConnection>();
  private readonly attempts = new Map<string, number>();
  private readonly timers = new Map<string, Timer>();
  private readonly backoff = [1_000, 2_000, 5_000, 10_000, 30_000];

  constructor(
    private readonly db: Database,
    private readonly store: McpStore,
    private readonly adapter: McpClientAdapter,
    private readonly schedule: Scheduler = (callback, delay) => setTimeout(callback, delay),
    private readonly jitter: () => number = Math.random,
  ) {}

  async connect(id: string): Promise<void> {
    await this.disconnect(id, false);
    const server = this.store.get(id);
    if (!server) throw new Error("mcp_server_not_found");
    this.store.updateState(id, "connecting");
    let connection: McpConnection | null = null;
    const secrets = this.store.resolveSecrets(id);
    try {
      connection = await this.adapter.connect(server, secrets, (error) => this.connectionLost(id, error));
      const generation = server.generation + 1;
      const [discovered, catalog] = await Promise.all([connection.listTools(), connection.listCatalog()]);
      const definitions: ToolDefinition[] = [];
      this.db.transaction(() => {
        for (const item of catalog) {
          if (!item.name || item.name.length > 512 || (item.uri?.length ?? 0) > 4_096 || (item.description?.length ?? 0) > 16_384) {
            throw new Error("mcp_catalog_entry_invalid");
          }
          this.db.query(`
            INSERT INTO mcp_catalog_snapshots
            (server_id, generation, kind, name, uri, description, mime_type, trust)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'untrusted')
          `).run(server.id, generation, item.kind, item.name, item.uri ?? "", item.description ?? null, item.mimeType ?? null);
        }
        for (const tool of discovered) {
          const errors = validateMcpToolSchema(tool.inputSchema);
          const namespacedName = mcpToolName(server.name, tool.name);
          const schemaJson = JSON.stringify(tool.inputSchema);
          const schemaHash = createHash("sha256").update(schemaJson).digest("hex");
          const risk = riskOf(tool);
          const previous = this.db.query<{ schema_hash: string }, [string, string]>(`
            SELECT schema_hash FROM mcp_tool_snapshots WHERE server_id = ? AND tool_name = ? ORDER BY generation DESC LIMIT 1
          `).get(server.id, tool.name);
          if (previous && previous.schema_hash !== schemaHash) {
            this.db.query("DELETE FROM mcp_tool_policies WHERE server_id = ? AND tool_name = ?").run(server.id, tool.name);
          }
          this.db.query(`
            INSERT INTO mcp_tool_snapshots
            (server_id, generation, tool_name, namespaced_name, description, input_schema_json, schema_hash, risk, enabled)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(server.id, generation, tool.name, namespacedName, tool.description, schemaJson,
            schemaHash, risk, errors.length ? 0 : 1);
          if (errors.length) continue;
          definitions.push({
            name: namespacedName,
            description: tool.description,
            inputSchema: tool.inputSchema as JsonSchema,
            risk,
            idempotency: tool.annotations?.readOnlyHint ? "read" : "non_idempotent",
            capability: "mcp",
            generation,
            execute: async (input, context) => {
              const active = this.active.get(server.id);
              if (!active || active.generation !== generation) throw new Error("stale_mcp_generation");
              this.acquireOwner({
                taskId: context.taskId,
                serverId: server.id,
                ownerKind: "native",
                ownerId: `${context.sessionId}:${context.agentId}`,
                generation,
              });
              const result = await active.connection.callTool(tool.name, input, context.signal);
              return { source: `mcp:${server.name}`, trust: "untrusted", result: redactObject(result, Object.values(this.store.resolveSecrets(server.id))) };
            },
          });
        }
      })();
      this.active.set(id, { connection, generation, definitions });
      this.attempts.set(id, 0);
      this.store.updateState(id, definitions.length === discovered.length ? "connected" : "degraded", { generation });
    } catch (error) {
      await connection?.close().catch(() => {});
      const category = errorCategory(error, Object.values(secrets));
      this.store.updateState(id, category.state, { error: category.message });
      if (category.state !== "needs_auth") this.scheduleReconnect(id);
      throw new Error(category.message);
    }
  }

  async disconnect(id: string, persistState = true): Promise<void> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    const active = this.active.get(id);
    if (active) {
      if (persistState && this.store.get(id)) this.store.updateState(id, "stopping");
      this.active.delete(id);
      await active.connection.close();
    }
    const server = this.store.get(id);
    if (persistState && server) this.store.updateState(id, server.enabled ? "disconnected" : "disabled");
  }

  definitionsFor(workspaceId?: string | null, options: { effects?: Array<"allow" | "ask" | "deny"> } = {}): ToolDefinition[] {
    const visible = new Set(this.store.list(workspaceId).map((server) => server.id));
    return [...this.active.entries()].filter(([id]) => visible.has(id)).flatMap(([id, active]) => {
      const policies = new Map(this.store.listTools(id).map((tool) => [tool.namespacedName, tool]));
      return active.definitions.flatMap((definition) => {
        const policy = policies.get(definition.name);
        if (!policy || (options.effects && !options.effects.includes(policy.effect))) return [];
        const order: ToolRisk[] = ["low", "medium", "high", "destructive"];
        const effectiveRisk = policy.riskOverride && order.indexOf(policy.riskOverride) > order.indexOf(definition.risk)
          ? policy.riskOverride
          : definition.risk;
        return [{ ...definition, risk: effectiveRisk }];
      });
    });
  }

  policyEntriesFor(workspaceId?: string | null): Array<{ namespacedName: string; effect: "allow" | "ask" | "deny" }> {
    const visible = new Set(this.store.list(workspaceId).map((server) => server.id));
    return [...visible].flatMap((id) => this.store.listTools(id).map((tool) => ({
      namespacedName: tool.namespacedName,
      effect: tool.effect,
    })));
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.active.keys()].map((id) => this.disconnect(id)));
  }

  acquireOwner(input: { taskId: string; serverId: string; ownerKind: "native" | "codex"; ownerId: string; generation: number }): void {
    const existing = this.db.query<{ owner_kind: string; owner_id: string; generation: number }, [string, string]>(
      "SELECT owner_kind, owner_id, generation FROM mcp_owner_leases WHERE task_id = ? AND server_id = ?",
    ).get(input.taskId, input.serverId);
    if (existing) {
      if (existing.owner_kind === input.ownerKind && existing.owner_id === input.ownerId && existing.generation === input.generation) return;
      throw new Error("mcp_owner_conflict");
    }
    try {
      this.db.query("INSERT INTO mcp_owner_leases (task_id, server_id, owner_kind, owner_id, generation, acquired_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(input.taskId, input.serverId, input.ownerKind, input.ownerId, input.generation, new Date().toISOString());
    } catch (error) {
      if (String(error).includes("UNIQUE")) throw new Error("mcp_owner_conflict");
      throw error;
    }
  }

  releaseOwner(taskId: string, serverId: string, ownerId: string): void {
    const deleted = this.db.query("DELETE FROM mcp_owner_leases WHERE task_id = ? AND server_id = ? AND owner_id = ?").run(taskId, serverId, ownerId);
    if (!deleted.changes) throw new Error("mcp_owner_mismatch");
  }

  releaseOwners(taskId: string, ownerId: string): number {
    return this.db.query("DELETE FROM mcp_owner_leases WHERE task_id = ? AND owner_id = ?").run(taskId, ownerId).changes;
  }

  private connectionLost(id: string, error?: Error): void {
    const active = this.active.get(id);
    if (!active) return;
    this.active.delete(id);
    void active.connection.close().catch(() => {});
    const server = this.store.get(id);
    if (!server) return;
    const category = errorCategory(error ?? new Error("mcp_connection_closed"), Object.values(this.store.resolveSecrets(id)));
    this.store.updateState(id, category.state, { error: category.message });
    if (server.enabled && category.state !== "needs_auth") this.scheduleReconnect(id);
  }

  private scheduleReconnect(id: string): void {
    const server = this.store.get(id);
    if (!server?.enabled || this.timers.has(id)) return;
    const attempt = this.attempts.get(id) ?? 0;
    const base = this.backoff[Math.min(attempt, this.backoff.length - 1)]!;
    const delay = Math.round(base * (0.8 + this.jitter() * 0.4));
    this.attempts.set(id, attempt + 1);
    this.timers.set(id, this.schedule(() => {
      this.timers.delete(id);
      void this.connect(id).catch(() => {});
    }, delay));
  }
}
