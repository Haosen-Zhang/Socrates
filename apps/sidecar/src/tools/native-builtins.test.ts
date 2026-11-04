import { expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateJsonSchemaInput, type ToolContext } from "@socrates/core";
import { openDb } from "../db";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { createNativeBuiltinTools } from "./native-builtins";
import { ToolOutputStore } from "./output-store";
import { SupervisedCommandRunner } from "./workspace-command-runner";

it("production native registry validates all sixteen builtin results and preserves mutation evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "native-contracts-"));
  const db = openDb(":memory:");
  try {
    const policy = new WorkspacePathPolicy(root);
    const scope = { sessionId: "room", workspaceIdentity: "workspace" };
    const store = new ToolOutputStore(db);
    const runner = new SupervisedCommandRunner((_root, input) => ({ executable: "/bin/echo", argv: input.argv, env: { PATH: "/usr/bin:/bin" } }), undefined,
      (context) => store.createCommandCapture(scope, context.toolOperationId));
    const tools = createNativeBuiltinTools(policy, store, scope, runner);
    expect(tools).toHaveLength(16);
    const context: ToolContext = { callId: "call", sessionId: "room", taskId: "task", turnId: "turn", agentId: "agent", mode: "single_agent", phase: "executing", signal: new AbortController().signal };
    const ref = store.put(scope, "result");
    writeFileSync(join(root, "source.txt"), "old\n");
    const inputs: Record<string, unknown> = {
      workspace_info: {}, list_directory: { path: "." }, search_files: { query: "source" }, search_text: { query: "old" }, read_file: { path: "source.txt" },
      write_file: { path: "source.txt", content: "new\n" }, create_directory: { path: "new-directory" },
      copy_path: { source: "source.txt", destination: "copy.txt" }, move_path: { source: "copy.txt", destination: "moved.txt" },
      create_archive: { path: "archive.zip", sources: ["source.txt"] }, create_document: { path: "report.docx", paragraphs: ["Report"] },
      create_spreadsheet: { path: "sheet.xlsx", format: "xlsx", sheets: [{ name: "Data", rows: [["A", 1, true, null]] }] },
      delete_path: { path: "moved.txt" }, run_command: { executable: "echo", argv: ["hello"] }, run_shell: { executable: "echo", argv: ["literal|text"] }, read_tool_result: { ref },
    };
    for (const tool of tools) {
      expect(tool.outputSchema, tool.name).toBeDefined();
      expect(tool.timeoutMs, tool.name).toBeGreaterThan(0);
      expect(validateJsonSchemaInput(tool.inputSchema, inputs[tool.name]), tool.name).toEqual([]);
      const output = await tool.execute!(inputs[tool.name], { ...context, toolOperationId: tool.name });
      expect(validateJsonSchemaInput(tool.outputSchema!, output), tool.name).toEqual([]);
      if (tool.name === "write_file") {
        expect(output).toMatchObject({ oldSha256: expect.any(String), newSha256: expect.any(String), diff: expect.stringContaining("-old") });
        expect(policy.recoverMutation({ operationId: tool.name, kind: "write", path: "source.txt" }).outcome).toBe("applied");
      }
      if (tool.name === "run_command") {
        const result = output as { fullOutputRefs: { stdout: string } };
        expect(store.read(scope, result.fullOutputRefs.stdout).text).toBe("hello\n");
      }
    }
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
});
