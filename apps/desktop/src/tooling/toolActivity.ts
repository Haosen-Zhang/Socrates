import type { RuntimeEvent, SessionMessage, ToolOutputRef, ToolRisk } from "@socrates/core";
import type { PendingApproval } from "../store";

export type ToolActivityStatus = "requested" | "running" | "succeeded" | "failed" | "cancelled";
export type ToolOperation = "workspace" | "list" | "search" | "read" | "write" | "delete" | "command" | "tool";

export type ToolActivity = {
  id: string;
  callId: string;
  name: string;
  input: unknown;
  output?: ToolOutputRef;
  isError: boolean;
  operation: ToolOperation;
  subject: string;
  readOnly: boolean;
  status: ToolActivityStatus;
  approvalId?: string;
  risk?: ToolRisk;
  durationMs?: number;
  sequence: number;
  runId: string | null;
  turnId: string | null;
};

export type PublicReasoning = {
  id: string;
  text: string;
  running: boolean;
};

const READ_ONLY_TOOLS = new Set([
  "workspace_info",
  "list_directory",
  "search_files",
  "search_text",
  "read_file",
]);

const SECRET_KEY = /(?:api[-_]?key|authorization|cookie|credential|password|secret|token)/i;
const SECRET_TEXT = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /(Authorization\s*:\s*)[^\s'",}]+(?:\s+[^\s'",}]+)?/gi,
];

export function toolActivityId(runId: string | null | undefined, callId: string): string {
  return `${runId ?? "live"}:${callId}`;
}

function objectValue(input: unknown, key: string): unknown {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)[key]
    : undefined;
}

function displayValue(value: unknown): string {
  if (Array.isArray(value)) return value.map((item) => {
    const text = String(item);
    return /^[A-Za-z0-9_./:=+@%-]+$/.test(text) ? text : JSON.stringify(text);
  }).join(" ");
  return typeof value === "string" ? value : "";
}

function limitSubject(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) return "—";
  return normalized.length > 180 ? `${normalized.slice(0, 177)}…` : normalized;
}

export function describeToolCall(
  name: string,
  input: unknown,
): Pick<ToolActivity, "operation" | "subject" | "readOnly"> {
  const path = displayValue(objectValue(input, "path") ?? objectValue(input, "relativePath"));
  const query = displayValue(objectValue(input, "query") ?? objectValue(input, "pattern"));
  const executable = displayValue(objectValue(input, "executable") ?? objectValue(input, "command"));
  const argv = displayValue(objectValue(input, "argv") ?? objectValue(input, "args"));
  if (name === "workspace_info") return { operation: "workspace", subject: ".", readOnly: true };
  if (name === "list_directory") return { operation: "list", subject: limitSubject(path), readOnly: true };
  if (name === "search_files" || name === "search_text") {
    return { operation: "search", subject: limitSubject(query), readOnly: true };
  }
  if (name === "read_file") return { operation: "read", subject: limitSubject(path), readOnly: true };
  if (name === "write_file") return { operation: "write", subject: limitSubject(path), readOnly: false };
  if (name === "delete_path") return { operation: "delete", subject: limitSubject(path), readOnly: false };
  if (name === "run_shell") {
    return { operation: "command", subject: limitSubject([executable, argv].filter(Boolean).join(" ")), readOnly: false };
  }
  return {
    operation: "tool",
    subject: limitSubject(path || query || executable || name),
    readOnly: READ_ONLY_TOOLS.has(name),
  };
}

export function approvalReasonKey(operation: ToolOperation, risk: ToolRisk): string {
  if (risk === "destructive") return "approval_risk_destructive";
  if (operation === "write") return "approval_reason_write";
  if (operation === "command") return "approval_reason_command";
  return `approval_risk_${risk}`;
}

function redactString(value: string): string {
  return SECRET_TEXT.reduce((current, pattern) => current.replace(pattern, (_match, prefix?: string) => (
    prefix ? `${prefix}[REDACTED]` : "[REDACTED]"
  )), value);
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === "string") return redactString(value);
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item, seen));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen),
  ]));
}

export function safeTechnicalJson(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(redactValue(value, new WeakSet()), null, 2);
  } catch {
    return JSON.stringify("[UNAVAILABLE]");
  }
}

type MutableActivity = ToolActivity & {
  callCreatedAt?: number;
  resultCreatedAt?: number;
  turnStatus?: SessionMessage["turnStatus"];
};

function terminalStatus(events: RuntimeEvent[]): ToolActivityStatus | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "status") continue;
    if (event.status === "failed") return "failed";
    if (event.status === "interrupted") return "cancelled";
    if (event.status === "completed") return "succeeded";
  }
  return null;
}

