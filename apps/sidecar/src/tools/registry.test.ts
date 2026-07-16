import { describe, expect, it } from "bun:test";
import type { ToolDefinition } from "@socrates/core";
import { ToolRegistry } from "./registry";

const readTool: ToolDefinition = {
  name: "read_file",
  description: "Read",
  inputSchema: { type: "object" },
  risk: "low",
  idempotency: "read",
  capability: "workspace_read",
  generation: 1,
};

describe("ToolRegistry", () => {
  it("filters by mode ceiling", () => {
    const registry = new ToolRegistry([readTool, { ...readTool, name: "write_file", capability: "workspace_write" }]);
    expect(registry.available({ mode: "chat", phase: "idle", allowedCapabilities: ["workspace_read"] })).toEqual([]);
    expect(registry.available({ mode: "multi_agent", phase: "discussing", allowedCapabilities: ["workspace_read", "workspace_write"] }).map((tool) => tool.name)).toEqual(["read_file"]);
  });

  it("fails closed for duplicate names and stale generations", () => {
    expect(() => new ToolRegistry([readTool, readTool])).toThrow("duplicate_tool:read_file");
    const registry = new ToolRegistry([readTool]);
    expect(() => registry.resolve("read_file", 0)).toThrow("stale_tool_generation:read_file");
    expect(() => registry.resolve("missing", 1)).toThrow("unknown_tool:missing");
  });
});
