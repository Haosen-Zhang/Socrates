export type ExecutionErrorCategory =
  | "network"
  | "provider"
  | "rate_limit"
  | "authentication"
  | "invalid_request"
  | "context"
  | "tool_validation"
  | "tool_execution"
  | "permission"
  | "filesystem"
  | "persistence"
  | "cancelled"
  | "timeout"
  | "unknown";

export type ExecutionErrorPhase =
  | "provider_connect"
  | "provider_stream"
  | "provider_completion"
  | "tool_validation"
  | "tool_checkpoint"
  | "tool_execution"
  | "approval"
  | "persistence"
  | "recovery";

export interface ExecutionErrorCause {
  name?: string;
  message: string;
}

export interface ExecutionErrorDetail {
  code: string;
  category: ExecutionErrorCategory;
  phase: ExecutionErrorPhase;
  retryable: boolean;
  retryAfterMs?: number;
  message: string;
  cause?: ExecutionErrorCause;
  statusCode?: number;
  providerCode?: string;
}

export class StructuredExecutionError extends Error {
  readonly name = "StructuredExecutionError";

  constructor(readonly detail: ExecutionErrorDetail) {
    super(detail.message);
  }
}

export function isStructuredExecutionError(error: unknown): error is StructuredExecutionError {
  return error instanceof StructuredExecutionError;
}
