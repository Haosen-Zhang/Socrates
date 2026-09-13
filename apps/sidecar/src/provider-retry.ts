import {
  StructuredExecutionError,
  type ExecutionErrorDetail,
  type ExecutionErrorPhase,
} from "@socrates/core";
import { ProviderEmptyResponseError } from "./provider-errors";

export interface ProviderRetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  maxRetryAfterMs: number;
  jitterRatio: number;
}

export const DEFAULT_PROVIDER_RETRY_POLICY: Readonly<ProviderRetryPolicy> = Object.freeze({
  maxAttempts: 5,
  baseDelayMs: 250,
  maxDelayMs: 8_000,
  maxRetryAfterMs: 30_000,
  jitterRatio: 0.2,
});

export type ProviderRetryLifecycleEvent =
  | { type: "provider_attempt_started"; attemptNo: number }
  | { type: "provider_attempt_completed"; attemptNo: number }
  | {
      type: "provider_attempt_failed";
      attemptNo: number;
      error: ExecutionErrorDetail;
      outputStarted: boolean;
      willRetry: boolean;
    }
  | {
      type: "provider_retry_scheduled";
      failedAttemptNo: number;
      nextAttemptNo: number;
      delayMs: number;
      errorCode: string;
    };

function cancelledError(phase: ExecutionErrorPhase): StructuredExecutionError {
  return new StructuredExecutionError({
    code: "provider_cancelled",
    category: "cancelled",
    phase,
    retryable: false,
    message: "Provider request was cancelled.",
  });
}

export function providerRetryDelay(
  attemptNo: number,
  error: ExecutionErrorDetail,
  policy: ProviderRetryPolicy,
  random: () => number,
): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(Math.max(0, error.retryAfterMs), policy.maxRetryAfterMs);
  }
  const exponential = Math.min(
    policy.maxDelayMs,
    policy.baseDelayMs * (2 ** Math.max(0, attemptNo - 1)),
  );
  const jitter = 1 + ((random() * 2) - 1) * policy.jitterRatio;
  return Math.max(0, Math.round(exponential * jitter));
}

async function abortableSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelledError("provider_connect");
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => signal?.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(cancelledError("provider_connect"));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

export async function* executeProviderWithRetry<T extends { type: string }>(input: {
  openAttempt(attemptNo: number): AsyncIterable<T>;
  classifyError(error: unknown, phase: ExecutionErrorPhase): ExecutionErrorDetail;
  isAuthoritativeOutput(part: T): boolean;
  errorFromPart?(part: T): unknown | null;
  signal?: AbortSignal;
  policy?: Partial<ProviderRetryPolicy>;
  random?: () => number;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
}): AsyncIterable<T | ProviderRetryLifecycleEvent> {
  const policy = { ...DEFAULT_PROVIDER_RETRY_POLICY, ...input.policy };
  if (!Number.isSafeInteger(policy.maxAttempts) || policy.maxAttempts < 1) {
    throw new Error("provider_retry_max_attempts_invalid");
  }
  const random = input.random ?? Math.random;
  const sleep = input.sleep ?? abortableSleep;

  for (let attemptNo = 1; attemptNo <= policy.maxAttempts; attemptNo += 1) {
    if (input.signal?.aborted) throw cancelledError("provider_connect");
    yield { type: "provider_attempt_started", attemptNo };
    let outputStarted = false;
    let sawPart = false;
    const buffered: T[] = [];
    try {
      for await (const part of input.openAttempt(attemptNo)) {
        if (input.signal?.aborted) throw cancelledError("provider_stream");
        sawPart = true;
        const embeddedError = input.errorFromPart?.(part);
        if (embeddedError !== undefined && embeddedError !== null) throw embeddedError;
        if (!outputStarted && input.isAuthoritativeOutput(part)) {
          outputStarted = true;
          for (const pending of buffered) yield pending;
          buffered.length = 0;
          yield part;
        } else if (outputStarted) {
          yield part;
        } else {
          buffered.push(part);
        }
      }
      if (!outputStarted) throw new ProviderEmptyResponseError();
      yield { type: "provider_attempt_completed", attemptNo };
      return;
    } catch (error) {
      const classified = error instanceof StructuredExecutionError
        ? error.detail
        : input.classifyError(
            error,
            error instanceof ProviderEmptyResponseError
              ? "provider_completion"
              : sawPart ? "provider_stream" : "provider_connect",
          );
      const willRetry = classified.retryable && !outputStarted && attemptNo < policy.maxAttempts;
      yield {
        type: "provider_attempt_failed",
        attemptNo,
        error: classified,
        outputStarted,
        willRetry,
      };
      if (!willRetry) {
        if (classified.retryable && outputStarted) {
          throw new StructuredExecutionError({
            ...classified,
            code: "provider_retry_unsafe_after_output",
            retryable: false,
            message: "Provider failed after authoritative output began; automatic replay is unsafe.",
          });
        }
        if (classified.retryable && attemptNo >= policy.maxAttempts) {
          throw new StructuredExecutionError({
            ...classified,
            code: "provider_retry_exhausted",
            retryable: false,
            message: `Provider retry policy exhausted after ${attemptNo} attempts.`,
          });
        }
        throw new StructuredExecutionError(classified);
      }
      const delayMs = providerRetryDelay(attemptNo, classified, policy, random);
      yield {
        type: "provider_retry_scheduled",
        failedAttemptNo: attemptNo,
        nextAttemptNo: attemptNo + 1,
        delayMs,
        errorCode: classified.code,
      };
      await sleep(delayMs, input.signal);
      if (input.signal?.aborted) throw cancelledError("provider_connect");
    }
  }
}
