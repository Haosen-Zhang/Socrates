import { describe, expect, it } from "bun:test";
import { openDb } from "../db";
import { MemorySecrets } from "../secrets";
import type { McpClientAdapter, McpConnection } from "./adapter";
import { McpManager } from "./manager";
import { McpStore } from "./store";

class FakeAdapter implements McpClientAdapter {
  calls: Array<{ name: string; input: unknown }> = [];
  closes = 0;
  onClose: ((error?: Error) => void) | null = null;
  schemaField = "q";
  async connect(_server: never, _secrets: never, onClose: (error?: Error) => void): Promise<McpConnection> {
    this.onClose = onClose;
    return {
      listTools: async () => [
        { name: "search", description: "Search", inputSchema: { type: "object", properties: { [this.schemaField]: { type: "string" } }, required: [this.schemaField], additionalProperties: false }, annotations: { readOnlyHint: true } },
        { name: "bad", description: "Bad", inputSchema: { type: "string" } },
      ],
      listCatalog: async () => [
        { kind: "resource" as const, name: "handbook", uri: "file:///untrusted/handbook.md", mimeType: "text/markdown" },
        { kind: "prompt" as const, name: "review", description: "Review code" },
      ],
      callTool: async (name, input) => { this.calls.push({ name, input }); return { content: [{ type: "text", text: "ok" }] }; },
      close: async () => { this.closes += 1; },
    };
  }
}

describe("McpManager", () => {
  it("discovers namespaced generation-bound tools and removes them on disconnect", async () => {
    const db = openDb(":memory:");
    const store = new McpStore(db, new MemorySecrets());
    const server = store.create({
      name: "docs", scope: "global",
      config: { transport: "streamable_http", url: "https://example.com/mcp", headerKeys: [] },
    });
    store.setEnabled(server.id, true);
    const adapter = new FakeAdapter();
    const manager = new McpManager(db, store, adapter);
    await manager.connect(server.id);
    expect(store.get(server.id)).toMatchObject({ state: "degraded", generation: 1 });
    const definitions = manager.definitionsFor();
    expect(definitions.map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
    expect(store.listCatalog(server.id)).toEqual([
      { kind: "prompt", name: "review", uri: "", description: "Review code", mimeType: null, trust: "untrusted" },
      { kind: "resource", name: "handbook", uri: "file:///untrusted/handbook.md", description: null, mimeType: "text/markdown", trust: "untrusted" },
    ]);
    expect(manager.definitionsFor(undefined, { effects: ["allow"] })).toEqual([]);
    store.setToolPolicy(server.id, "search", { effect: "allow" });
    expect(manager.definitionsFor(undefined, { effects: ["allow"] }).map((tool) => tool.name)).toEqual(["mcp__docs__search"]);
    store.setToolPolicy(server.id, "search", { effect: "allow", riskOverride: "high" });
    expect(manager.definitionsFor(undefined, { effects: ["allow"] })[0]?.risk).toBe("high");
    const output = await definitions[0]!.execute!({ q: "Socrates" }, {
      callId: "call", sessionId: "session", taskId: "task", turnId: "turn", agentId: "agent",
      mode: "single_agent", phase: "executing", signal: new AbortController().signal,
    });
    expect(output).toMatchObject({ source: "mcp:docs", trust: "untrusted" });
    expect(adapter.calls).toEqual([{ name: "search", input: { q: "Socrates" } }]);
    expect(db.query("SELECT owner_kind FROM mcp_owner_leases WHERE task_id = 'task'").get()).toEqual({ owner_kind: "native" });
    expect(manager.releaseOwners("task", "session:agent")).toBe(1);
    adapter.schemaField = "term";
    await manager.connect(server.id);
    expect(store.get(server.id)?.generation).toBe(2);
    expect(store.listTools(server.id)[0]?.effect).toBe("ask");
    await manager.disconnect(server.id);
    expect(manager.definitionsFor()).toEqual([]);
    await expect(definitions[0]!.execute!({ q: "stale" }, {
      callId: "call2", sessionId: "session", taskId: "task", turnId: "turn", agentId: "agent",
      mode: "single_agent", phase: "executing", signal: new AbortController().signal,
    })).rejects.toThrow("stale_mcp_generation");
  });

  it("classifies auth failures without retry storms and enforces one owner", async () => {
    const db = openDb(":memory:");
    const store = new McpStore(db, new MemorySecrets());
    const server = store.create(
      { name: "auth", scope: "global", config: { transport: "streamable_http", url: "https://example.com/mcp", headerKeys: ["Authorization"] } },
      { Authorization: "Bearer super-secret" },
    );
    store.setEnabled(server.id, true);
    let scheduled = 0;
    const adapter: McpClientAdapter = { async connect() { throw new Error("401 Unauthorized Bearer super-secret"); } };
    const manager = new McpManager(db, store, adapter, () => { scheduled += 1; return 1 as never; });
    await expect(manager.connect(server.id)).rejects.toThrow("401 Unauthorized");
    expect(store.get(server.id)?.state).toBe("needs_auth");
    expect(store.get(server.id)?.lastError).not.toContain("super-secret");
    expect(scheduled).toBe(0);

    manager.acquireOwner({ taskId: "task", serverId: server.id, ownerKind: "native", ownerId: "runtime", generation: 1 });
    expect(() => manager.acquireOwner({ taskId: "task", serverId: server.id, ownerKind: "codex", ownerId: "codex", generation: 1 })).toThrow("mcp_owner_conflict");
    manager.releaseOwner("task", server.id, "runtime");
  });

  it("backs off after a crash and reconnects with a new generation", async () => {
    const db = openDb(":memory:");
    const store = new McpStore(db, new MemorySecrets());
    const server = store.create({ name: "retry", scope: "global", config: { transport: "streamable_http", url: "https://example.com/mcp", headerKeys: [] } });
    store.setEnabled(server.id, true);
    const callbacks: Array<() => void> = [];
    const delays: number[] = [];
    let attempts = 0;
    const adapter: McpClientAdapter = {
      async connect() {
        attempts += 1;
        if (attempts === 1) throw new Error("connection reset");
        return { listTools: async () => [], listCatalog: async () => [], callTool: async () => ({}), close: async () => {} };
      },
    };
    const manager = new McpManager(db, store, adapter, (callback, delay) => {
      callbacks.push(callback); delays.push(delay); return callbacks.length as never;
    }, () => 0.5);
    await expect(manager.connect(server.id)).rejects.toThrow("connection reset");
    expect(delays).toEqual([1_000]);
    callbacks.shift()!();
    for (let index = 0; index < 20 && store.get(server.id)?.state !== "connected"; index += 1) await Bun.sleep(1);
    expect(store.get(server.id)).toMatchObject({ state: "connected", generation: 1 });
  });
});
