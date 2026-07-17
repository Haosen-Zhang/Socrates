import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import type { McpServerRecord } from "@socrates/core";
import { createBoundMcpFetch, OfficialMcpClientAdapter } from "./adapter";

describe("OfficialMcpClientAdapter", () => {
  it("negotiates, discovers, calls and closes a real stdio SDK server", async () => {
    const now = new Date().toISOString();
    const server: McpServerRecord = {
      id: "server", name: "test", scope: "global", workspaceId: null,
      config: {
        transport: "stdio", command: process.execPath,
        args: [resolve(import.meta.dir, "fixtures/stdio-server.ts")], envKeys: ["TEST_MCP_SECRET"],
      },
      enabled: true, state: "disconnected", generation: 0, lastError: null, createdAt: now, updatedAt: now,
    };
    const adapter = new OfficialMcpClientAdapter(fetch);
    const connection = await adapter.connect(server, { TEST_MCP_SECRET: "available" }, () => {});
    try {
      const tools = await connection.listTools();
      expect(tools).toHaveLength(1);
      expect(tools[0]).toMatchObject({ name: "echo", annotations: { readOnlyHint: true } });
      expect(JSON.stringify(await connection.callTool("echo", { text: "hello" }))).toContain("hello:secret-present");
    } finally {
      await connection.close();
    }
  }, 10_000);

  it("uses the injected HTTP path and secret headers for Streamable HTTP", async () => {
    const now = new Date().toISOString();
    const seenAuthorization: Array<string | null> = [];
    const adapter = new OfficialMcpClientAdapter(async (_url, init) => {
      seenAuthorization.push(new Headers(init?.headers).get("authorization"));
      return new Response("unauthorized", { status: 401 });
    });
    const server: McpServerRecord = {
      id: "remote", name: "remote", scope: "global", workspaceId: null,
      config: { transport: "streamable_http", url: "https://example.com/mcp", headerKeys: ["Authorization"] },
      enabled: true, state: "disconnected", generation: 0, lastError: null, createdAt: now, updatedAt: now,
    };
    await expect(adapter.connect(server, { Authorization: "Bearer secret" }, () => {})).rejects.toThrow();
    expect(seenAuthorization[0]).toBe("Bearer secret");
  });

  it("fails closed for metadata endpoints, cross-origin requests and redirects", async () => {
    expect(() => createBoundMcpFetch(new URL("http://169.254.169.254/mcp"), fetch)).toThrow("mcp_metadata_endpoint_forbidden");
    const bound = createBoundMcpFetch(new URL("https://example.com/mcp"), async () => new Response(null, { status: 302, headers: { Location: "https://evil.example/mcp" } }));
    await expect(bound("https://evil.example/mcp")).rejects.toThrow("mcp_cross_origin_request_forbidden");
    await expect(bound("https://example.com/mcp")).rejects.toThrow("mcp_redirect_forbidden");
  });
});
