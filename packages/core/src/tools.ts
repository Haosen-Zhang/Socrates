import type { ConversationMode, AgentRunPhase } from "./conversation";

/** Shared recursive JSON Schema vocabulary for tool input and canonical output.
 * Open objects remain the default for external MCP schema compatibility.
 * Native tools close their declared objects explicitly.
 */
export type JsonSchemaValue = null | string | number | boolean | JsonSchemaValue[] | { [key: string]: JsonSchemaValue };

export interface JsonSchema {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  enum?: Array<string | number | boolean | null>;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  examples?: JsonSchemaValue[];
}

/** Compatibility name used by existing tool and MCP adapters. */
export type JsonSchemaProperty = JsonSchema;

export type ToolRisk = "low" | "medium" | "high" | "destructive";
export type ToolIdempotency = "read" | "idempotent" | "non_idempotent";
export type ToolCallStatus = "queued" | "awaiting_approval" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out" | "outcome_unknown";
export type ToolRecoveryDisposition = "safe_to_retry" | "verify_then_continue" | "requires_user_confirmation" | "recovery_blocked";

export interface ToolDefinition<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** Deadline for a single attempt, enforced centrally by the executor. */
  timeoutMs?: number;
  /** Pure model-facing projection; canonical output remains structured. */
  renderOutput?: (output: O) => unknown;
  risk: ToolRisk;
  idempotency: ToolIdempotency;
  capability: "workspace_read" | "workspace_write" | "shell" | "network" | "mcp";
  generation: number;
  validateInput?: (input: unknown) => string[];
  execute?: (input: I, context: ToolContext) => Promise<O>;
}

export interface ToolContext {
  /** Host-only immutable evaluation definitions; never accepted from tool input. */
  protectedPaths?: readonly string[];
  callId: string;
  sessionId: string;
  taskId: string;
  turnId: string;
  stepId?: string;
  toolOperationId?: string;
  toolAttemptId?: string;
  /** Stable across attempts; adapters may forward this to an idempotency-aware service. */
  idempotencyKey?: string;
  agentId: string;
  workspaceId?: string;
  mode: ConversationMode;
  phase: AgentRunPhase;
  signal: AbortSignal;
}

/**
 * Validate the shared recursive vocabulary. The recursive object/array and
 * scalar-union design follows DeepSeek Harness tools/json-schema.ts at 8bd0733;
 * Socrates retains its existing diagnostic format and adds bounded constraints.
 */
export function validateJsonSchemaInput(schema: JsonSchema, input: unknown): string[] {
  const active = new Set<object>();
  const check = (spec: JsonSchema, value: unknown, path: string, depth: number): string[] => {
    const label = path || "$";
    if (depth > 100) return [`depth:${label}`];
    if (spec.anyOf && !spec.anyOf.some((branch) => check(branch, value, path, depth + 1).length === 0)) {
      return [`anyOf:${label}`];
    }
    const valid = spec.type === undefined
      || (spec.type === "null" ? value === null
        : spec.type === "array" ? Array.isArray(value)
        : spec.type === "object" ? Boolean(value) && typeof value === "object" && !Array.isArray(value)
        : spec.type === "integer" ? typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)
        : spec.type === "number" ? typeof value === "number" && Number.isFinite(value)
        : typeof value === spec.type);
    if (!valid) return [path === "" && spec.type === "object" ? "expected:object" : `type:${label}:${spec.type}`];
    const errors: string[] = [];
    if (spec.enum && !spec.enum.some((candidate) => candidate === value)) errors.push(`enum:${label}`);
    if (typeof value === "number") {
      if (!Number.isFinite(value)) errors.push(`type:${label}:number`);
      if (spec.minimum !== undefined && value < spec.minimum) errors.push(`minimum:${label}:${spec.minimum}`);
      if (spec.maximum !== undefined && value > spec.maximum) errors.push(`maximum:${label}:${spec.maximum}`);
    }
    if (typeof value === "string") {
      const length = [...value].length;
      if (spec.minLength !== undefined && length < spec.minLength) errors.push(`minLength:${label}:${spec.minLength}`);
      if (spec.maxLength !== undefined && length > spec.maxLength) errors.push(`maxLength:${label}:${spec.maxLength}`);
      if (spec.pattern !== undefined && !new RegExp(spec.pattern, "u").test(value)) errors.push(`pattern:${label}`);
    }
    if (value && typeof value === "object") {
      if (active.has(value)) return [`cycle:${label}`];
      active.add(value);
      try {
        if (Array.isArray(value)) {
          if (spec.minItems !== undefined && value.length < spec.minItems) errors.push(`minItems:${label}:${spec.minItems}`);
          if (spec.maxItems !== undefined && value.length > spec.maxItems) errors.push(`maxItems:${label}:${spec.maxItems}`);
          for (let index = 0; index < value.length; index++) errors.push(...check(spec.items ?? {}, value[index], `${path}[${index}]`, depth + 1));
        } else {
          if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return [`type:${label}:object`];
          const record = value as Record<string, unknown>;
          const childPath = (key: string) => path ? `${path}.${key}` : key;
          for (const key of spec.required ?? []) if (!Object.prototype.hasOwnProperty.call(record, key)) errors.push(`missing:${childPath(key)}`);
          for (const key of Object.keys(record)) {
            if (!Object.prototype.hasOwnProperty.call(spec.properties ?? {}, key) && spec.additionalProperties === false) errors.push(`unknown:${childPath(key)}`);
          }
          for (const key of Object.keys(record)) {
            const child = Object.prototype.hasOwnProperty.call(spec.properties ?? {}, key) ? spec.properties![key] : typeof spec.additionalProperties === "object" ? spec.additionalProperties : undefined;
            errors.push(...check(child ?? {}, record[key], childPath(key), depth + 1));
          }
        }
      } finally { active.delete(value); }
    } else if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
      errors.push(`json:${label}`);
    }
    return errors;
  };
  return check(schema, input, "", 0);
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
