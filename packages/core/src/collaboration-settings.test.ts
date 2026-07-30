import { describe, expect, it } from "bun:test";
import {
  DEFAULT_COLLABORATION_SETTINGS,
  normalizeCollaborationSettings,
  resolveCollaborationDefaults,
  validateCollaborationCapabilities,
  validateCollaborationSettings,
  type RoomCollaborationSettings,
} from "./room-kind";

const room = (agentIds = ["a", "b", "c"]) => ({
  kind: "cowork" as const,
  workspaceId: "workspace",
  agentIds,
  primaryAgentId: agentIds[0] ?? null,
});

const settings = (
  patch: Partial<RoomCollaborationSettings> = {},
): RoomCollaborationSettings => ({
  ...DEFAULT_COLLABORATION_SETTINGS,
  ...patch,
  assignment: {
    ...DEFAULT_COLLABORATION_SETTINGS.assignment,
    ...(patch.assignment ?? {}),
    routing: {
      ...DEFAULT_COLLABORATION_SETTINGS.assignment.routing,
      ...(patch.assignment?.routing ?? {}),
    },
  },
  discussion: {
    ...DEFAULT_COLLABORATION_SETTINGS.discussion,
    ...(patch.discussion ?? {}),
  },
  planConfirmation: {
    ...DEFAULT_COLLABORATION_SETTINGS.planConfirmation,
    ...(patch.planConfirmation ?? {}),
  },
});

describe("collaboration settings v2", () => {
  it("normalizes legacy Boss settings into the canonical team model", () => {
    expect(normalizeCollaborationSettings({
      discussionMode: "round_robin",
      collaborationMode: "agent_directed_multi_agent",
      boss: { enabled: true, bossAgentId: "b" },
      approvalMode: "designated_reviewer",
      designatedReviewerId: "c",
    })).toMatchObject({
      strategy: "team",
      assignment: { coordinatorAgentId: "b" },
      discussion: { enabled: true, mode: "round_robin" },
      planConfirmation: { mode: "reviewer", reviewerAgentId: "c" },
    });
  });

  it("keeps disabled discussion details but makes them non-effective", () => {
    const disabled = settings({
      discussion: {
        enabled: false,
        mode: "debate",
        maxRounds: 4,
        speakerOrder: ["missing"],
        summaryAgentId: "missing",
      },
    });
    expect(validateCollaborationSettings(room(), disabled)).toEqual([]);
    expect(disabled.discussion.mode).toBe("debate");
  });

  it("validates team assignments and permits one Agent to hold several roles", () => {
    const valid = settings({
      strategy: "team",
      assignment: {
        coordinatorAgentId: "a",
        callableAgentIds: ["a", "b"],
        routing: {
          mode: "manual",
          automaticPolicy: "balanced",
          lightweightAgentId: "a",
          complexAgentId: "a",
          criticalAgentId: null,
        },
      },
    });
    expect(validateCollaborationSettings(room(), valid)).toEqual([]);
    expect(validateCollaborationSettings(room(["a"]), valid)).toContain(
      "team_requires_multiple_members",
    );
  });

  it("resolves global defaults against room members without using member order as authority", () => {
    const resolved = resolveCollaborationDefaults(
      settings({
        strategy: "team",
        assignment: {
          coordinatorAgentId: null,
          callableAgentIds: [],
          routing: {
            mode: "manual",
            automaticPolicy: "quality",
            lightweightAgentId: null,
            complexAgentId: null,
            criticalAgentId: null,
          },
        },
        discussion: {
          enabled: true,
          mode: "round_robin",
          maxRounds: 2,
          speakerOrder: [],
          summaryAgentId: null,
        },
      }),
      room(["secondary", "primary"]),
      "primary",
    );

    expect(resolved.assignment.coordinatorAgentId).toBe("primary");
    expect(resolved.assignment.callableAgentIds).toEqual(["secondary", "primary"]);
    expect(resolved.assignment.routing.lightweightAgentId).toBe("primary");
    expect(resolved.discussion.summaryAgentId).toBe("primary");
  });

  it("requires reviewer confirmation to reference a room member", () => {
    expect(validateCollaborationSettings(
      room(),
      settings({
        planConfirmation: { mode: "reviewer", reviewerAgentId: "missing" },
      }),
    )).toContain("reviewer_must_be_room_member");
  });

  it("degrades multi-Agent global defaults for a one-member room", () => {
    const resolved = resolveCollaborationDefaults(
      settings({
        strategy: "team",
        discussion: {
          ...DEFAULT_COLLABORATION_SETTINGS.discussion,
          enabled: true,
        },
      }),
      room(["only"]),
      "only",
    );
    expect(resolved.strategy).toBe("single");
    expect(resolved.discussion.enabled).toBeFalse();
  });

  it("keeps legacy Chat rooms outside execution collaboration", () => {
    expect(validateCollaborationSettings(
      { kind: "chat", workspaceId: null, agentIds: ["a", "b"] },
      settings({ strategy: "team" }),
    )).toContain("chat_room_has_no_execution_strategy");
    expect(validateCollaborationSettings(
      { kind: "chat", workspaceId: null, agentIds: ["a"] },
      settings({
        planConfirmation: { mode: "coordinator", reviewerAgentId: null },
      }),
    )).toContain("chat_room_has_no_plan_confirmation");
  });

  it("rejects configured routing while the runtime capability is unavailable", () => {
    expect(validateCollaborationCapabilities(settings({
      assignment: {
        ...DEFAULT_COLLABORATION_SETTINGS.assignment,
        routing: {
          ...DEFAULT_COLLABORATION_SETTINGS.assignment.routing,
          automaticPolicy: "quality",
        },
      },
    }))).toContain("routing_runtime_unavailable");
  });
});
