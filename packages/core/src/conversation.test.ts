import { describe, expect, it } from "bun:test";
import { modeToolCeiling, validateConversation } from "./conversation";

describe("conversation modes", () => {
  it("requires the correct participant cardinality", () => {
    expect(validateConversation({ mode: "chat", agentIds: [] })).toEqual([]);
    expect(validateConversation({ mode: "single_agent", agentIds: [] })).toContain("single_agent_requires_one_agent");
    expect(validateConversation({ mode: "single_agent", agentIds: ["a", "b"] })).toContain("single_agent_requires_one_agent");
    expect(validateConversation({ mode: "multi_agent", agentIds: ["a"] })).toContain("multi_agent_requires_multiple_agents");
    expect(validateConversation({ mode: "multi_agent", agentIds: ["a", "b"] })).toEqual([]);
  });

  it("fails closed for tool ceilings", () => {
    expect(modeToolCeiling("chat", "idle")).toEqual([]);
    expect(modeToolCeiling("multi_agent", "discussing")).toEqual(["workspace_read"]);
    expect(modeToolCeiling("multi_agent", "synthesizing")).toEqual(["workspace_read"]);
    expect(modeToolCeiling("multi_agent", "executing")).toContain("workspace_write");
  });
});
