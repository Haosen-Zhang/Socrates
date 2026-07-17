import { describe, expect, it } from "bun:test";
import { mcpToolName, validateMcpServerInput, validateMcpToolSchema } from "./mcp";

describe("MCP contracts", () => {
  it("validates scoped stdio and HTTP configs without accepting embedded credentials", () => {
    expect(validateMcpServerInput({
      name: "local_files", scope: "workspace", workspaceId: "w",
      config: { transport: "stdio", command: "/usr/bin/node", args: ["server.js"], envKeys: ["TOKEN"] },
    })).toEqual([]);
    expect(validateMcpServerInput({
      name: "remote", scope: "global",
      config: { transport: "streamable_http", url: "https://user:secret@example.com/mcp", headerKeys: [] },
    })).toContain("mcp_url_credentials_forbidden");
    expect(validateMcpServerInput({
      name: "unsafe", scope: "global", config: { transport: "stdio", command: "npx", args: [], envKeys: [] },
    })).toContain("mcp_command_absolute_required");
  });

  it("namespaces tools and rejects pathological schemas", () => {
    expect(mcpToolName("github", "create issue")).toBe("mcp__github__create_issue");
    expect(validateMcpToolSchema({ type: "object", properties: { q: { type: "string" } } })).toEqual([]);
    let nested: Record<string, unknown> = { type: "object" };
    for (let index = 0; index < 20; index += 1) nested = { type: "object", properties: nested };
    expect(validateMcpToolSchema(nested)).toContain("mcp_schema_too_deep");
  });
});
