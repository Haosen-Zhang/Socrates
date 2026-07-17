import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { createReadOnlyBuiltins } from "../tools/read-only-builtins";
import { ToolExecutor } from "../tools/executor";
import { ToolRegistry } from "../tools/registry";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import { NativeAgentRuntime, type NativeStreamFactory } from "./native-agent-runtime";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("NativeAgentRuntime", () => {
  it("completes a bounded read-only search and read tool loop", async () => {
    const root = `${tmpdir()}/socrates-native-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(`${root}/src`, { recursive: true });
    writeFileSync(`${root}/src/answer.txt`, "forty two\n");
    const db = openDb(":memory:");
    const registry = new ToolRegistry(createReadOnlyBuiltins(new WorkspacePathPolicy(root)));
    const executor = new ToolExecutor(db, registry, new ApprovalManager(db));
    let offeredTools: string[] = [];
    let maxSteps = 0;
    let receivedPrompt = "";
    const stream: NativeStreamFactory = async function* (input) {
      offeredTools = Object.keys(input.tools).sort();
      maxSteps = input.maxSteps;
      receivedPrompt = input.prompt;
      const search = await input.tools.search_files!.execute({ query: "answer" }, "search-call", input.signal);
      yield { type: "tool_call", callId: "search-call", name: "search_files", input: { query: "answer" } };
      yield { type: "tool_result", callId: "search-call", name: "search_files", output: search, isError: false };
      const read = await input.tools.read_file!.execute({ path: "src/answer.txt" }, "read-call", input.signal);
      yield { type: "tool_call", callId: "read-call", name: "read_file", input: { path: "src/answer.txt" } };
      yield { type: "tool_result", callId: "read-call", name: "read_file", output: read, isError: false };
      yield { type: "text_delta", text: "The answer is forty two." };
    };
    const runtime = new NativeAgentRuntime({
      sessionId: "session",
      taskId: "task",
      agentId: "agent",
      workspaceId: "workspace",
      workspaceIdentity: "workspace-hash",
      registry,
      executor,
      stream,
      maxSteps: 4,
      resolveAttachment: () => ({ mediaType: "text/plain", filename: "note.txt", bytes: Buffer.from("attachment text") }),
      resolveWorkspaceRef: () => ({ text: "workspace text" }),
    });
    await runtime.open();
    const events = [];
    for await (const event of runtime.start({
      prompt: "Find the answer",
      parts: [
        { type: "file", attachmentId: "attachment", filename: "note.txt", mediaType: "text/plain" },
        { type: "workspace_ref", refId: "ref", relativePath: "src/answer.txt", snapshotHash: "hash" },
      ],
    })) events.push(event);

    expect(offeredTools).toEqual(["list_directory", "read_file", "search_files", "search_text", "workspace_info"]);
    expect(maxSteps).toBe(4);
    expect(receivedPrompt).toContain("<untrusted_attachment");
    expect(receivedPrompt).toContain("<untrusted_workspace_file");
    expect(receivedPrompt).not.toContain(root);
    expect(events.some((event) => event.type === "text_delta" && event.text.includes("forty two"))).toBe(true);
    expect(db.query("SELECT name, status FROM tool_calls ORDER BY rowid").all()).toEqual([
      { name: "search_files", status: "succeeded" },
      { name: "read_file", status: "succeeded" },
    ]);
  });

  it("fails closed for unsupported images instead of silently dropping them", async () => {
    const db = openDb(":memory:");
    const registry = new ToolRegistry();
    const runtime = new NativeAgentRuntime({
      sessionId: "session", taskId: "task", agentId: "agent", workspaceId: "workspace", workspaceIdentity: "hash",
      registry,
      executor: new ToolExecutor(db, registry, new ApprovalManager(db)),
      stream: async function* () {},
    });
    await runtime.open();
    const consume = async () => {
      for await (const _event of runtime.start({
        prompt: "look",
        parts: [{ type: "image", attachmentId: "a", mediaType: "image/png" }],
      })) {
        // consume
      }
    };
    await expect(consume()).rejects.toThrow("native_runtime_image_not_supported");
  });

  it("pauses an ask MCP tool until the exact runtime approval resumes it", async () => {
    const db = openDb(":memory:");
    let executions = 0;
    const registry = new ToolRegistry([{
      name: "mcp__demo__lookup",
      description: "lookup",
      inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"], additionalProperties: false },
      risk: "medium",
      idempotency: "read",
      capability: "mcp",
      generation: 1,
      execute: async () => ({ value: ++executions }),
    }]);
    const stream: NativeStreamFactory = async function* (input) {
      const request = { requestId: "approval-1", callId: "call-1", name: "mcp__demo__lookup", input: { query: "answer" } };
      yield { type: "tool_call", callId: request.callId, name: request.name, input: request.input };
      const decision = input.requestApproval(request);
      yield { type: "approval_required", ...request };
      if ((await decision).approved) {
        const output = await input.tools[request.name]!.execute(request.input, request.callId, input.signal);
        yield { type: "tool_result", callId: request.callId, name: request.name, output, isError: false };
      }
    };
    const runtime = new NativeAgentRuntime({
      sessionId: "session", taskId: "task", agentId: "agent", workspaceId: "workspace", workspaceIdentity: "hash",
      registry,
      executor: new ToolExecutor(db, registry, new ApprovalManager(db)),
      stream,
      permissionForTool: () => "ask",
    });
    await runtime.open();
    const iterator = runtime.start({ prompt: "lookup" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "status", status: "running" });
    expect((await iterator.next()).value).toMatchObject({ type: "tool_call", callId: "call-1" });
    expect((await iterator.next()).value).toEqual({ type: "approval_required", requestId: "approval-1", callId: "call-1", risk: "medium", kind: "tool" });
    expect(executions).toBe(0);
    await runtime.answerApproval("approval-1", "allow_once");
    expect((await iterator.next()).value).toMatchObject({ type: "extension", name: "tool_result" });
    expect(executions).toBe(1);
    expect((await iterator.next()).value).toEqual({ type: "status", status: "completed" });
  });
});
