import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { type ToolDefinition, validateJsonSchemaInput } from "@socrates/core";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { applyNativeToolContracts } from "./native-tool-contracts";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = `${tmpdir()}/socrates-contracts-${crypto.randomUUID()}`;
  roots.push(root); mkdirSync(root);
  const originals: ToolDefinition[] = ["write_file", "create_directory", "copy_path", "move_path", "create_archive", "create_document", "create_spreadsheet", "delete_path"].map((name) => ({ name, description: "Existing tool", inputSchema: { type: "object" }, risk: "high", idempotency: "non_idempotent", capability: "workspace_write", generation: 1 }));
  return { originals, tools: applyNativeToolContracts(originals) };
}

describe("native write tool contracts", () => {
  it("accepts an explicit create-only precondition and describes real hash evidence", () => {
    const tool = fixture().tools.find(tool => tool.name === "write_file")!;
    expect(validateJsonSchemaInput(tool.inputSchema, { path: "new.md", content: "new", expectedSha256: null })).toEqual([]);
    expect(tool.description).toContain("Never invent");
  });
  it("publishes actual spreadsheet sheets, rows and mixed primitive cell schema", () => {
    const tool = fixture().tools.find((tool) => tool.name === "create_spreadsheet")!;
    const valid = { path: "a.xlsx", format: "xlsx", sheets: [{ name: "Data", rows: [["item", 2, true, null]] }] };
    expect(validateJsonSchemaInput(tool.inputSchema, valid)).toEqual([]);
    expect(validateJsonSchemaInput(tool.inputSchema, { ...valid, sheets: [{ name: "Data", rows: [[{ formula: "=1" }]] }] })).not.toEqual([]);
    expect(validateJsonSchemaInput(tool.inputSchema, { ...valid, format: "pdf" })).not.toEqual([]);
    expect(validateJsonSchemaInput(tool.inputSchema, { ...valid, sheets: [{ rows: [] }] })).toContain("missing:sheets[0].name");
  });

  it("validates actual write outputs and rejects prose/false structure", async () => {
    const root = `${tmpdir()}/socrates-output-contract-${crypto.randomUUID()}`;
    roots.push(root); mkdirSync(root);
    const { createWorkspaceWriteBuiltins } = await import("./workspace-write-builtins");
    const tools = applyNativeToolContracts(createWorkspaceWriteBuiltins(new WorkspacePathPolicy(root)));
    const tool = tools.find((tool) => tool.name === "create_spreadsheet")!;
    const result = await tool.execute!({ path: "data.csv", format: "csv", sheets: [{ name: "Data", rows: [["x", 3]] }] }, { signal: new AbortController().signal } as never);
    expect(tool.outputSchema).toBeDefined();
    expect(validateJsonSchemaInput(tool.outputSchema!, result)).toEqual([]);
    expect(validateJsonSchemaInput(tool.outputSchema!, { action: "created", format: "csv", path: "data.csv", sheets: "one", rows: 1, byteSize: 5 })).toContain("type:sheets:integer");
    expect(validateJsonSchemaInput(tool.outputSchema!, "Created data.csv")).not.toEqual([]);
  });

  it("does not mutate supplied definitions and adds valid examples for complex tools", () => {
    const { originals, tools } = fixture();
    for (const tool of tools.filter((tool) => tool.capability === "workspace_write")) {
      const original = originals.find((item) => item.name === tool.name)!;
      expect(original.outputSchema).toBeUndefined();
      expect(tool.outputSchema).toBeDefined();
    }
    for (const name of ["create_spreadsheet", "create_document", "create_archive", "write_file"]) {
      const tool = tools.find((tool) => tool.name === name)!;
      expect(tool.inputSchema.examples?.length).toBeGreaterThan(0);
      for (const example of tool.inputSchema.examples!) expect(validateJsonSchemaInput(tool.inputSchema, example)).toEqual([]);
    }
  });
});
