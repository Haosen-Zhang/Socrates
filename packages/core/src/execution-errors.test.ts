import { describe, expect, it } from "bun:test";
import {
  StructuredExecutionError,
  isStructuredExecutionError,
  type ExecutionErrorDetail,
} from "./execution-errors";

describe("structured execution errors", () => {
  it("keeps stable control-flow fields separate from human-readable detail", () => {
    const detail: ExecutionErrorDetail = {
      code: "provider_rate_limited",
      category: "rate_limit",
      phase: "provider_connect",
      retryable: true,
      retryAfterMs: 2_000,
      message: "The provider asked us to wait.",
      cause: { name: "APICallError", message: "429 slow down" },
    };
    const error = new StructuredExecutionError(detail);

    expect(isStructuredExecutionError(error)).toBe(true);
    expect(error.detail).toEqual(detail);
    expect(error.message).toBe("The provider asked us to wait.");
  });
});
