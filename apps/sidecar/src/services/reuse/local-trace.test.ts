import { expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { openDb } from "../../db";
import { SessionStore } from "../../store/session-store";
import { EventStore } from "../../store/event-store";
import { LocalServiceTracer } from "./local-trace";

test("persisted service events produce local SDK spans; payload and secrets cannot become attributes", async () => {
  const db = openDb(":memory:");
  const room = new SessionStore(db).create({ title: "Trace fixture", mode: "chat", primaryAgentId: "a", agents: [{ agentId: "a", snapshot: {}, executionEligible: true }] });
  const event = new EventStore(db).append({ eventId: "fixture-event", sessionId: room.id, taskId: "task", type: "cost.invocation_priced",
    payload: { apiKey: "secret-fixture", prompt: "private-fixture", reasoning: "private-reasoning", costAtomic: "8050000000" } });
  const exporter = new InMemorySpanExporter();
  const tracer = new LocalServiceTracer({ exporter });
  const ids = tracer.recordEvent(event);
  await tracer.flush();
  const spans = exporter.getFinishedSpans();
  expect(spans).toHaveLength(1);
  expect(spans[0]!.attributes).toMatchObject({ "socrates.event_id": "fixture-event", "socrates.room_id": room.id, "socrates.root_task_id": "task" });
  expect(JSON.stringify(spans[0]!.attributes)).not.toContain("private");
  expect(JSON.stringify(spans[0]!.attributes)).not.toContain("secret");
  expect(ids.traceId).toMatch(/^[0-9a-f]{32}$/);
  expect(ids.spanId).toMatch(/^[0-9a-f]{16}$/);
  await tracer.shutdown();
  db.close();
});

test("default tracing remains usable with no exporter and ignores environment export settings", async () => {
  const old = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "https://invalid.example/private";
  try {
    const tracer = new LocalServiceTracer();
    const ids = tracer.recordEvent({ eventId: "offline", sessionId: "room", seq: 1, type: "budget.reserved", payload: {}, occurredAt: new Date().toISOString() });
    expect(ids.traceId).not.toBe("0".repeat(32));
    await tracer.flush();
    await tracer.shutdown();
  } finally {
    if (old === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = old;
  }
});
