import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";
import type { RunSupervisor } from "../runtime/run-supervisor";
import { ExecutionEventStore } from "../store/execution-event-store";
import { agentRunRoutes } from "./agent-runs";

describe("agent runtime capability handshake", () => {
  it("advertises only the approval modes the backend enforces", async () => {
    const db = openDb(":memory:");
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(
        {} as RunSupervisor,
        {} as SingleAgentRunner,
        new ApprovalManager(db),
        new ExecutionEventStore(db),
      ),
    );
    const response = await app.request("/agent/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      approvalPolicy: {
        supportedModes: ["ask", "auto_safe", "workspace_full"],
        defaultMode: "ask",
        policyVersion: 1,
        hardDenials: ["outside.write", "secret.read"],
        freshHumanRisks: ["destructive"],
      },
      collaboration: {
        supportedStrategies: ["single", "team"],
        discussion: true,
        routing: false,
        planConfirmation: ["user"],
      },
    });
  });
});

describe("durable agent run transport", () => {
  it("starts a run independently from its event observer", async () => {
    const db = openDb(":memory:");
    const supervisor = {
      start: async () => ({ runId: "run-1", turnId: "turn-1", threadId: "thread-1", replayed: false }),
    } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(
        supervisor,
        {} as SingleAgentRunner,
        new ApprovalManager(db),
        new ExecutionEventStore(db),
      ),
    );

    const response = await app.request("/agent/sessions/session-1/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: "work" }),
    });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      runId: "run-1", turnId: "turn-1", threadId: "thread-1", replayed: false,
    });
  });

  it("replays only events after the durable cursor with SSE sequence ids", async () => {
    const db = openDb(":memory:");
    const events = new ExecutionEventStore(db);
    for (const [index, type] of ["run.created", "run.completed"].entries()) {
      events.append({
        eventId: `event-${index + 1}`,
        sessionId: "session-1",
        runId: "run-1",
        agentId: "agent-1",
        type: type as "run.created" | "run.completed",
        coordinates: {},
        payload: type === "run.created"
          ? { threadId: "thread-1", attemptNo: 1 }
          : {},
      });
    }
    const supervisor = {
      get: () => ({ id: "run-1", status: "completed" }),
    } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(supervisor, {} as SingleAgentRunner, new ApprovalManager(db), events),
    );

    const response = await app.request("/agent/runs/run-1/events?afterSeq=1");
    const body = await response.text();
    expect(response.status).toBe(200);
    expect(body).toContain("id: 2");
    expect(body).toContain("event: run.completed");
    expect(body).not.toContain("id: 1");
  });

  it("continues from replay into a newly committed live event without a gap", async () => {
    const db = openDb(":memory:");
    const events = new ExecutionEventStore(db);
    events.append({
      eventId: "event-1",
      sessionId: "session-1",
      runId: "run-live",
      agentId: "agent-1",
      type: "run.created",
      coordinates: {},
      payload: { threadId: "thread-1", attemptNo: 1 },
    });
    const supervisor = {
      get: () => ({ id: "run-live", status: "running" }),
    } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(supervisor, {} as SingleAgentRunner, new ApprovalManager(db), events),
    );

    const response = await app.request("/agent/runs/run-live/events?afterSeq=0");
    events.append({
      eventId: "event-2",
      sessionId: "session-1",
      runId: "run-live",
      agentId: "agent-1",
      type: "run.completed",
      coordinates: {},
      payload: {},
    });
    const body = await response.text();
    expect(body.match(/^id: /gm)?.length).toBe(2);
    expect(body).toContain("id: 1");
    expect(body).toContain("id: 2");
  });

  it("rejects a cursor beyond the durable Run tail", async () => {
    const db = openDb(":memory:");
    const supervisor = {
      get: () => ({ id: "run-1", status: "running" }),
    } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(
        supervisor,
        {} as SingleAgentRunner,
        new ApprovalManager(db),
        new ExecutionEventStore(db),
      ),
    );
    const response = await app.request("/agent/runs/run-1/events?afterSeq=1");
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "execution_event_cursor_ahead" });
  });

  it("rejects an unknown Run before opening an SSE response", async () => {
    const db = openDb(":memory:");
    const supervisor = { get: () => null } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(
        supervisor,
        {} as SingleAgentRunner,
        new ApprovalManager(db),
        new ExecutionEventStore(db),
      ),
    );

    const response = await app.request("/agent/runs/missing/events?afterSeq=0");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "agent_run_not_found" });
  });
});
