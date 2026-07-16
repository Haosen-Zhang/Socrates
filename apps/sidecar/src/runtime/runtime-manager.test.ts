import { describe, expect, it } from "bun:test";
import type { AgentRuntime, RuntimeEvent } from "@socrates/core";
import { UNKNOWN_MODEL_CAPABILITIES } from "@socrates/core";
import { openDb } from "../db";
import { EventStore } from "../store/event-store";
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

describe("RuntimeManager", () => {
  it("journals normalized runtime events before exposing completion", async () => {
    const db = openDb(":memory:");
    db.query("INSERT INTO sessions (id, title, mode, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run("s", "Session", "single_agent", "idle", "now", "now");
    const events = new EventStore(db);
    const manager = new RuntimeManager(db, events);
    manager.register("fake", () => new FakeRuntime());
    const handle = await manager.open({ runtimeKind: "fake", agentSessionId: "as", sessionId: "s", agentId: "a" });
    const seen = await manager.run(handle.id, { taskId: "task", prompt: "go" });
    expect(seen.map((event) => event.type)).toEqual(["text_delta", "tool_call", "approval_required", "extension", "status"]);
    expect(events.listAfter("s", 0).map((event) => event.type)).toEqual([
      "runtime.text_delta", "runtime.tool_call", "runtime.approval_required", "runtime.extension", "runtime.status",
    ]);
    expect(manager.get(handle.id)?.status).toBe("completed");
  });

  it("marks non-authoritative active sessions interrupted on recovery", async () => {
    const db = openDb(":memory:");
    const manager = new RuntimeManager(db, new EventStore(db));
    db.query("INSERT INTO runtime_sessions (id, agent_session_id, runtime_kind, protocol_version, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("old", "as", "fake", "1", "running", "now", "now");
    expect(manager.recoverInterrupted()).toBe(1);
    expect(manager.get("old")?.status).toBe("interrupted");
  });
});
