import { describe, expect, it } from "bun:test";
import { classifyProviderError } from "./provider-errors";
import { executeProviderWithRetry } from "./provider-retry";

type SamplePart = { type: "text"; text: string };

async function drain<T>(iterable: AsyncIterable<T>, events: T[]): Promise<void> {
  for await (const event of iterable) events.push(event);
}

describe("explicit Provider retry policy", () => {
  it("retries a transient failure once, outside the Provider adapter", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const events = [];

    for await (const event of executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        if (attempts === 1) throw new TypeError("fetch failed");
        yield { type: "text", text: "ok" };
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
      random: () => 0.5,
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    })) events.push(event);

    expect(attempts).toBe(2);
    expect(sleeps).toEqual([250]);
    expect(events.map((event) => event.type)).toEqual([
      "provider_attempt_started",
      "provider_attempt_failed",
      "provider_retry_scheduled",
      "provider_attempt_started",
      "text",
    ]);
  });

  it("allows four transient failures and succeeds on the fifth finite attempt", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const events = [];
    for await (const event of executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        if (attempts < 5) throw Object.assign(new Error("unavailable"), { statusCode: 503 });
        yield { type: "text", text: "fifth" };
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
      random: () => 0.5,
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    })) events.push(event);

    expect(attempts).toBe(5);
    expect(sleeps).toEqual([250, 500, 1_000, 2_000]);
    expect(events.filter((event) => event.type === "provider_attempt_failed")).toHaveLength(4);
    expect(events.at(-1)).toEqual({ type: "text", text: "fifth" });
  });

  it("fails with a stable exhaustion error after five transient failures", async () => {
    let attempts = 0;
    const events: Array<{ type: string }> = [];
    const iterable = executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        throw Object.assign(new Error("unavailable"), { statusCode: 503 });
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
      random: () => 0.5,
      sleep: async () => {},
    });

    await expect(drain(iterable, events)).rejects.toMatchObject({
      detail: { code: "provider_retry_exhausted", retryable: false },
    });
    expect(attempts).toBe(5);
    expect(events.filter((event) => event.type === "provider_attempt_failed")).toHaveLength(5);
  });

  it("respects Retry-After but caps it at the configured safe maximum", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    for await (const _event of executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        if (attempts === 1) throw {
          statusCode: 429,
          message: "wait",
          responseHeaders: { "retry-after": "120" },
        };
        yield { type: "text", text: "ok" };
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
      sleep: async (delayMs) => { sleeps.push(delayMs); },
    })) {}
    expect(sleeps).toEqual([30_000]);
  });

  it("does not retry permanent authentication failures", async () => {
    let attempts = 0;
    const events: Array<{ type: string }> = [];
    const iterable = executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        throw { statusCode: 401, message: "bad key" };
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
    });
    await expect(drain(iterable, events)).rejects.toMatchObject({
      detail: { code: "provider_authentication_failed", retryable: false },
    });
    expect(attempts).toBe(1);
    expect(events.map((event) => event.type)).toEqual([
      "provider_attempt_started", "provider_attempt_failed",
    ]);
  });

  it("does not retry an invalid Provider request", async () => {
    let attempts = 0;
    const events: Array<{ type: string }> = [];
    const iterable = executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        throw { statusCode: 400, message: "invalid schema" };
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
    });
    await expect(drain(iterable, events)).rejects.toMatchObject({
      detail: { code: "provider_invalid_request", retryable: false },
    });
    expect(attempts).toBe(1);
  });

  it("cancels during backoff without starting another attempt", async () => {
    const controller = new AbortController();
    let attempts = 0;
    const events: Array<{ type: string }> = [];
    const iterable = executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        throw new TypeError("fetch failed");
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
      signal: controller.signal,
      sleep: async () => { controller.abort(); },
    });
    await expect(drain(iterable, events)).rejects.toMatchObject({
      detail: { code: "provider_cancelled", category: "cancelled" },
    });
    expect(attempts).toBe(1);
  });

  it("retries a classified empty response before any authoritative output", async () => {
    let attempts = 0;
    const events = [];
    for await (const event of executeProviderWithRetry<SamplePart>({
      openAttempt: async function* () {
        attempts += 1;
        if (attempts === 1) return;
        yield { type: "text", text: "not empty" };
      },
      classifyError: classifyProviderError,
      isAuthoritativeOutput: () => true,
      sleep: async () => {},
    })) events.push(event);
    expect(attempts).toBe(2);
    expect(events.find((event) => event.type === "provider_attempt_failed"))
      .toMatchObject({ error: { code: "provider_empty_response" }, willRetry: true });
  });

  it("never blindly retries after partial text or a generated tool call", async () => {
    for (const first of [
      { type: "text", text: "partial" },
      { type: "tool_call", text: "call" },
    ]) {
      let attempts = 0;
      const events: Array<{ type: string }> = [];
      const iterable = executeProviderWithRetry<{ type: string; text: string }>({
        openAttempt: async function* () {
          attempts += 1;
          yield first;
          throw Object.assign(new Error("connection reset"), { code: "ECONNRESET" });
        },
        classifyError: classifyProviderError,
        isAuthoritativeOutput: () => true,
        sleep: async () => {},
      });
      await expect(drain(iterable, events)).rejects.toMatchObject({
        detail: { code: "provider_retry_unsafe_after_output", retryable: false },
      });
      expect(attempts).toBe(1);
      expect(events.find((event) => event.type === "provider_attempt_failed"))
        .toMatchObject({ outputStarted: true, willRetry: false });
    }
  });
});
