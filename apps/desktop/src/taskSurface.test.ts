import { describe, expect, it } from "bun:test";
import { DEFAULT_COLLABORATION_SETTINGS } from "@socrates/core";
import {
  deriveRoomTaskConfig,
  taskStatusKey,
  type TaskSurfaceSession,
} from "./taskSurface";

const session = (overrides: Partial<TaskSurfaceSession> = {}): TaskSurfaceSession => ({
  primaryAgentId: "executor",
  agents: [
    { agentId: "critic" },
    { agentId: "executor" },
  ],
  collaboration: {
    ...DEFAULT_COLLABORATION_SETTINGS,
    strategy: "team",
    assignment: {
      ...DEFAULT_COLLABORATION_SETTINGS.assignment,
      coordinatorAgentId: "critic",
    },
    discussion: {
      ...DEFAULT_COLLABORATION_SETTINGS.discussion,
      enabled: true,
      maxRounds: 3,
      speakerOrder: ["executor", "critic"],
      summaryAgentId: "critic",
    },
  },
  ...overrides,
});

describe("room-derived task surface", () => {
  it("starts from persisted room collaboration instead of per-task controls", () => {
    expect(deriveRoomTaskConfig(session())).toEqual({
      speakingOrder: ["executor", "critic"],
      maxRounds: 3,
      synthesizerId: "critic",
      executionAgentId: "executor",
    });
  });

  it("keeps the existing task DTO valid when discussion is disabled", () => {
    const base = session();
    const current = session({
      collaboration: {
        ...base.collaboration,
        discussion: {
          ...base.collaboration.discussion,
          enabled: false,
          speakerOrder: [],
          summaryAgentId: null,
        },
      },
    });
    expect(deriveRoomTaskConfig(current)).toEqual({
      speakingOrder: ["critic", "executor"],
      maxRounds: 1,
      synthesizerId: "critic",
      executionAgentId: "executor",
    });
  });

  it("projects real task state without a fixed multi-agent label", () => {
    expect(taskStatusKey(null)).toBe("task_status_idle");
    expect(taskStatusKey("discussing")).toBe("task_status_running");
    expect(taskStatusKey("awaiting_plan_approval")).toBe("task_status_awaiting_confirmation");
    expect(taskStatusKey("paused")).toBe("task_status_paused");
    expect(taskStatusKey("failed")).toBe("task_status_failed");
    expect(taskStatusKey("completed")).toBe("task_status_completed");
  });
});
