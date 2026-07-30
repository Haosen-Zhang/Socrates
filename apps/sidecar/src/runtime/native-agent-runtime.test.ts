import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import { createReadOnlyBuiltins } from "../tools/read-only-builtins";
import { createWorkspaceWriteBuiltins } from "../tools/workspace-write-builtins";
import { ToolExecutor } from "../tools/executor";
import { ToolRegistry } from "../tools/registry";
import { WorkspacePathPolicy } from "../workspace/path-policy";
import {
  NativeAgentRuntime,
  toAiSdkModelMessages,
  type NativeStreamFactory,
} from "./native-agent-runtime";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("NativeAgentRuntime", () => {
  it("converts durable text and tool history into an AI SDK model transcript", () => {
    expect(toAiSdkModelMessages([
      {
        messageId: "u1",
        role: "user",
        content: "read it",
        parts: [{ type: "text", text: "read it" }],
        sequence: 1,
      },
      {
        messageId: "call",
        role: "assistant",
        content: "",
        parts: [{ type: "tool_call", callId: "c1", name: "read_file", input: { path: "a.txt" } }],
        sequence: 2,
      },
      {
        messageId: "result",
        role: "tool",
        content: "hello",
        parts: [{
          type: "tool_result",
          callId: "c1",
          output: { preview: "hello", byteSize: 5, truncated: false },
          isError: false,
        }],
        sequence: 3,
      },
      {
        messageId: "a1",
        role: "assistant",
        content: "It says hello.",
        parts: [{ type: "text", text: "It says hello." }],
        sequence: 4,
      },
    ])).toEqual([
      { role: "user", content: "read it" },
      {
        role: "assistant",
        content: [{
          type: "tool-call",
          toolCallId: "c1",
          toolName: "read_file",
          input: { path: "a.txt" },
        }],
      },
      {
        role: "tool",
        content: [{
          type: "tool-result",
          toolCallId: "c1",
          toolName: "read_file",
          output: { type: "text", value: "hello" },
        }],
      },
      { role: "assistant", content: "It says hello." },
    ]);
  });

  it("reconstructs parallel tool calls/results as provider-valid grouped messages", () => {
    expect(toAiSdkModelMessages([
      {
        messageId: "text",
        role: "assistant",
        content: "I will inspect both.",
        parts: [{ type: "text", text: "I will inspect both." }],
        sequence: 1,
      },
      {
        messageId: "call-1",
        role: "assistant",
        content: "",
        parts: [{ type: "tool_call", callId: "c1", name: "read_file", input: { path: "a" } }],
        sequence: 2,
      },
      {
        messageId: "call-2",
        role: "assistant",
        content: "",
        parts: [{ type: "tool_call", callId: "c2", name: "read_file", input: { path: "b" } }],
        sequence: 3,
      },
      {
        messageId: "result-1",
        role: "tool",
        content: "a",
        parts: [{
          type: "tool_result",
          callId: "c1",
          output: { preview: "a", byteSize: 1, truncated: false },
          isError: false,
        }],
        sequence: 4,
      },
      {
        messageId: "result-2",
        role: "tool",
        content: "b failed",
        parts: [{
          type: "tool_result",
          callId: "c2",
          output: { preview: "b failed", byteSize: 8, truncated: false },
          isError: true,
        }],
        sequence: 5,
      },
    ])).toEqual([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I will inspect both." },
          { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a" } },
          { type: "tool-call", toolCallId: "c2", toolName: "read_file", input: { path: "b" } },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "c1",
            toolName: "read_file",
            output: { type: "text", value: "a" },
          },
          {
            type: "tool-result",
            toolCallId: "c2",
            toolName: "read_file",
            output: { type: "error-text", value: "b failed" },
          },
        ],
      },
    ]);
  });

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
    expect(runtime.contextOverheadTokens()).toBeGreaterThan(0);
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

  it("offers workspace-write tools only when workspace_write capability is allowed", async () => {
    const root = `${tmpdir()}/socrates-native-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const db = openDb(":memory:");
    const policy = new WorkspacePathPolicy(root);
    const registry = new ToolRegistry([...createReadOnlyBuiltins(policy), ...createWorkspaceWriteBuiltins(policy)]);
    const executor = new ToolExecutor(db, registry, new ApprovalManager(db));
    let offered: string[] = [];
    const stream: NativeStreamFactory = async function* (input) {
      offered = Object.keys(input.tools).sort();
      yield { type: "text_delta", text: "ok" };
    };
    const make = (allowedCapabilities: ("workspace_read" | "workspace_write" | "mcp")[]) => new NativeAgentRuntime({
      sessionId: "s", taskId: "t", agentId: "a", workspaceId: "w", workspaceIdentity: "h",
      registry, executor, stream, allowedCapabilities,
    });

    // 只读能力：写工具不应出现（回归防线——这正是"workspace-write 却只有只读"的 bug）
    const ro = make(["workspace_read", "mcp"]);
    await ro.open();
    for await (const _ of ro.start({ prompt: "x" })) { /* drain */ }
    expect(offered).not.toContain("write_file");
    expect(offered).not.toContain("run_shell");

    // 授予 workspace_write：写工具必须出现
    const rw = make(["workspace_read", "workspace_write", "mcp"]);
    await rw.open();
    for await (const _ of rw.start({ prompt: "x" })) { /* drain */ }
    expect(offered).toContain("write_file");
    expect(offered).toContain("run_shell");
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

  it("aborts the active provider stream when a separate cancel request interrupts it", async () => {
    const db = openDb(":memory:");
    const registry = new ToolRegistry();
    let providerSignal: AbortSignal | undefined;
    const runtime = new NativeAgentRuntime({
      sessionId: "session", taskId: "task", agentId: "agent", workspaceId: "workspace", workspaceIdentity: "hash",
      registry,
      executor: new ToolExecutor(db, registry, new ApprovalManager(db)),
      stream: async function* (input) {
        providerSignal = input.signal;
        yield { type: "text_delta", text: "partial" };
        await new Promise<never>((_resolve, reject) => {
          input.signal?.addEventListener(
            "abort",
            () => reject(new Error("provider_aborted")),
            { once: true },
          );
        });
      },
    });
    await runtime.open();
    const iterator = runtime.start({ prompt: "wait" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "status", status: "running" });
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "partial" });
    const pending = iterator.next();
    await runtime.interrupt();
    expect(providerSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow();
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
    expect((await iterator.next()).value).toMatchObject({
      type: "tool_result",
      callId: "call-1",
      name: "mcp__demo__lookup",
    });
    expect(executions).toBe(1);
    expect((await iterator.next()).value).toEqual({ type: "status", status: "completed" });
  });
});