export function projectToolActivities(input: {
  messages: SessionMessage[];
  events: RuntimeEvent[];
  approvals: PendingApproval[];
  activeRunId?: string | null;
}): ToolActivity[] {
  const activities = new Map<string, MutableActivity>();
  const ensure = (
    callId: string,
    name = "tool",
    toolInput: unknown = {},
    runId: string | null = input.activeRunId ?? null,
  ): MutableActivity => {
    const id = toolActivityId(runId, callId);
    const current = activities.get(id);
    if (current) return current;
    const description = describeToolCall(name, toolInput);
    const created: MutableActivity = {
      id,
      callId,
      name,
      input: toolInput,
      isError: false,
      ...description,
      status: "running",
      sequence: Number.MAX_SAFE_INTEGER,
      runId,
      turnId: null,
    };
    activities.set(id, created);
    return created;
  };

  for (const message of input.messages) {
    for (const part of message.parts) {
      if (part.type === "tool_call") {
        const activity = ensure(part.callId, part.name, part.input, message.runId);
        Object.assign(activity, describeToolCall(part.name, part.input), {
          name: part.name,
          input: part.input,
          sequence: Math.min(activity.sequence, message.sequence),
          runId: message.runId,
          turnId: message.turnId,
          turnStatus: message.turnStatus,
          callCreatedAt: Date.parse(message.createdAt),
        });
      }
      if (part.type === "tool_result") {
        const activity = ensure(part.callId, "tool", {}, message.runId);
        activity.output = part.output;
        activity.isError = part.isError;
        activity.status = part.isError ? "failed" : "succeeded";
        activity.sequence = Math.min(activity.sequence, message.sequence);
        activity.resultCreatedAt = Date.parse(message.createdAt);
        activity.runId ??= message.runId;
        activity.turnId ??= message.turnId;
        activity.turnStatus ??= message.turnStatus;
      }
    }
  }

  for (const event of input.events) {
    if (event.type === "tool_call") {
      const activity = ensure(event.callId, event.name, event.input);
      Object.assign(activity, describeToolCall(event.name, event.input), {
        name: event.name,
        input: event.input,
      });
    } else if (event.type === "tool_result") {
      const activity = ensure(event.callId, event.name);
      activity.name = event.name;
      activity.output = event.output;
      activity.isError = event.isError;
      activity.status = event.isError ? "failed" : "succeeded";
    } else if (event.type === "approval_required") {
      const activity = ensure(event.callId);
      activity.approvalId = event.requestId;
      activity.risk = event.risk;
      activity.status = "requested";
    }
  }

  const approvals = new Map(input.approvals.map((approval) => [approval.id, approval]));
  const runTerminal = terminalStatus(input.events);
  for (const activity of activities.values()) {
    const approval = activity.approvalId ? approvals.get(activity.approvalId) : undefined;
    if (approval?.status === "pending") {
      activity.risk = approval.risk;
      if (!activity.output) activity.status = "requested";
    } else if (activity.approvalId && !activity.output) {
      activity.status = "running";
    }
    if (!activity.output && activity.status !== "requested") {
      const status = runTerminal ?? activity.turnStatus;
      if (status === "failed") activity.status = "failed";
      else if (status === "cancelled" || status === "interrupted") activity.status = "cancelled";
      else if (status === "completed" || status === "succeeded") activity.status = "succeeded";
    }
    if (activity.callCreatedAt !== undefined && activity.resultCreatedAt !== undefined) {
      activity.durationMs = Math.max(0, activity.resultCreatedAt - activity.callCreatedAt);
    }
  }

  return [...activities.values()]
    .sort((left, right) => left.sequence - right.sequence || left.callId.localeCompare(right.callId))
    .map(({ callCreatedAt: _callCreatedAt, resultCreatedAt: _resultCreatedAt, turnStatus: _turnStatus, ...activity }) => activity);
}

export function projectPublicReasoning(input: {
  messages: SessionMessage[];
  events: RuntimeEvent[];
  running: boolean;
  activeRunId?: string | null;
}): PublicReasoning[] {
  const persisted = input.messages.flatMap((message) => message.parts
    .filter((part): part is Extract<typeof part, { type: "reasoning_summary" }> => part.type === "reasoning_summary")
    .map((part) => ({ id: message.id, text: part.text, running: false, runId: message.runId })));
  const delta = input.running ? input.events
    .filter((event): event is Extract<RuntimeEvent, { type: "extension" }> => (
      event.type === "extension" && event.name === "reasoning_summary_delta"
    ))
    .map((event) => (
      event.payload && typeof event.payload === "object" && typeof (event.payload as Record<string, unknown>).text === "string"
        ? String((event.payload as Record<string, unknown>).text)
        : ""
    ))
    .join("") : "";
  const activeSummaryIndex = persisted.findIndex((summary) => (
    input.activeRunId !== null && input.activeRunId !== undefined && summary.runId === input.activeRunId
  ));
  if (delta && activeSummaryIndex >= 0) {
    const active = persisted[activeSummaryIndex]!;
    persisted[activeSummaryIndex] = { ...active, text: `${active.text}${delta}`, running: true };
  } else if (delta) {
    persisted.push({ id: "live-reasoning-summary", text: delta, running: true, runId: input.activeRunId ?? null });
  }
  return persisted.map(({ runId: _runId, ...summary }) => summary);
}
