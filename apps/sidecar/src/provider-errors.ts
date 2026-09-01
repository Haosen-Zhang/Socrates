import {
  StructuredExecutionError,
  isStructuredExecutionError,
  type ExecutionErrorDetail,
  type ExecutionErrorPhase,
} from "@socrates/core";

type ProviderErrorLike = {
  name?: string;
  message?: string;
  status?: number;
  statusCode?: number;
  code?: string;
  providerCode?: string;
  isRetryable?: boolean;
  responseHeaders?: Headers | Record<string, string>;
  headers?: Headers | Record<string, string>;
  data?: unknown;
  cause?: unknown;
};

const NETWORK_CODES = [
  "econnreset",
  "econnrefused",
  "enotfound",
  "eai_again",
  "epipe",
  "etimedout",
  "connectionrefused",
  "connectionclosed",
  "failedtoopensocket",
] as const;

function isFetchFailureMessage(error: unknown): boolean {
  return /^(?:fetch failed|failed to fetch|network request failed|load failed)(?::.*)?$/iu
    .test(textOf(error).trim());
}

export class ProviderEmptyResponseError extends Error {
  readonly name = "ProviderEmptyResponseError";
  constructor() {
    super("Provider returned no authoritative output.");
  }
}

function textOf(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 300);
  if (error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string") {
    return (error as { message: string }).message.slice(0, 300);
  }
  return String(error).slice(0, 300);
}

function providerCodeOf(error: ProviderErrorLike): string | undefined {
  if (typeof error.providerCode === "string") return error.providerCode;
  if (typeof error.code === "string") return error.code;
  const data = error.data;
  if (data && typeof data === "object") {
    const nested = (data as { error?: unknown }).error ?? data;
    if (nested && typeof nested === "object" && typeof (nested as { code?: unknown }).code === "string") {
      return (nested as { code: string }).code;
    }
  }
  return undefined;
}

function isNetworkCause(error: unknown): boolean {
  if (error instanceof TypeError) return isFetchFailureMessage(error);
  if (!error || typeof error !== "object") return false;
  const value = error as ProviderErrorLike;
  const code = providerCodeOf(value)?.toLowerCase();
  return NETWORK_CODES.includes(code as (typeof NETWORK_CODES)[number]);
}

function headerValue(headers: ProviderErrorLike["headers"], name: string): string | null {
  if (!headers) return null;
  if (headers instanceof Headers) return headers.get(name);
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return entry?.[1] ?? null;
}

function retryAfterMsOf(error: ProviderErrorLike, now = Date.now()): number | undefined {
  const raw = headerValue(error.responseHeaders ?? error.headers, "retry-after");
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - now);
}

function detail(
  error: unknown,
  phase: ExecutionErrorPhase,
  input: Omit<ExecutionErrorDetail, "phase" | "message" | "cause"> & { message?: string },
): ExecutionErrorDetail {
  const value = error as ProviderErrorLike | null;
  return {
    ...input,
    phase,
    message: input.message ?? textOf(error),
    cause: {
      ...(value?.name ? { name: value.name } : {}),
      message: textOf(error),
    },
  };
}

export function classifyProviderError(
  error: unknown,
  phase: ExecutionErrorPhase,
): ExecutionErrorDetail {
  if (isStructuredExecutionError(error)) return error.detail;
  const value = error as ProviderErrorLike | null;
  const statusCode = value?.statusCode ?? value?.status;
  const providerCode = value ? providerCodeOf(value) : undefined;
  const common = {
    ...(statusCode === undefined ? {} : { statusCode }),
    ...(providerCode ? { providerCode } : {}),
  };
  const normalizedCode = providerCode?.toLowerCase();
  const message = textOf(error).toLowerCase();

  if (value?.name === "AbortError" || normalizedCode === "abort_err") {
    return detail(error, phase, {
      ...common, code: "provider_cancelled", category: "cancelled", retryable: false,
    });
  }
  if (error instanceof ProviderEmptyResponseError) {
    return detail(error, "provider_completion", {
      ...common, code: "provider_empty_response", category: "provider", retryable: true,
    });
  }
  if (value?.name === "TimeoutError" || normalizedCode === "etimedout" || statusCode === 408) {
    return detail(error, phase, {
      ...common, code: "provider_timeout", category: "timeout", retryable: true,
    });
  }
  if (statusCode === 401) {
    return detail(error, phase, {
      ...common, code: "provider_authentication_failed", category: "authentication", retryable: false,
    });
  }
  if (statusCode === 403) {
    return detail(error, phase, {
      ...common, code: "provider_authorization_failed", category: "permission", retryable: false,
    });
  }
  if (statusCode === 429) {
    const permanentQuota = normalizedCode === "insufficient_quota"
      || normalizedCode === "billing_hard_limit_reached"
      || /(?:quota|credit|billing).*(?:exhaust|insufficient|limit)/u.test(message);
    return detail(error, phase, {
      ...common,
      code: permanentQuota ? "provider_quota_exhausted" : "provider_rate_limited",
      category: "rate_limit",
      retryable: !permanentQuota,
      ...(!permanentQuota && value && retryAfterMsOf(value) !== undefined
        ? { retryAfterMs: retryAfterMsOf(value) }
        : {}),
    });
  }
  if (statusCode === 400 || statusCode === 404 || statusCode === 409 || statusCode === 422) {
    return detail(error, phase, {
      ...common,
      code: statusCode === 404 ? "provider_model_not_found" : "provider_invalid_request",
      category: "invalid_request",
      retryable: false,
    });
  }
  if (statusCode !== undefined && statusCode >= 500 && statusCode <= 599) {
    return detail(error, phase, {
      ...common, code: "provider_unavailable", category: "provider", retryable: true,
    });
  }
  const aiSdkNetworkWrapper = value?.name === "AI_APICallError"
    && value.isRetryable === true
    && statusCode === undefined
    && isNetworkCause(value.cause);
  const topLevelFetchFailure = error instanceof TypeError && isFetchFailureMessage(error);
  if (topLevelFetchFailure
    || NETWORK_CODES.includes(normalizedCode as (typeof NETWORK_CODES)[number])
    || aiSdkNetworkWrapper) {
    return detail(error, phase, {
      ...common, code: "provider_network_error", category: "network", retryable: true,
    });
  }
  return detail(error, phase, {
    ...common, code: "provider_unknown_error", category: "unknown", retryable: false,
  });
}

export function asStructuredProviderError(
  error: unknown,
  phase: ExecutionErrorPhase,
): StructuredExecutionError {
  return isStructuredExecutionError(error)
    ? error
    : new StructuredExecutionError(classifyProviderError(error, phase));
}
