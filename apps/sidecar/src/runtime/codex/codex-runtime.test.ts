import { describe, expect, it } from "bun:test";
import type { ApprovalDecision } from "@socrates/core";
import type { CodexApprovalDecision, CodexApprovalRequest, CodexThreadStartResponse, CodexTurnStartResponse } from "./protocol-v0.144.5";
import { CodexRuntime, type CodexClientLike } from "./codex-runtime";

class FakeClient implements CodexClientLike {
  constructor(private readonly emitTurn = true) {}
  handler: (method: string, params: unknown) => void = () => {};
  approvalHandler!: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
  interrupted = false;
  additionalInput: unknown[] = [];
  async initialize() {}
  async startThread(): Promise<CodexThreadStartResponse> { return { thread: { id: "thread" }, cwd: "/workspace", model: "fake", modelProvider: "fake" }; }
  async startTurn(_threadId: string, _prompt: string, additionalInput: unknown[] = []): Promise<CodexTurnStartResponse> {
    this.additionalInput = additionalInput;
    if (this.emitTurn) queueMicrotask(() => {
      this.handler("item/agentMessage/delta", { delta: "hello" });
      this.handler("item/reasoning/summaryTextDelta", { delta: "because" });
      this.handler("turn/completed", { turn: { id: "turn", status: "completed" } });
    });
    return { turn: { id: "turn", status: "inProgress" } };
  }
  async interrupt() { this.interrupted = true; }
  async close() {}
  onNotification(handler: (method: string, params: unknown) => void) { this.handler = handler; return () => { this.handler = () => {}; }; }
}

describe("CodexRuntime", () => {
  it("maps text, reasoning and completion notifications", async () => {
    const client = new FakeClient();
    const runtime = new CodexRuntime({ cwd: "/workspace", sandbox: "read-only", model: "fake", clientFactory: async (approval) => {
      client.approvalHandler = approval;
      return client;
    } });
    await runtime.open({ sessionId: "s", workspaceId: "w" });
    const events = [];
    for await (const event of runtime.start({ prompt: "go" })) events.push(event);
    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", text: "hello" },
      { type: "extension", name: "reasoning_summary_delta", payload: { text: "because" } },
      { type: "status", status: "completed" },
    ]);
  });

  it("blocks a server approval until the matching human decision", async () => {
    const client = new FakeClient(false);
    const runtime = new CodexRuntime({ cwd: "/workspace", sandbox: "workspace-write", clientFactory: async (approval) => {
      client.approvalHandler = approval;
      return client;
    } });
    await runtime.open({ sessionId: "s", workspaceId: "w" });
    const iterator = runtime.start({ prompt: "go" })[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: "status", status: "running" });
    const decision = client.approvalHandler({ id: "approval-1", method: "item/commandExecution/requestApproval", params: { command: "pwd" } });
    expect((await iterator.next()).value).toMatchObject({ type: "tool_call", callId: "approval-1", name: "shell_command" });
    expect((await iterator.next()).value).toEqual({ type: "approval_required", requestId: "approval-1", callId: "approval-1" });
    await runtime.answerApproval("approval-1", "allow_once" satisfies ApprovalDecision);
    expect(await decision).toBe("accept");
    await runtime.interrupt();
    expect(client.interrupted).toBe(true);
    await iterator.return?.();
  });

  it("converts images and text files without sending local paths", async () => {
    const client = new FakeClient();
    const runtime = new CodexRuntime({
      cwd: "/workspace", sandbox: "read-only",
      clientFactory: async () => client,
      resolveAttachment: (id) => id === "image"
        ? { mediaType: "image/png", filename: "pixel.png", bytes: Buffer.from([1, 2, 3]) }
        : { mediaType: "text/plain", filename: "note.txt", bytes: Buffer.from("untrusted") },
      resolveWorkspaceRef: () => ({ text: "workspace context", currentHash: "current" }),
    });
    await runtime.open({ sessionId: "s", workspaceId: "w" });
    for await (const _event of runtime.start({ prompt: "go", parts: [
      { type: "image", attachmentId: "image", mediaType: "image/png" },
      { type: "file", attachmentId: "text", mediaType: "text/plain", filename: "note.txt" },
      { type: "workspace_ref", refId: "ref", relativePath: "src/a.ts", snapshotHash: "old" },
    ] })) { /* drain */ }
    expect(client.additionalInput).toHaveLength(3);
    expect(JSON.stringify(client.additionalInput)).toContain("data:image/png;base64");
    expect(JSON.stringify(client.additionalInput)).toContain("<untrusted-file");
    expect(JSON.stringify(client.additionalInput)).toContain("<untrusted-workspace-file");
    expect(JSON.stringify(client.additionalInput)).not.toContain("/workspace");
  });
});
