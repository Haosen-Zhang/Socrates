import type { ConversationMode, AgentRunPhase } from "./conversation";

export type JsonSchemaProperty = {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  items?: Pick<JsonSchemaProperty, "type">;
  minimum?: number;
  maximum?: number;
};

export type JsonSchema = {
  type: "object";
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
};

export type ToolRisk = "low" | "medium" | "high" | "destructive";
export type ToolIdempotency = "read" | "idempotent" | "non_idempotent";
export type ToolCallStatus = "queued" | "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  risk: ToolRisk;
  idempotency: ToolIdempotency;
  capability: "workspace_read" | "workspace_write" | "shell" | "network" | "mcp";
  generation: number;
  validateInput?: (input: unknown) => string[];
  execute?: (input: I, context: ToolContext) => Promise<O>;
}

export interface ToolContext {
  callId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  agentId: string;
  workspaceId?: string;
  mode: ConversationMode;
  phase: AgentRunPhase;
  signal: AbortSignal;
}

export function validateJsonSchemaInput(schema: JsonSchema, input: unknown): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return ["expected:object"];
  const record = input as Record<string, unknown>;
  const errors: string[] = [];
  for (const key of schema.required ?? []) if (!(key in record)) errors.push(`missing:${key}`);
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(record)) if (!schema.properties?.[key]) errors.push(`unknown:${key}`);
  }
  for (const [key, spec] of Object.entries(schema.properties ?? {})) {
    if (!(key in record)) continue;
    const value = record[key];
    const valid = spec.type === "array" ? Array.isArray(value) : spec.type === "integer" ? Number.isInteger(value) : spec.type === "object" ? Boolean(value) && typeof value === "object" && !Array.isArray(value) : typeof value === spec.type;
    if (!valid) errors.push(`type:${key}:${spec.type}`);
    if (valid && spec.type === "array" && spec.items) {
      for (const [index, item] of (value as unknown[]).entries()) {
        if (typeof item !== spec.items.type) errors.push(`type:${key}[${index}]:${spec.items.type}`);
      }
    }
    if (valid && typeof value === "number") {
      if (spec.minimum !== undefined && value < spec.minimum) errors.push(`minimum:${key}:${spec.minimum}`);
      if (spec.maximum !== undefined && value > spec.maximum) errors.push(`maximum:${key}:${spec.maximum}`);
    }
  }
  return errors;
}

export function makeToolCallKey(input: { attemptId: string; turnId: string; ordinal: number; inputHash: string }): string {
  return `${input.attemptId}:${input.turnId}:${input.ordinal}:${input.inputHash}`;
}

export function truncateToolOutput(
  value: string,
  limits: { maxBytes: number; maxLines: number },
): { preview: string; byteSize: number; truncated: boolean } {
  const byteSize = new TextEncoder().encode(value).byteLength;
  let lines = value.split("\n");
  let truncated = lines.length > limits.maxLines || byteSize > limits.maxBytes;
  lines = lines.slice(0, limits.maxLines);
  let preview = lines.join("\n");
  const bytes = new TextEncoder().encode(preview);
  if (bytes.byteLength > limits.maxBytes) {
    preview = new TextDecoder().decode(bytes.slice(0, limits.maxBytes));
    truncated = true;
  }
  return { preview, byteSize, truncated };
}
