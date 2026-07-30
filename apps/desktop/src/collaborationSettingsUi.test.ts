import { describe, expect, it } from "bun:test";
import type { CollaborationRuntimeCapabilities } from "@socrates/core";
import { collaborationStrategyOptions } from "./collaborationSettingsUi";

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
});
