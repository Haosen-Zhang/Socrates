import { describe, expect, it } from "bun:test";
import type { AgentRuntime, RuntimeEvent } from "@socrates/core";
import { UNKNOWN_MODEL_CAPABILITIES } from "@socrates/core";
import { openDb } from "../db";
import { ExecutionEventStore } from "../store/execution-event-store";
import { RuntimeManager } from "./runtime-manager";

class FakeRuntime implements AgentRuntime {
  readonly kind = "fake";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  interrupted = false;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "text_delta", text: "hello" };
    yield { type: "tool_call", callId: "call", name: "read_file", input: { path: "a" } };
    yield { type: "approval_required", requestId: "approval", callId: "call" };
    yield { type: "extension", name: "future", payload: { kept: true } };
    yield { type: "status", status: "completed" };
  }
  async answerApproval() {}
  async interrupt() { this.interrupted = true; }
  async close() {}
}

class SemanticRuntime implements AgentRuntime {
  readonly kind = "semantic";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  providerCalls = 0;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 1 } };
    this.providerCalls += 1;
    yield { type: "extension", name: "provider_attempt_failed", payload: {
      attemptNo: 1,
      error: { code: "provider_unavailable", category: "provider", phase: "provider_connect", retryable: true, message: "down" },
      outputStarted: false,
      willRetry: true,
    } };
    yield { type: "extension", name: "provider_retry_scheduled", payload: {
      failedAttemptNo: 1, nextAttemptNo: 2, delayMs: 250, errorCode: "provider_unavailable",
    } };
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 2 } };
    this.providerCalls += 1;
    yield { type: "text_delta", text: "done" };
    yield { type: "extension", name: "provider_attempt_completed", payload: { attemptNo: 2 } };
    yield { type: "extension", name: "provider_step_completed", payload: {} };
  }
  async answerApproval() {}
  async interrupt() {}
  async close() {}
}

class ToolBoundaryRuntime implements AgentRuntime {
  readonly kind = "tool-boundary";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  providerCalls = 0;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 1 } };
    this.providerCalls += 1;
    yield {
      type: "tool_result",
      callId: "call",
      name: "read_file",
      output: { preview: "data", byteSize: 4, truncated: false },
      isError: false,
    };
    yield { type: "extension", name: "provider_attempt_completed", payload: { attemptNo: 1 } };
    yield { type: "extension", name: "provider_step_completed", payload: {} };
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 1 } };
    this.providerCalls += 1;
  }
  async answerApproval() {}
  async interrupt() {}
  async close() {}
}

class InvalidRetryRuntime implements AgentRuntime {
  readonly kind = "invalid-retry";
  readonly capabilities = { ...UNKNOWN_MODEL_CAPABILITIES, textInput: true as const };
  providerCalls = 0;
  async open() {}
  async *start(): AsyncIterable<RuntimeEvent> {
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 1 } };
    this.providerCalls += 1;
    yield { type: "extension", name: "provider_attempt_failed", payload: {
      attemptNo: 1,
      error: { code: "provider_stream_failed", category: "provider", phase: "provider_stream", retryable: false, message: "partial" },
      outputStarted: true,
      willRetry: false,
    } };
    yield { type: "extension", name: "provider_retry_scheduled", payload: {
      failedAttemptNo: 1, nextAttemptNo: 2, delayMs: 0, errorCode: "provider_stream_failed",
    } };
    yield { type: "extension", name: "provider_attempt_started", payload: { attemptNo: 2 } };
    this.providerCalls += 1;
  }
  async answerApproval() {}
  async interrupt() {}
  async close() {}
}

