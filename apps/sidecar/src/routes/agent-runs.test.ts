import { describe, expect, it } from "bun:test";
import { Hono } from "hono";
import { openDb } from "../db";
import { ApprovalManager } from "../approvals/manager";
import type { SingleAgentRunner } from "../runtime/single-agent-runner";
import { agentRunRoutes } from "./agent-runs";

describe("agent runtime capability handshake", () => {
  it("advertises only the approval modes the backend enforces", async () => {
    const app = new Hono().route(
      "/agent",
      agentRunRoutes({} as SingleAgentRunner, new ApprovalManager(openDb(":memory:"))),
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
