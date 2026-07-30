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
  shouldContinueNativeSampling,
  takeBoundToolPermission,
  toAiSdkModelMessages,
  validateNativeToolInput,
  type NativeStreamFactory,
} from "./native-agent-runtime";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

describe("NativeAgentRuntime", () => {
  it("rejects semantic tool input before an approval request can be emitted", async () => {
    const root = `${tmpdir()}/socrates-native-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const definitions = createWorkspaceWriteBuiltins(new WorkspacePathPolicy(root));
    const shell = definitions.find((definition) => definition.name === "run_shell")!;
    expect(() => validateNativeToolInput(shell, {
      executable: "git",
      argv: ["status; rm", "-rf"],
    })).toThrow("invalid_tool_input:shell_metacharacter_denied");

    const db = openDb(":memory:");
    const events: unknown[] = [];
    const stream: NativeStreamFactory = async function* (input) {
      const request = {
        requestId: "approval-invalid",
        callId: "call-invalid",
        name: "run_shell",
        input: { executable: "git", argv: ["status; rm", "-rf"] },
        permission: input.tools.run_shell!.permission(),
      };
      const decision = input.requestApproval(request);
      yield { type: "approval_required", ...request };
      await decision;
    };
    const runtime = new NativeAgentRuntime({
      sessionId: "session",
      taskId: "task",
      agentId: "agent",
      workspaceId: "workspace",
      workspaceIdentity: "identity",
      registry: new ToolRegistry(definitions),
      executor: new ToolExecutor(db, new ToolRegistry(definitions), new ApprovalManager(db)),
      stream,
      allowedCapabilities: ["workspace_write", "shell"],
    });
    await runtime.open();
    const drain = async () => {
      for await (const event of runtime.start({ prompt: "invalid" })) events.push(event);
    };
    await expect(drain()).rejects.toThrow("invalid_tool_input:shell_metacharacter_denied");
    expect(events.some((event) => (
      Boolean(event)
      && typeof event === "object"
      && (event as { type?: string }).type === "approval_required"
    ))).toBe(false);
  });

  it("continues after an auto-approved tool step so the next sample can consume its result", () => {
    expect(shouldContinueNativeSampling({
      pendingApprovals: 0,
      hadToolActivity: true,
      remainingSteps: 7,
    })).toBe(true);
    expect(shouldContinueNativeSampling({
      pendingApprovals: 0,
      hadToolActivity: false,
      remainingSteps: 7,
    })).toBe(false);
    expect(shouldContinueNativeSampling({
      pendingApprovals: 1,
      hadToolActivity: true,
      remainingSteps: 0,
    })).toBe(false);
  });

  it("keeps a pending call bound to its original policy evidence after the room policy changes", () => {
    const original = {
      effect: "ask" as const,
      risk: "high" as const,
      matchedRuleIds: [],
      reasonCode: "approval_mode_ask",
      freshHumanRequired: false,
      policyVersion: 4,
    };
    const current = {
      ...original,
      effect: "allow" as const,
      reasonCode: "approval_mode_workspace_full",
      policyVersion: 5,
    };
    const captured = new Map([["call", original]]);
    expect(takeBoundToolPermission(captured, "call", current)).toEqual(original);
    expect(captured.has("call")).toBe(false);
  });

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
      const searchTool = input.tools.search_files!;
      const search = await searchTool.execute({ query: "answer" }, "search-call", searchTool.permission(), input.signal);
      yield { type: "tool_call", callId: "search-call", name: "search_files", input: { query: "answer" } };
      yield { type: "tool_result", callId: "search-call", name: "search_files", output: search, isError: false };
      const readTool = input.tools.read_file!;
      const read = await readTool.execute({ path: "src/answer.txt" }, "read-call", readTool.permission(), input.signal);
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
    const make = (allowedCapabilities: ("workspace_read" | "workspace_write" | "shell" | "mcp")[]) => new NativeAgentRuntime({
      sessionId: "s", taskId: "t", agentId: "a", workspaceId: "w", workspaceIdentity: "h",
      registry, executor, stream, allowedCapabilities,
    });

    // 只读能力：写工具不应出现（回归防线——这正是"workspace-write 却只有只读"的 bug）
    const ro = make(["workspace_read", "mcp"]);
    await ro.open();
    for await (const _ of ro.start({ prompt: "x" })) { /* drain */ }
    expect(offered).not.toContain("write_file");
    expect(offered).not.toContain("delete_path");
    expect(offered).not.toContain("run_shell");

    // 仅授予 workspace_write：文件写入/删除出现，命令仍由独立 shell 能力控制
    const rw = make(["workspace_read", "workspace_write", "mcp"]);
    await rw.open();
    for await (const _ of rw.start({ prompt: "x" })) { /* drain */ }
    expect(offered).toContain("write_file");
    expect(offered).toContain("delete_path");
    expect(offered).not.toContain("run_shell");

    const shell = make(["workspace_read", "workspace_write", "shell", "mcp"]);
    await shell.open();
    for await (const _ of shell.start({ prompt: "x" })) { /* drain */ }
    expect(offered).toContain("run_shell");
  });

  it("keeps delete_path unchanged until a fresh exact approval allows it once", async () => {
    const root = `${tmpdir()}/socrates-native-${crypto.randomUUID()}`;
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const target = `${root}/delete-me.txt`;
    writeFileSync(target, "keep until approved\n");
    const db = openDb(":memory:");
    const definitions = createWorkspaceWriteBuiltins(new WorkspacePathPolicy(root));
    const registry = new ToolRegistry(definitions);
    let sequence = 0;
    const makeRuntime = () => {
      const suffix = String(++sequence);
      const stream: NativeStreamFactory = async function* (input) {
        const tool = input.tools.delete_path!;
        const request = {
          requestId: `delete-approval-${suffix}`,
          callId: `delete-call-${suffix}`,
          name: "delete_path",
          input: { path: "delete-me.txt" },
          permission: tool.permission(),
        };
        yield { type: "tool_call", callId: request.callId, name: request.name, input: request.input };
        const decision = input.requestApproval(request);
        yield { type: "approval_required", ...request };
        if ((await decision).approved) {
          const output = await tool.execute(request.input, request.callId, request.permission, input.signal);
          yield { type: "tool_result", callId: request.callId, name: request.name, output, isError: false };
        }
      };
      return new NativeAgentRuntime({
        sessionId: "session",
        taskId: `task-${suffix}`,
        agentId: "agent",
        workspaceId: "workspace",
        workspaceIdentity: "identity",
        registry,
        executor: new ToolExecutor(db, registry, new ApprovalManager(db)),
        stream,
        allowedCapabilities: ["workspace_write"],
        permissionForTool: () => ({
          effect: "ask",
          risk: "destructive",
          matchedRuleIds: [],
          reasonCode: "fresh_human_required",
          freshHumanRequired: true,
          policyVersion: 1,
        }),
      });
    };

    const denied = makeRuntime();
    await denied.open();
    const deniedIterator = denied.start({ prompt: "delete" })[Symbol.asyncIterator]();
    await deniedIterator.next();
    await deniedIterator.next();
    expect((await deniedIterator.next()).value).toMatchObject({
      type: "approval_required",
      risk: "destructive",
      freshHumanRequired: true,
    });
    expect(Bun.file(target).size).toBeGreaterThan(0);
    await denied.answerApproval("delete-approval-1", "deny");
    await deniedIterator.next();
    expect(Bun.file(target).size).toBeGreaterThan(0);

    const allowed = makeRuntime();
    await allowed.open();
    const allowedIterator = allowed.start({ prompt: "delete" })[Symbol.asyncIterator]();
    await allowedIterator.next();
    await allowedIterator.next();
    expect((await allowedIterator.next()).value).toMatchObject({
      type: "approval_required",
      risk: "destructive",
      freshHumanRequired: true,
    });
    await allowed.answerApproval("delete-approval-2", "allow_once");
    expect((await allowedIterator.next()).value).toMatchObject({
      type: "tool_result",
      callId: "delete-call-2",
      name: "delete_path",
    });
    expect(await Bun.file(target).exists()).toBe(false);
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
    let policyEffect: "ask" | "allow" = "ask";
    let policyVersion = 7;
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
      const nativeTool = input.tools.mcp__demo__lookup!;
      const request = {
        requestId: "approval-1",
        callId: "call-1",
        name: "mcp__demo__lookup",
        input: { query: "answer" },
        permission: nativeTool.permission(),
      };
      yield { type: "tool_call", callId: request.callId, name: request.name, input: request.input };
      const decision = input.requestApproval(request);
      yield { type: "approval_required", ...request };
      if ((await decision).approved) {
        const output = await nativeTool.execute(request.input, request.callId, request.permission, input.signal);
        yield { type: "tool_result", callId: request.callId, name: request.name, output, isError: false };
      }
      const nextPermission = nativeTool.permission();
      yield { type: "text_delta", text: `${nextPermission.effect}:${nextPermission.policyVersion}` };
    };
    const runtime = new NativeAgentRuntime({
      sessionId: "session", taskId: "task", agentId: "agent", workspaceId: "workspace", workspaceIdentity: "hash",
      registry,
      executor: new ToolExecutor(db, registry, new ApprovalManager(db)),
      stream,
      permissionForTool: () => ({
        effect: policyEffect,
        risk: "medium",
        matchedRuleIds: [],
        reasonCode: "test_policy",
        freshHumanRequired: false,
        policyVersion,
      }),
    });
    await runtime.open();
    const iterator = runtime.start({ prompt: "lookup" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "status", status: "running" });
    expect((await iterator.next()).value).toMatchObject({ type: "tool_call", callId: "call-1" });
    expect((await iterator.next()).value).toEqual({
      type: "approval_required",
      requestId: "approval-1",
      callId: "call-1",
      risk: "medium",
      kind: "tool",
      policyVersion: 7,
      freshHumanRequired: false,
    });
    expect(executions).toBe(0);
    await runtime.answerApproval("approval-1", "allow_once");
    expect((await iterator.next()).value).toMatchObject({
      type: "tool_result",
      callId: "call-1",
      name: "mcp__demo__lookup",
    });
    expect(executions).toBe(1);
    policyEffect = "allow";
    policyVersion = 8;
    expect((await iterator.next()).value).toEqual({ type: "text_delta", text: "allow:8" });
    expect((await iterator.next()).value).toEqual({ type: "status", status: "completed" });
  });

  it("rejects an approved call when its exact input changes before execution", async () => {
    const db = openDb(":memory:");
    let executions = 0;
    const registry = new ToolRegistry([{
      name: "mutate",
      description: "mutate",
      inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"], additionalProperties: false },
      risk: "high",
      idempotency: "non_idempotent",
      capability: "workspace_write",
      generation: 1,
      execute: async () => ({ executions: ++executions }),
    }]);
    const stream: NativeStreamFactory = async function* (input) {
      const nativeTool = input.tools.mutate!;
      const request = {
        requestId: "approval",
        callId: "call",
        name: "mutate",
        input: { path: "approved.txt" },
        permission: nativeTool.permission(),
      };
      yield { type: "tool_call", callId: request.callId, name: request.name, input: request.input };
      const decision = input.requestApproval(request);
      yield { type: "approval_required", ...request };
      if ((await decision).approved) {
        await nativeTool.execute({ path: "different.txt" }, request.callId, request.permission, input.signal);
      }
    };
    const runtime = new NativeAgentRuntime({
      sessionId: "session",
      taskId: "task",
      agentId: "agent",
      workspaceId: "workspace",
      workspaceIdentity: "hash",
      registry,
      executor: new ToolExecutor(db, registry, new ApprovalManager(db)),
      stream,
      allowedCapabilities: ["workspace_write"],
      permissionForTool: (definition) => ({
        effect: "ask",
        risk: definition.risk,
        matchedRuleIds: [],
        reasonCode: "test_policy",
        freshHumanRequired: false,
        policyVersion: 3,
      }),
    });
    await runtime.open();
    const iterator = runtime.start({ prompt: "mutate" })[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.next();
    await iterator.next();
    await runtime.answerApproval("approval", "allow_once");
    await expect(iterator.next()).rejects.toThrow("native_tool_approval_evidence_mismatch");
    expect(executions).toBe(0);
  });
});