describe("RuntimeManager", () => {
  it("persists Step and ProviderAttempt semantics around one model step", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s", "Session", "single_agent", "idle", "now", "now");
    const events = new ExecutionEventStore(db);
    const manager = new RuntimeManager(db, events);
    const runtime = new SemanticRuntime();
    manager.register("semantic", () => runtime);
    const handle = await manager.open({ runtimeKind: "semantic", agentSessionId: "as", sessionId: "s", agentId: "a" });
    await manager.run(handle.id, { taskId: "run", turnId: "turn", prompt: "go" });

    expect(runtime.providerCalls).toBe(2);
    expect(events.listAfter("run", 0).map((event) => ({
      type: event.type,
      stepId: event.coordinates.stepId,
      providerAttemptId: event.coordinates.providerAttemptId,
    }))).toEqual([
      { type: "step.started", stepId: "run:turn:turn:step:1", providerAttemptId: undefined },
      { type: "provider.attempt.started", stepId: "run:turn:turn:step:1", providerAttemptId: "run:turn:turn:step:1:provider:1" },
      { type: "provider.attempt.failed", stepId: "run:turn:turn:step:1", providerAttemptId: "run:turn:turn:step:1:provider:1" },
      { type: "provider.retry_scheduled", stepId: "run:turn:turn:step:1", providerAttemptId: "run:turn:turn:step:1:provider:1" },
      { type: "provider.attempt.started", stepId: "run:turn:turn:step:1", providerAttemptId: "run:turn:turn:step:1:provider:2" },
      { type: "runtime.event", stepId: "run:turn:turn:step:1", providerAttemptId: "run:turn:turn:step:1:provider:2" },
      { type: "provider.attempt.completed", stepId: "run:turn:turn:step:1", providerAttemptId: "run:turn:turn:step:1:provider:2" },
      { type: "step.completed", stepId: "run:turn:turn:step:1", providerAttemptId: undefined },
    ]);
  });

  it("rejects a retry after authoritative output before a second Provider call", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s", "Session", "single_agent", "idle", "now", "now");
    const events = new ExecutionEventStore(db);
    const manager = new RuntimeManager(db, events);
    const runtime = new InvalidRetryRuntime();
    manager.register("invalid-retry", () => runtime);
    const handle = await manager.open({ runtimeKind: "invalid-retry", agentSessionId: "as", sessionId: "s", agentId: "a" });

    await expect(manager.run(handle.id, { taskId: "run", turnId: "turn", prompt: "go" }))
      .rejects.toThrow("provider_retry_transition_invalid");
    expect(runtime.providerCalls).toBe(1);
    expect(events.listAfter("run", 0).map((event) => event.type)).toEqual([
      "step.started",
      "provider.attempt.started",
      "provider.attempt.failed",
      "step.failed",
      "runtime.event",
    ]);
  });

  it("fails closed before invoking the Provider when the pre-request checkpoint cannot persist", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s", "Session", "single_agent", "idle", "now", "now");
    const stored = new ExecutionEventStore(db);
    const events = new Proxy(stored, {
      get(target, property, receiver) {
        if (property !== "append") return Reflect.get(target, property, receiver);
        return (input: { type: string }) => {
          if (input.type === "step.started") throw new Error("checkpoint_unavailable");
          return target.append(input as never);
        };
      },
    });
    const manager = new RuntimeManager(db, events);
    const runtime = new SemanticRuntime();
    manager.register("semantic", () => runtime);
    const handle = await manager.open({ runtimeKind: "semantic", agentSessionId: "as", sessionId: "s", agentId: "a" });
    await expect(manager.run(handle.id, { taskId: "run", turnId: "turn", prompt: "go" }))
      .rejects.toThrow("checkpoint_unavailable");
    expect(runtime.providerCalls).toBe(0);
  });

  it("does not start the next Step until the durable tool-result consumer succeeds", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s", "Session", "single_agent", "idle", "now", "now");
    const events = new ExecutionEventStore(db);
    const manager = new RuntimeManager(db, events);
    const runtime = new ToolBoundaryRuntime();
    manager.register("tool-boundary", () => runtime);
    const handle = await manager.open({ runtimeKind: "tool-boundary", agentSessionId: "as", sessionId: "s", agentId: "a" });
    await expect(manager.run(handle.id, {
      taskId: "run", turnId: "turn", prompt: "go",
      onEvent: (event) => {
        if (event.type === "tool_result") throw new Error("tool_result_projection_failed");
      },
    })).rejects.toThrow("tool_result_projection_failed");
    expect(runtime.providerCalls).toBe(1);
    expect(events.listAfter("run", 0).map((event) => event.type)).toEqual([
      "step.started",
      "provider.attempt.started",
      "runtime.event",
      "step.failed",
    ]);
  });

  it("journals normalized runtime events before exposing completion", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s", "Session", "single_agent", "idle", "now", "now");
    const events = new ExecutionEventStore(db);
    const manager = new RuntimeManager(db, events);
    manager.register("fake", () => new FakeRuntime());
    const handle = await manager.open({ runtimeKind: "fake", agentSessionId: "as", sessionId: "s", agentId: "a" });
    const delivered: string[] = [];
    const seen = await manager.run(handle.id, { taskId: "task", turnId: "turn", prompt: "go", onEvent: (event) => { delivered.push(event.type); } });
    expect(seen.map((event) => event.type)).toEqual(["text_delta", "tool_call", "approval_required", "extension", "status"]);
    expect(events.listAfter("task", 0).map((event) => ({
      type: event.type,
      runtimeType: event.type === "runtime.event"
        ? (event.payload as { event: RuntimeEvent }).event.type
        : null,
      turnId: event.coordinates.turnId,
    }))).toEqual([
      { type: "runtime.event", runtimeType: "text_delta", turnId: "turn" },
      { type: "runtime.event", runtimeType: "tool_call", turnId: "turn" },
      { type: "runtime.event", runtimeType: "approval_required", turnId: "turn" },
      { type: "runtime.event", runtimeType: "extension", turnId: "turn" },
      { type: "runtime.event", runtimeType: "status", turnId: "turn" },
    ]);
    expect(manager.get(handle.id)?.status).toBe("completed");
    expect(events.listAfter("task", 0)[3]?.payload).toMatchObject({
      event: {
        type: "extension",
        name: "future",
        payload: { kept: true },
      },
    });
    expect(delivered).toEqual(seen.map((event) => event.type));
  });

  it("marks non-authoritative active sessions interrupted on recovery", async () => {
    const db = openDb(":memory:");
    const manager = new RuntimeManager(db, new ExecutionEventStore(db));
    db.query("INSERT INTO runtime_sessions (id, agent_session_id, runtime_kind, protocol_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("old", "as", "fake", "1", "running", "now", "now");
    expect(manager.recoverInterrupted()).toBe(1);
    expect(manager.get("old")?.status).toBe("interrupted");
  });
});
