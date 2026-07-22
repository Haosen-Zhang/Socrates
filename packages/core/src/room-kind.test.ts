import { describe, expect, it } from "bun:test";
import {
  DEFAULT_COLLABORATION_SETTINGS,
  isRoomKind,
  normalizeCollaborationSettings,
  resolveRoomRuntime,
  reviewerConflictsWithExecutor,
  validateCollaborationSettings,
  validateRoomShape,
  type RoomCollaborationSettings,
  type RoomShape,
} from "./room-kind";

const chat = (agentIds: string[] = ["a"]): RoomShape => ({ kind: "chat", workspaceId: null, agentIds });
const cowork = (agentIds: string[] = ["a"]): RoomShape => ({ kind: "cowork", workspaceId: "ws1", agentIds });
const settings = (over: Partial<RoomCollaborationSettings> = {}): RoomCollaborationSettings => ({
  ...DEFAULT_COLLABORATION_SETTINGS,
  ...over,
  boss: { ...DEFAULT_COLLABORATION_SETTINGS.boss, ...(over.boss ?? {}) },
});

describe("validateRoomShape", () => {
  it("chat must not bind a workspace; cowork must have one", () => {
    expect(validateRoomShape(chat())).toEqual([]);
    expect(validateRoomShape({ kind: "chat", workspaceId: "ws1", agentIds: ["a"] })).toContain(
      "chat_room_must_not_bind_workspace",
    );
    expect(validateRoomShape(cowork())).toEqual([]);
    expect(validateRoomShape({ kind: "cowork", workspaceId: null, agentIds: ["a"] })).toContain(
      "cowork_room_requires_workspace",
    );
  });

  it("both kinds accept 1..N unique members and reject empty or duplicated", () => {
    expect(validateRoomShape(chat(["a"]))).toEqual([]);
    expect(validateRoomShape(chat(["a", "b", "c"]))).toEqual([]);
    expect(validateRoomShape(cowork(["a", "b", "c"]))).toEqual([]);
    expect(validateRoomShape(chat([]))).toContain("room_requires_at_least_one_member");
    expect(validateRoomShape(chat(["a", "a"]))).toContain("room_members_must_be_unique");
  });
});

describe("validateCollaborationSettings — member-count gates", () => {
  it("discussion requires 2+ members", () => {
    expect(validateCollaborationSettings(cowork(["a"]), settings({ discussionMode: "debate" }))).toContain(
      "discussion_requires_multiple_members",
    );
    expect(validateCollaborationSettings(cowork(["a", "b"]), settings({ discussionMode: "debate" }))).toEqual([]);
  });

  it("multi-agent collaboration requires 2+ members", () => {
    expect(
      validateCollaborationSettings(cowork(["a"]), settings({ collaborationMode: "human_directed_multi_agent" })),
    ).toContain("multi_agent_collaboration_requires_multiple_members");
    expect(
      validateCollaborationSettings(cowork(["a", "b"]), settings({ collaborationMode: "human_directed_multi_agent" })),
    ).toEqual([]);
  });
});

describe("validateCollaborationSettings — Boss", () => {
  const bossOn = (bossAgentId: string | null) =>
    settings({
      collaborationMode: "agent_directed_multi_agent",
      boss: { enabled: true, bossAgentId, allowBossExecution: false },
    });

  it("boss must be a room member and needs agent-directed collaboration", () => {
    expect(validateCollaborationSettings(cowork(["a", "b"]), bossOn("a"))).toEqual([]);
    expect(validateCollaborationSettings(cowork(["a", "b"]), bossOn("zzz"))).toContain("boss_must_be_room_member");
    expect(validateCollaborationSettings(cowork(["a", "b"]), bossOn(null))).toContain("boss_agent_required");
  });

  it("boss cannot be enabled outside agent-directed collaboration", () => {
    const stray = settings({
      collaborationMode: "single_executor",
      boss: { enabled: true, bossAgentId: "a", allowBossExecution: false },
    });
    expect(validateCollaborationSettings(cowork(["a", "b"]), stray)).toContain(
      "boss_requires_agent_directed_collaboration",
    );
  });

  it("agent-directed without a boss is rejected (no empty governance)", () => {
    const noBoss = settings({ collaborationMode: "agent_directed_multi_agent" });
    expect(validateCollaborationSettings(cowork(["a", "b"]), noBoss)).toContain("agent_directed_requires_boss");
  });

  it("allowBossExecution defaults to false", () => {
    expect(DEFAULT_COLLABORATION_SETTINGS.boss.allowBossExecution).toBeFalse();
  });
});

