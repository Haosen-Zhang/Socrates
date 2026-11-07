import { describe, expect, it } from "bun:test";
import { DEFAULT_COLLABORATION_SETTINGS, validateCollaborationSettings, type CollaborationRuntimeCapabilities } from "@socrates/core";
import { canEditCollaboration, collaborationStrategyOptions, createCollaborationDraft } from "./collaborationSettingsUi";

describe("collaboration settings capability gating", () => {
  it("lets an old Chat room enable discussion after members were added", () => {
    const room = { kind: "chat" as const, workspaceId: null, primaryAgentId: "a", agentIds: ["a", "b", "c"] };
    const draft = createCollaborationDraft(room, DEFAULT_COLLABORATION_SETTINGS);
    draft.discussion.enabled = true;
    draft.discussion.maxRounds = 3;
    expect(draft.discussion.speakerOrder).toEqual(["a", "b", "c"]);
    expect(draft.discussion.summaryAgentId).toBe("a");
    expect(validateCollaborationSettings(room, draft)).toEqual([]);
    expect(DEFAULT_COLLABORATION_SETTINGS.discussion.speakerOrder).toEqual([]);
  });

  it("preserves an explicitly selected discussion subset and order", () => {
    const room = { kind: "chat" as const, workspaceId: null, primaryAgentId: "a", agentIds: ["a", "b", "c"] };
    const draft = createCollaborationDraft(room, { ...DEFAULT_COLLABORATION_SETTINGS,
      discussion: { ...DEFAULT_COLLABORATION_SETTINGS.discussion, enabled: true, speakerOrder: ["c", "b"], summaryAgentId: "b" } });
    expect(draft.discussion.speakerOrder).toEqual(["c", "b"]);
    expect(draft.discussion.summaryAgentId).toBe("b");
    expect(validateCollaborationSettings(room, draft)).toEqual([]);
  });

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
