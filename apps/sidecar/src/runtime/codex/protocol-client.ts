import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ProtocolMessage } from "../child-supervisor";
import { JsonlChildSupervisor } from "../child-supervisor";
import {
  isCompatibleCodexVersion,
  type CodexApprovalDecision,
  type CodexApprovalRequest,
  type CodexSandboxMode,
  type CodexThreadStartResponse,
  type CodexTurnStartResponse,
} from "./protocol-v0.144.5";

const execFileAsync = promisify(execFile);
type ApprovalHandler = (request: CodexApprovalRequest) => Promise<CodexApprovalDecision>;
type NotificationHandler = (method: string, params: unknown) => void;

export function validateCodexRuntimeOptions(input: { sandbox: string; approvalsReviewer: string }): void {
  if (input.sandbox !== "read-only" && input.sandbox !== "workspace-write") throw new Error("codex_unsafe_sandbox");
  if (input.approvalsReviewer !== "user") throw new Error("codex_unsafe_approval_reviewer");
}

export async function assertPinnedCodexVersion(binaryPath: string): Promise<void> {
  const { stdout } = await execFileAsync(binaryPath, ["--version"], { timeout: 5_000 });
  const match = /codex-cli\s+([^\s]+)/u.exec(stdout);
  const version = match?.[1] ?? null;
  if (isCompatibleCodexVersion(version)) return;
  // 逃生开关：codex 随 ChatGPT.app 自动升级 alpha 版，精确 pin 会反复卡住用户。
  // 用户确认自担风险（协议可能变）后可放行；仍打印告警，不静默。
  if (process.env.SOCRATES_CODEX_ALLOW_VERSION_MISMATCH === "1") {
    console.warn(`[codex] 放行未验证版本 ${version ?? "unknown"}（SOCRATES_CODEX_ALLOW_VERSION_MISMATCH=1）；协议若有变动可能出错。`);
    return;
  }
  throw new Error(`codex_version_mismatch:${version ?? "unknown"}`);
}

export async function createPinnedCodexClient(binaryPath: string, approvalHandler: ApprovalHandler): Promise<CodexProtocolClient> {
  await assertPinnedCodexVersion(binaryPath);
  return new CodexProtocolClient(new JsonlChildSupervisor([binaryPath, "app-server", "--stdio"]), approvalHandler);
}

export class CodexProtocolClient {
  private readonly notifications = new Set<NotificationHandler>();
  private initialized = false;

  constructor(private readonly supervisor: JsonlChildSupervisor, private readonly approvalHandler: ApprovalHandler) {
    supervisor.onNotification((message) => {
      for (const handler of this.notifications) handler(message.method, message.params);
    });
    supervisor.onServerRequest(async (message) => this.handleServerRequest(message));
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notifications.add(handler);
    return () => this.notifications.delete(handler);
  }

  async initialize(): Promise<void> {
    await this.supervisor.start();
    await this.supervisor.request("initialize", {
      clientInfo: { name: "socrates", title: "Socrates", version: "0.1.0" },
      capabilities: { experimentalApi: false },
    });
    this.initialized = true;
  }

  async startThread(input: { cwd: string; sandbox: CodexSandboxMode; model?: string }): Promise<CodexThreadStartResponse> {
    this.assertInitialized();
    validateCodexRuntimeOptions({ sandbox: input.sandbox, approvalsReviewer: "user" });
    return await this.supervisor.request("thread/start", {
      cwd: input.cwd,
      sandbox: input.sandbox,
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      ephemeral: true,
      model: input.model ?? null,
    }) as CodexThreadStartResponse;
  }

  async startTurn(threadId: string, prompt: string, additionalInput: unknown[] = []): Promise<CodexTurnStartResponse> {
    this.assertInitialized();
    return await this.supervisor.request("turn/start", {
      threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }, ...additionalInput],
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    }) as CodexTurnStartResponse;
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    this.assertInitialized();
    await this.supervisor.request("turn/interrupt", { threadId, turnId });
  }

  async close(): Promise<void> {
    await this.supervisor.close();
    this.initialized = false;
  }

  private async handleServerRequest(message: Required<Pick<ProtocolMessage, "id" | "method">> & ProtocolMessage): Promise<unknown> {
    if (message.method !== "item/commandExecution/requestApproval" && message.method !== "item/fileChange/requestApproval") {
      throw new Error(`codex_server_request_not_supported:${message.method}`);
    }
    const decision = await this.approvalHandler({
      id: message.id,
      method: message.method,
      params: (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>,
    });
    return { decision };
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("codex_client_not_initialized");
  }
}