describe("validateCollaborationSettings — approval & supervision", () => {
  it("designated reviewer must be a room member", () => {
    expect(
      validateCollaborationSettings(
        cowork(["a", "b"]),
        settings({ approvalMode: "designated_reviewer", designatedReviewerId: "b" }),
      ),
    ).toEqual([]);
    expect(
      validateCollaborationSettings(
        cowork(["a", "b"]),
        settings({ approvalMode: "designated_reviewer", designatedReviewerId: "zzz" }),
      ),
    ).toContain("reviewer_must_be_room_member");
    expect(
      validateCollaborationSettings(cowork(["a", "b"]), settings({ approvalMode: "designated_reviewer" })),
    ).toContain("reviewer_required");
  });

  it("supervisor must be a room member when supervision is on", () => {
    expect(
      validateCollaborationSettings(
        cowork(["a", "b"]),
        settings({ supervisionMode: "key_stages", supervisorAgentId: "b" }),
      ),
    ).toEqual([]);
    expect(validateCollaborationSettings(cowork(["a", "b"]), settings({ supervisionMode: "key_stages" }))).toContain(
      "supervisor_required",
    );
  });

  it("a reviewer may not review the work package it is executing", () => {
    expect(reviewerConflictsWithExecutor("a", "a")).toBeTrue();
    expect(reviewerConflictsWithExecutor("a", "b")).toBeFalse();
    expect(reviewerConflictsWithExecutor(null, "a")).toBeFalse();
  });
});

describe("validateCollaborationSettings — chat has no governance", () => {
  it("rejects boss / delegated approval / supervision in chat rooms", () => {
    const errs = validateCollaborationSettings(
      chat(["a", "b"]),
      settings({
        collaborationMode: "agent_directed_multi_agent",
        boss: { enabled: true, bossAgentId: "a", allowBossExecution: true },
        approvalMode: "designated_reviewer",
        designatedReviewerId: "b",
        supervisionMode: "final_only",
        supervisorAgentId: "b",
      }),
    );
    expect(errs).toContain("chat_room_has_no_collaboration_mode");
    expect(errs).toContain("chat_room_has_no_boss");
    expect(errs).toContain("chat_room_has_no_approval_delegation");
    expect(errs).toContain("chat_room_has_no_supervision");
  });

  it("allows plain multi-model discussion in chat", () => {
    expect(validateCollaborationSettings(chat(["a", "b"]), settings({ discussionMode: "round_robin" }))).toEqual([]);
  });
});

describe("normalizeCollaborationSettings", () => {
  it("falls back to defaults for missing or illegal values", () => {
    expect(normalizeCollaborationSettings(undefined)).toEqual(DEFAULT_COLLABORATION_SETTINGS);
    expect(normalizeCollaborationSettings({ discussionMode: "nope", approvalMode: 42 })).toEqual(
      DEFAULT_COLLABORATION_SETTINGS,
    );
  });

  it("keeps valid values and coerces boss flags to booleans", () => {
    const n = normalizeCollaborationSettings({
      discussionMode: "debate",
      collaborationMode: "agent_directed_multi_agent",
      boss: { enabled: 1, bossAgentId: "a", allowBossExecution: "yes" },
      approvalMode: "designated_reviewer",
      designatedReviewerId: "b",
    });
    expect(n.discussionMode).toBe("debate");
    expect(n.collaborationMode).toBe("agent_directed_multi_agent");
    expect(n.boss.enabled).toBeFalse(); // 只有真正的 true 才算开启
    expect(n.boss.allowBossExecution).toBeFalse();
    expect(n.boss.bossAgentId).toBe("a");
    expect(n.designatedReviewerId).toBe("b");
  });
});

describe("resolveRoomRuntime", () => {
  it("chat resolves by member count and never gains local capability", () => {
    expect(resolveRoomRuntime(chat(["a"]), DEFAULT_COLLABORATION_SETTINGS)).toBe("single_chat");
    expect(resolveRoomRuntime(chat(["a", "b"]), DEFAULT_COLLABORATION_SETTINGS)).toBe("multi_chat");
  });

  it("cowork resolves by collaboration mode, not by member count", () => {
    expect(resolveRoomRuntime(cowork(["a", "b"]), settings({ collaborationMode: "single_executor" }))).toBe(
      "single_agent",
    );
    expect(resolveRoomRuntime(cowork(["a", "b"]), settings({ collaborationMode: "human_directed_multi_agent" }))).toBe(
      "multi_agent",
    );
    expect(
      resolveRoomRuntime(
        cowork(["a", "b"]),
        settings({
          collaborationMode: "agent_directed_multi_agent",
          boss: { enabled: true, bossAgentId: "a", allowBossExecution: false },
        }),
      ),
    ).toBe("multi_agent");
  });
});

describe("isRoomKind", () => {
  it("accepts only the two top-level kinds", () => {
    expect(isRoomKind("chat")).toBeTrue();
    expect(isRoomKind("cowork")).toBeTrue();
    expect(isRoomKind("single_agent")).toBeFalse();
    expect(isRoomKind("multi_agent")).toBeFalse();
  });
});
