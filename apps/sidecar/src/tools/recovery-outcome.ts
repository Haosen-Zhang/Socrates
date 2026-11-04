// Adapted recovery distinctions/guidance from DeepSeek Harness session/repair.ts.
// Copyright (c) 2026 DeepSeek. MIT license: see third-party/DeepSeek-Harness-LICENSE.
import type { ToolRecoveryDisposition } from "@socrates/core";

export function deniedToolOutcome(): { code: "TOOL_APPROVAL_DENIED"; message: string } {
  return { code: "TOOL_APPROVAL_DENIED", message: "The user denied this tool call. It was not executed. Do not retry it without a new explicit user instruction and approval." };
}

export function interruptedToolOutcome(started: boolean, idempotency: string, capability: string | null): {
  code: "TOOL_NOT_STARTED" | "TOOL_OUTCOME_UNKNOWN";
  disposition: ToolRecoveryDisposition;
  message: string;
} {
  if (!started) return { code: "TOOL_NOT_STARTED", disposition: "safe_to_retry",
    message: "The tool did not start. Request it again if needed; previous approval is expired." };
  const disposition: ToolRecoveryDisposition = idempotency === "read" || idempotency === "idempotent"
    ? "safe_to_retry" : capability === "workspace_write" ? "verify_then_continue" : "requires_user_confirmation";
  return { code: "TOOL_OUTCOME_UNKNOWN", disposition,
    message: "The tool call was interrupted after it was recorded, but no result was durably recorded. Its outcome is unknown. Decide whether to retry from the tool semantics: retry only if the operation is read-only or idempotent; if it may have side effects, first verify external state or ask the user. Do not retry blindly." };
}
