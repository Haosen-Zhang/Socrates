import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

type RequestId = string | number;
export type ProtocolMessage = {
  id?: RequestId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
type NotificationHandler = (message: Required<Pick<ProtocolMessage, "method">> & ProtocolMessage) => void;
type ServerRequestHandler = (message: Required<Pick<ProtocolMessage, "id" | "method">> & ProtocolMessage) => Promise<unknown>;

function redact(value: string): string {
  return value
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/gu, "[REDACTED_API_KEY]")
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/giu, "$1[REDACTED]");
}

export function buildChildEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "CODEX_HOME"] as const;
  return Object.fromEntries(allowed.flatMap((key) => source[key] === undefined ? [] : [[key, source[key]]])) as NodeJS.ProcessEnv;
}

export class JsonlChildSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<RequestId, Pending>();
  private notificationHandler: NotificationHandler = () => {};
  private serverRequestHandler: ServerRequestHandler = async () => { throw new Error("protocol_server_request_unhandled"); };
  private failed: Error | null = null;
  private stderrPreview = "";

  constructor(
    private readonly command: readonly [string, ...string[]],
    private readonly options: { requestTimeoutMs?: number; stderrMaxBytes?: number } = {},
  ) {}

  onNotification(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  onServerRequest(handler: ServerRequestHandler): void {
    this.serverRequestHandler = handler;
  }

  async start(): Promise<void> {
    if (this.child) throw new Error("protocol_child_already_started");
    const [executable, ...args] = this.command;
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"], env: buildChildEnvironment() });
    this.child = child;
    createInterface({ input: child.stdout }).on("line", (line) => this.consumeLine(line));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      const limit = this.options.stderrMaxBytes ?? 32 * 1024;
      this.stderrPreview = (this.stderrPreview + redact(chunk)).slice(-limit);
    });
    child.once("error", (error) => this.failAll(new Error(`protocol_child_error:${error.message}`)));
    child.once("exit", (code, signal) => {
      if (!this.failed && this.pending.size) this.failAll(new Error(`protocol_child_exited:${code ?? signal ?? "unknown"}`));
      this.child = null;
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
  }

  request(method: string, params: unknown, timeoutMs = this.options.requestTimeoutMs ?? 10_000): Promise<unknown> {
    if (!this.child || this.failed) return Promise.reject(this.failed ?? new Error("protocol_child_not_running"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`protocol_request_timeout:${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ id, method, params });
    });
  }

  getStderrPreview(): string {
    return this.stderrPreview;
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.failAll(new Error("protocol_child_closed"));
    child.kill("SIGTERM");
    const exited = new Promise<boolean>((resolve) => {
      child.once("exit", () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });
    if (!(await exited) && child.exitCode === null) child.kill("SIGKILL");
    this.child = null;
  }

  private consumeLine(line: string): void {
    let message: ProtocolMessage;
    try {
      message = JSON.parse(line) as ProtocolMessage;
      if (!message || typeof message !== "object") throw new Error("not_object");
    } catch {
      this.failAll(new Error("protocol_malformed_json"));
      this.child?.kill("SIGTERM");
      return;
    }
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`protocol_error:${message.error.message ?? message.error.code ?? "unknown"}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && typeof message.method === "string") {
      void this.serverRequestHandler(message as Required<Pick<ProtocolMessage, "id" | "method">> & ProtocolMessage)
        .then((result) => this.write({ id: message.id, result }))
        .catch((error) => this.write({ id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }));
      return;
    }
    if (typeof message.method === "string") this.notificationHandler(message as Required<Pick<ProtocolMessage, "method">> & ProtocolMessage);
  }

  private write(message: ProtocolMessage): void {
    if (!this.child?.stdin.writable) throw new Error("protocol_stdin_closed");
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private failAll(error: Error): void {
    this.failed = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
