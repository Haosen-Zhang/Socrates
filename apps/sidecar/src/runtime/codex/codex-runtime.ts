import {
  UNKNOWN_MODEL_CAPABILITIES,
  type AgentRuntime,
  type ApprovalDecision,
  type RuntimeEvent,
  type MessagePart,
} from "@socrates/core";
import type { CodexProtocolClient } from "./protocol-client";
import type {
  CodexApprovalDecision,
  CodexApprovalRequest,
  CodexSandboxMode,
} from "./protocol-v0.144.5";

export interface CodexClientLike extends Pick<CodexProtocolClient, "initialize" | "startThread" | "startTurn" | "interrupt" | "close" | "onNotification"> {}

type PendingApproval = { resolve: (decision: CodexApprovalDecision) => void };

class AsyncEventQueue {
  private readonly values: RuntimeEvent[] = [];
  private readonly waiters: Array<(value: IteratorResult<RuntimeEvent>) => void> = [];
  private ended = false;

  push(value: RuntimeEvent): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<RuntimeEvent>> {
    const value = this.values.shift();
    if (value) return Promise.resolve({ value, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export class CodexRuntime implements AgentRuntime {
  readonly kind = "codex_app_server";
  readonly capabilities = {
    ...UNKNOWN_MODEL_CAPABILITIES,
    textInput: true as const,
    imageInput: true as const,
    fileInput: true as const,
    toolCalling: true as const,
    streaming: true as const,
    runtimeKinds: ["codex_app_server" as const],
  };

  private client: CodexClientLike | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private queue: AsyncEventQueue | null = null;
  private unsubscribe: (() => void) | null = null;
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  constructor(private readonly options: {
    cwd: string;
    sandbox: CodexSandboxMode;
    model?: string;
    clientFactory: (approvalHandler: (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>) => Promise<CodexClientLike>;
    resolveAttachment?: (attachmentId: string) => { mediaType: string; filename: string; bytes: Buffer };
    resolveWorkspaceRef?: (relativePath: string, snapshotHash?: string) => { text: string; currentHash: string };
  }) {}

  async open(_input: { sessionId: string; workspaceId?: string }): Promise<void> {
    this.client = await this.options.clientFactory((request) => this.requestApproval(request));
    await this.client.initialize();
    const thread = await this.client.startThread({ cwd: this.options.cwd, sandbox: this.options.sandbox, model: this.options.model });
    this.threadId = thread.thread.id;
  }

  async *start(input: { prompt: string; parts?: MessagePart[]; signal?: AbortSignal }): AsyncIterable<RuntimeEvent> {
    if (!this.client || !this.threadId) throw new Error("codex_runtime_not_open");
    if (this.queue) throw new Error("codex_runtime_turn_already_active");
    const queue = new AsyncEventQueue();
    this.queue = queue;
    this.unsubscribe = this.client.onNotification((method, params) => this.consumeNotification(method, params));
    queue.push({ type: "status", status: "running" });
    const abort = () => { void this.interrupt(); };
    input.signal?.addEventListener("abort", abort, { once: true });
    let additionalInput: unknown[] | null;
    try {
      additionalInput = this.toCodexInput(input.parts ?? []);
    } catch (error) {
      queue.push({ type: "status", status: "failed", message: error instanceof Error ? error.message : String(error) });
      queue.end();
      additionalInput = null;
    }
    if (additionalInput) void this.client.startTurn(this.threadId, input.prompt, additionalInput).then((response) => {
      this.turnId = response.turn.id;
    }).catch((error) => {
      queue.push({ type: "status", status: "failed", message: error instanceof Error ? error.message : String(error) });
      queue.end();
    });
    try {
      for (;;) {
        const next = await queue.next();
        if (next.done) break;
        yield next.value;
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.unsubscribe?.();
      this.unsubscribe = null;
      this.queue = null;
      this.turnId = null;
      for (const pending of this.pendingApprovals.values()) pending.resolve("cancel");
      this.pendingApprovals.clear();
    }
  }

  private toCodexInput(parts: MessagePart[]): unknown[] {
    const inputs: unknown[] = [];
    for (const part of parts) {
      if (part.type === "text") {
        inputs.push({ type: "text", text: part.text, text_elements: [] });
      } else if (part.type === "image" || part.type === "file") {
        const attachment = this.options.resolveAttachment?.(part.attachmentId);
        if (!attachment) throw new Error("attachment_resolver_unavailable");
        if (attachment.mediaType.startsWith("image/")) {
          inputs.push({ type: "image", url: `data:${attachment.mediaType};base64,${attachment.bytes.toString("base64")}` });
        } else if (attachment.mediaType === "text/plain" || attachment.mediaType === "application/json") {
          if (attachment.bytes.byteLength > 512 * 1024) throw new Error("attachment_text_context_too_large");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(attachment.bytes);
          inputs.push({ type: "text", text: `<untrusted-file name=${JSON.stringify(attachment.filename)}>\n${text}\n</untrusted-file>`, text_elements: [] });
        } else {
          throw new Error(`attachment_type_unsupported:${attachment.mediaType}`);
        }
      } else if (part.type === "workspace_ref") {
        const resolved = this.options.resolveWorkspaceRef?.(part.relativePath, part.snapshotHash);
        if (!resolved) throw new Error("workspace_ref_not_resolved");
        inputs.push({
          type: "text",
          text: `<untrusted-workspace-file path=${JSON.stringify(part.relativePath)} hash=${JSON.stringify(resolved.currentHash)}>\n${resolved.text}\n</untrusted-workspace-file>`,
          text_elements: [],
        });
      }
    }
    return inputs;
  }

  async answerApproval(requestId: string, decision: ApprovalDecision): Promise<void> {
    const pending = this.pendingApprovals.get(requestId);
    if (!pending) throw new Error("codex_approval_not_pending");
    this.pendingApprovals.delete(requestId);
    pending.resolve(decision === "allow_once" ? "accept" : decision === "allow_session" ? "acceptForSession" : "decline");
  }

  async interrupt(): Promise<void> {
    if (this.client && this.threadId && this.turnId) await this.client.interrupt(this.threadId, this.turnId);
    this.queue?.push({ type: "status", status: "interrupted" });
    this.queue?.end();
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
    this.threadId = null;
  }

  private requestApproval(request: CodexApprovalRequest): Promise<CodexApprovalDecision> {
    const requestId = String(request.id);
    if (!this.queue || this.pendingApprovals.has(requestId)) return Promise.resolve("decline");
    const name = request.method === "item/fileChange/requestApproval" ? "file_change" : "shell_command";
    this.queue.push({ type: "tool_call", callId: requestId, name, input: request.params });
    this.queue.push({ type: "approval_required", requestId, callId: requestId });
    return new Promise((resolve) => this.pendingApprovals.set(requestId, { resolve }));
  }

  private consumeNotification(method: string, params: unknown): void {
    if (!this.queue) return;
    const record = params && typeof params === "object" ? params as Record<string, unknown> : {};
    if (method === "item/agentMessage/delta" && typeof record.delta === "string") {
      this.queue.push({ type: "text_delta", text: record.delta });
    } else if (method === "item/reasoning/summaryTextDelta" && typeof record.delta === "string") {
      this.queue.push({ type: "extension", name: "reasoning_summary_delta", payload: { text: record.delta } });
    } else if (method === "turn/completed") {
      const turn = record.turn && typeof record.turn === "object" ? record.turn as Record<string, unknown> : {};
      const failed = turn.status === "failed";
      this.queue.push({ type: "status", status: failed ? "failed" : "completed", message: failed ? "codex_turn_failed" : undefined });
      this.queue.end();
    } else if (method === "error") {
      this.queue.push({ type: "status", status: "failed", message: typeof record.message === "string" ? record.message : "codex_runtime_error" });
      this.queue.end();
    } else {
      this.queue.push({ type: "extension", name: method, payload: params });
    }
  }
}
