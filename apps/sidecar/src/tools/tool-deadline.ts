import { isStructuredExecutionError, StructuredExecutionError, type ToolContext } from "@socrates/core";

const CLEANUP_GRACE_MS = 1_500;
const unresolved = new Map<string, Set<Promise<unknown>>>();
const scopeOf = (context: ToolContext) => context.workspaceId ?? context.sessionId;

export function assertToolExecutionQuiescent(context: ToolContext): void {
  if (unresolved.get(scopeOf(context))?.size) throw new StructuredExecutionError({
    code: "TOOL_EXECUTION_UNRESOLVED", category: "unknown", phase: "tool_execution", retryable: false,
    message: "tool_execution_still_running",
  });
}

function abortError(reason: unknown): StructuredExecutionError {
  if (isStructuredExecutionError(reason)) return reason;
  return new StructuredExecutionError({ code: "TOOL_CANCELLED", category: "cancelled",
    phase: "tool_execution", retryable: false, message: "tool_cancelled" });
}

/** Deadline is per attempt. Cancellation waits for cleanup; an uncooperative
 * body blocks further workspace dispatch until it actually settles. */
export async function withToolDeadline<T>(
  context: ToolContext, timeoutMs: number, operation: (context: ToolContext) => Promise<T>,
): Promise<T> {
  if (context.signal.aborted) throw abortError(context.signal.reason);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) throw new Error("invalid_tool_timeout");
  const controller = new AbortController();
  const timeout = new StructuredExecutionError({ code: "TOOL_TIMEOUT", category: "timeout",
    phase: "tool_execution", retryable: false, message: "tool_timed_out" });
  const fromParent = () => controller.abort(abortError(context.signal.reason));
  context.signal.addEventListener("abort", fromParent, { once: true });
  const deadlineAt = performance.now() + timeoutMs;
  const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
  let grace: ReturnType<typeof setTimeout> | undefined;
  let settled = false;
  const scope = scopeOf(context);
  const body = Promise.resolve().then(() => {
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    return operation({ ...context, signal: controller.signal });
  });
  const completed = body.then((value) => {
    if (performance.now() >= deadlineAt && !controller.signal.aborted) controller.abort(timeout);
    if (controller.signal.aborted) throw abortError(controller.signal.reason);
    return value;
  }, (error) => { throw controller.signal.aborted ? abortError(controller.signal.reason) : error; }).finally(() => {
    settled = true;
    const pending = unresolved.get(scope);
    pending?.delete(body);
    if (!pending?.size) unresolved.delete(scope);
  });
  let onAbort!: () => void;
  const cleanupLimit = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      grace = setTimeout(() => {
        if (settled) return;
        const pending = unresolved.get(scope) ?? new Set<Promise<unknown>>();
        pending.add(body); unresolved.set(scope, pending);
        reject(new StructuredExecutionError({ code: "TOOL_EXECUTION_UNRESOLVED", category: "unknown",
          phase: "tool_execution", retryable: false, message: "tool_execution_still_running",
          cause: { message: abortError(controller.signal.reason).message } }));
      }, CLEANUP_GRACE_MS);
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (controller.signal.aborted) onAbort();
  });
  try { return await Promise.race([completed, cleanupLimit]); }
  finally {
    clearTimeout(timer); clearTimeout(grace);
    context.signal.removeEventListener("abort", fromParent);
    controller.signal.removeEventListener("abort", onAbort);
  }
}
