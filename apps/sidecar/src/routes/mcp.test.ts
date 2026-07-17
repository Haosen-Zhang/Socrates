import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { McpStore } from "../mcp/store";
import { MemorySecrets } from "../secrets";
import { WorkspaceManager } from "../workspace/manager";
import { mcpRoutes } from "./mcp";

describe("MCP routes", () => {
  it("persists scoped redacted config and tears down before disable/delete", async () => {
    const root = `${tmpdir()}/socrates-mcp-${crypto.randomUUID()}`;
    mkdirSync(root, { recursive: true });
    try {
      const db = openDb(":memory:");
      const workspace = new WorkspaceManager(db).select(root);
      const secrets = new MemorySecrets();
      const store = new McpStore(db, secrets);
      const lifecycleCalls: string[] = [];
      const app = new Hono().route("/mcp", mcpRoutes(store, {
        async connect(id) { lifecycleCalls.push(`connect:${id}`); store.updateState(id, "connected", { generation: store.get(id)!.generation + 1 }); },
        async disconnect(id) { lifecycleCalls.push(`disconnect:${id}`); },
      }));
      const createdResponse = await app.request("/mcp/servers", {
        method: "POST",
        body: JSON.stringify({
          server: {
            name: "workspace_tools", scope: "workspace", workspaceId: workspace.id,
            config: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"], envKeys: ["TOKEN"] },
          },
          secrets: { TOKEN: "super-secret" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json();
      expect(JSON.stringify(created)).not.toContain("super-secret");
      expect(store.resolveSecrets(created.id)).toEqual({ TOKEN: "super-secret" });
      expect(JSON.stringify(store.diagnostics(created.id))).not.toContain("super-secret");
      expect(store.diagnostics(created.id).secretStatus).toEqual({ TOKEN: "set" });
      expect(await (await app.request("/mcp/servers")).json()).toEqual([]);
      expect((await (await app.request(`/mcp/servers?workspaceId=${workspace.id}`)).json())).toHaveLength(1);

      const enabled = await app.request(`/mcp/servers/${created.id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
      expect((await enabled.json()).state).toBe("connected");
      await app.request(`/mcp/servers/${created.id}/enabled`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
      expect(lifecycleCalls).toEqual([`connect:${created.id}`, `disconnect:${created.id}`]);
      expect(JSON.stringify(await (await app.request(`/mcp/export?workspaceId=${workspace.id}`)).json())).not.toContain("super-secret");

      await app.request(`/mcp/servers/${created.id}`, { method: "DELETE" });
      expect(store.get(created.id)).toBeNull();
      expect(secrets.get(`mcp:${created.id}:stdio:TOKEN`)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects duplicate names in the same scope", async () => {
    const store = new McpStore(openDb(":memory:"), new MemorySecrets());
    const app = new Hono().route("/mcp", mcpRoutes(store));
    const body = JSON.stringify({ server: { name: "remote", scope: "global", config: { transport: "streamable_http", url: "https://example.com/mcp", headerKeys: [] } } });
    expect((await app.request("/mcp/servers", { method: "POST", body })).status).toBe(201);
    const duplicate = await app.request("/mcp/servers", { method: "POST", body });
    expect(duplicate.status).toBe(400);
    expect(await duplicate.json()).toEqual({ error: "mcp_server_name_conflict" });
    const created = store.list()[0]!;
    const invalidRisk = await app.request(`/mcp/servers/${created.id}/tools/missing/policy`, {
      method: "PUT", body: JSON.stringify({ effect: "ask", riskOverride: "harmless" }),
    });
    expect(invalidRisk.status).toBe(400);
    expect(await invalidRisk.json()).toEqual({ error: "mcp_risk_invalid" });
  });
});
