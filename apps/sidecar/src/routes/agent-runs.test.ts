import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";
import type { RunSupervisor } from "../runtime/run-supervisor";
import { agentRunRoutes } from "./agent-runs";

describe("agent runtime capability handshake", () => {
  it("advertises only the approval modes the backend enforces", async () => {
    const app = new Hono().route(
      "/agent",
      agentRunRoutes({} as RunSupervisor, {} as SingleAgentRunner, new ApprovalManager(openDb(":memory:"))),
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
    const supervisor = {
      start: async () => ({ runId: "run-1", turnId: "turn-1", threadId: "thread-1", replayed: false }),
    } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(supervisor, {} as SingleAgentRunner, new ApprovalManager(openDb(":memory:"))),
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

  it("rejects an unknown live observer before opening an SSE response", async () => {
    const supervisor = {
      observe: () => { throw new Error("agent_run_not_supervised"); },
    } as unknown as RunSupervisor;
    const app = new Hono().route(
      "/agent",
      agentRunRoutes(supervisor, {} as SingleAgentRunner, new ApprovalManager(openDb(":memory:"))),
    );

    const response = await app.request("/agent/runs/missing/events");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "agent_run_not_supervised" });
  });
});
