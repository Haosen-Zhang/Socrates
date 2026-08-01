import { describe, expect, it } from "bun:test";
import type { CollaborationRuntimeCapabilities } from "@socrates/core";
import { canEditCollaboration, collaborationStrategyOptions } from "./collaborationSettingsUi";

describe("collaboration settings capability gating", () => {
  it("keeps unsupported adaptive visible but impossible to select", () => {
    const capabilities: CollaborationRuntimeCapabilities = {
      supportedStrategies: ["single", "team"],
      discussion: true,
      routing: false,
      planConfirmation: ["user"],
    };
    expect(collaborationStrategyOptions(capabilities)).toEqual([
      { strategy: "single", enabled: true },
      { strategy: "adaptive", enabled: false },
      { strategy: "team", enabled: true },
    ]);
  });

  it("fails closed before the backend handshake arrives", () => {
    expect(collaborationStrategyOptions(null)).toEqual([
      { strategy: "single", enabled: false },
      { strategy: "adaptive", enabled: false },
      { strategy: "team", enabled: false },
    ]);
  });

  it("keeps collaboration settings closed while a task can still resume or execute", () => {
    expect(canEditCollaboration(null)).toBe(true);
    expect(canEditCollaboration("completed")).toBe(true);
    expect(canEditCollaboration("failed")).toBe(true);
    expect(canEditCollaboration("cancelled")).toBe(true);
    expect(canEditCollaboration("paused")).toBe(false);
    expect(canEditCollaboration("discussing")).toBe(false);
    expect(canEditCollaboration("awaiting_plan_approval")).toBe(false);
  });
});
