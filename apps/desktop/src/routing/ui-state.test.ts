import { expect, it } from "bun:test";
import { DEFAULT_COLLABORATION_SETTINGS, type RoomCollaborationSettings } from "@socrates/core";
import { applyRoutingPreset, routingPreset, toggleCallableMember } from "./ui-state";

function configured(): RoomCollaborationSettings {
  return { ...DEFAULT_COLLABORATION_SETTINGS, strategy: "team", assignment: { coordinatorAgentId: "manager", callableAgentIds: ["manager", "worker"], routing: { ...DEFAULT_COLLABORATION_SETTINGS.assignment.routing, lightweightAgentId: "worker", fallbackAgentIds: ["manager"], allowedProviderIds: ["permitted"], limits: { maxRetries: 2, maxEscalations: 0, maxTotalModelCalls: 9 } } } };
}

it("preserves legacy rooms until a preset is explicitly chosen", () => {
  const settings = configured();
  expect(routingPreset(settings)).toBeNull();
  expect(settings.strategy).toBe("team");
  expect(routingPreset(DEFAULT_COLLABORATION_SETTINGS)).toBeNull();
});

it("maps four presets to real routing while preserving restricted members, providers and fallback permissions", () => {
  const original = configured();
  for (const [preset, policy] of [["economy", "cost"], ["balanced", "balanced"], ["quality", "quality"]] as const) {
    const next = applyRoutingPreset(original, preset, "primary");
    expect(next.strategy).toBe("adaptive");
    expect(next.assignment.routing.mode).toBe("automatic");
    expect(next.assignment.routing.automaticPolicy).toBe(policy);
    expect(next.assignment.callableAgentIds).toEqual(["manager", "worker"]);
    expect(next.assignment.routing.allowedProviderIds).toEqual(["permitted"]);
    expect(next.assignment.routing.fallbackAgentIds).toEqual(["manager"]);
    expect(next.assignment.routing.limits).toEqual({ maxRetries: 2, maxEscalations: 0, maxTotalModelCalls: 9 });
  }
  const manual = applyRoutingPreset(original, "custom", "primary");
  expect(manual.strategy).toBe("team");
  expect(manual.assignment.routing.mode).toBe("manual");
  expect(manual.assignment.routing.lightweightAgentId).toBe("worker");
  expect(original.assignment.routing.mode).toBe("automatic");
});

it("uses one real member for an adaptive room without creating hidden teammates", () => {
  const next = applyRoutingPreset(DEFAULT_COLLABORATION_SETTINGS, "balanced", "only-member");
  expect(next.assignment.coordinatorAgentId).toBe("only-member");
  expect(next.assignment.callableAgentIds).toEqual([]);
  expect(next.assignment.routing.fallbackAgentIds).toBeUndefined();
});

it("turns a legacy all-members selection into an explicit subset and never makes deselect-all mean all", () => {
  expect(toggleCallableMember([], ["a", "b", "c"], "b", false)).toEqual(["a", "c"]);
  expect(toggleCallableMember(["a"], ["a", "b", "c"], "b", true)).toEqual(["a", "b"]);
  expect(() => toggleCallableMember(["a"], ["a", "b"], "a", false)).toThrow("route_keep_one_member");
});
