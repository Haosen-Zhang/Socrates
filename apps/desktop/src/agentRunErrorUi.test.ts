import { describe, expect, it } from "bun:test";
import { agentRunErrorKey } from "./agentRunErrorUi";

describe("agent run error UI", () => {
  it("maps the pre-provider context failure to a user-facing recovery message", () => {
    expect(agentRunErrorKey("context_current_unit_exceeds_budget"))
      .toBe("agent_error_context_budget");
  });

  it("preserves unknown Provider errors for diagnostics", () => {
    expect(agentRunErrorKey("provider_rate_limited")).toBe("provider_rate_limited");
  });
});
