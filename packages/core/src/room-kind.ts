/**
 * 房间模型（C1）：顶层只有两种房间。
 *
 * 旧模型把 `chat | single_agent | multi_agent` 混在一个 `mode` 字段里，
 * 既表示「是否允许本地能力」，又表示「几个 Agent」，还隐含协作方式。
 * 新模型把这些拆成正交维度：
 *
 *   RoomKind         —— 是否允许本地 Agent 能力（chat 永远不允许）
 *   成员数量          —— 决定哪些协作能力可选
 *   RoomCollaboration —— 讨论 / 协作 / Boss / 审批 / 监督（仅 cowork）
 *   ExecutionPolicySnapshot —— 某次执行真正生效的策略（执行开始时冻结）
 */
export type RoomKind = "chat" | "cowork";

export type DiscussionMode = "off" | "round_robin" | "debate";
export type ExecutionStrategy = "single" | "adaptive" | "team";
export type RoutingMode = "automatic" | "manual";
export type AutomaticRoutingPolicy = "cost" | "balanced" | "quality";
export type PlanConfirmationMode = "coordinator" | "user" | "reviewer";

export type CollaborationRuntimeCapabilities = {
  supportedStrategies: ExecutionStrategy[];
  discussion: boolean;
  routing: boolean;
  planConfirmation: PlanConfirmationMode[];
};

export const COLLABORATION_RUNTIME_CAPABILITIES: CollaborationRuntimeCapabilities = {
  supportedStrategies: ["single", "team"],
  discussion: true,
  routing: false,
  planConfirmation: ["user"],
};

export function validateCollaborationCapabilities(
  settings: RoomCollaborationSettings,
  capabilities: CollaborationRuntimeCapabilities =
    COLLABORATION_RUNTIME_CAPABILITIES,
): string[] {
  const errors: string[] = [];
  if (!capabilities.supportedStrategies.includes(settings.strategy)) {
    errors.push("collaboration_strategy_unavailable");
  }
  if (settings.discussion.enabled && !capabilities.discussion) {
    errors.push("discussion_runtime_unavailable");
  }
  const routingConfigured =
    settings.assignment.routing.mode !== "automatic"
    || settings.assignment.routing.automaticPolicy !== "balanced";
  if (routingConfigured && !capabilities.routing) {
    errors.push("routing_runtime_unavailable");
  }
  if (!capabilities.planConfirmation.includes(settings.planConfirmation.mode)) {
    errors.push("plan_confirmation_unavailable");
  }
  return errors;
}

export type RoomCollaborationSettings = {
  strategy: ExecutionStrategy;
  assignment: {
    coordinatorAgentId: string | null;
    callableAgentIds: string[];
    routing: {
      mode: RoutingMode;
      automaticPolicy: AutomaticRoutingPolicy;
      lightweightAgentId: string | null;
      complexAgentId: string | null;
      criticalAgentId: string | null;
    };
  };
  discussion: {
    enabled: boolean;
    mode: Exclude<DiscussionMode, "off">;
    maxRounds: number;
    speakerOrder: string[];
    summaryAgentId: string | null;
  };
  planConfirmation: {
    mode: PlanConfirmationMode;
    reviewerAgentId: string | null;
  };
};

export const DEFAULT_COLLABORATION_SETTINGS: RoomCollaborationSettings = {
  strategy: "single",
  assignment: {
    coordinatorAgentId: null,
    callableAgentIds: [],
    routing: {
      mode: "automatic",
      automaticPolicy: "balanced",
      lightweightAgentId: null,
      complexAgentId: null,
      criticalAgentId: null,
    },
  },
  discussion: {
    enabled: false,
    mode: "round_robin",
    maxRounds: 2,
    speakerOrder: [],
    summaryAgentId: null,
  },
  planConfirmation: { mode: "user", reviewerAgentId: null },
};

const ROOM_KINDS = ["chat", "cowork"] as const;
const DISCUSSION_MODES = ["round_robin", "debate"] as const;
const EXECUTION_STRATEGIES = ["single", "adaptive", "team"] as const;
const ROUTING_MODES = ["automatic", "manual"] as const;
const ROUTING_POLICIES = ["cost", "balanced", "quality"] as const;
const PLAN_CONFIRMATION_MODES = ["coordinator", "user", "reviewer"] as const;

export function isRoomKind(value: unknown): value is RoomKind {
  return typeof value === "string" && (ROOM_KINDS as readonly string[]).includes(value);
}

function pickEnum<T extends readonly string[]>(values: T, raw: unknown, fallback: T[number]): T[number] {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T[number]) : fallback;
}

/** 把（可能来自旧数据或手工编辑的）输入规整成合法设置；非法值回退默认。 */
export function normalizeCollaborationSettings(raw: unknown): RoomCollaborationSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const assignment = (r.assignment ?? {}) as Record<string, unknown>;
  const routing = (assignment.routing ?? {}) as Record<string, unknown>;
  const discussion = (r.discussion ?? {}) as Record<string, unknown>;
  const planConfirmation = (r.planConfirmation ?? {}) as Record<string, unknown>;
  const boss = (r.boss ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const strings = (v: unknown) =>
    Array.isArray(v) ? [...new Set(v.filter((item): item is string => typeof item === "string" && !!item))] : [];
  const legacyStrategy = r.collaborationMode === "agent_directed_multi_agent"
    || r.collaborationMode === "human_directed_multi_agent"
    ? "team"
    : "single";
  const legacyDiscussionEnabled = r.discussionMode === "round_robin" || r.discussionMode === "debate";
  const rounds = Number(discussion.maxRounds);
  return {
    strategy: pickEnum(EXECUTION_STRATEGIES, r.strategy, legacyStrategy),
    assignment: {
      coordinatorAgentId: str(assignment.coordinatorAgentId) ?? str(boss.bossAgentId),
      callableAgentIds: strings(assignment.callableAgentIds),
      routing: {
        mode: pickEnum(ROUTING_MODES, routing.mode, DEFAULT_COLLABORATION_SETTINGS.assignment.routing.mode),
        automaticPolicy: pickEnum(
          ROUTING_POLICIES,
          routing.automaticPolicy,
          DEFAULT_COLLABORATION_SETTINGS.assignment.routing.automaticPolicy,
        ),
        lightweightAgentId: str(routing.lightweightAgentId),
        complexAgentId: str(routing.complexAgentId),
        criticalAgentId: str(routing.criticalAgentId),
      },
    },
    discussion: {
      enabled: typeof discussion.enabled === "boolean"
        ? discussion.enabled
        : legacyDiscussionEnabled,
      mode: pickEnum(
        DISCUSSION_MODES,
        discussion.mode ?? r.discussionMode,
        DEFAULT_COLLABORATION_SETTINGS.discussion.mode,
      ),
      maxRounds: Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 20
        ? rounds
        : DEFAULT_COLLABORATION_SETTINGS.discussion.maxRounds,
      speakerOrder: strings(discussion.speakerOrder),
      summaryAgentId: str(discussion.summaryAgentId),
    },
    planConfirmation: {
      mode: pickEnum(
        PLAN_CONFIRMATION_MODES,
        planConfirmation.mode,
        r.approvalMode === "designated_reviewer"
          ? "reviewer"
          : r.approvalMode === "executor_self_check"
            ? "coordinator"
            : DEFAULT_COLLABORATION_SETTINGS.planConfirmation.mode,
      ),
      reviewerAgentId: str(planConfirmation.reviewerAgentId) ?? str(r.designatedReviewerId),
    },
  };
}

export type RoomShape = {
  kind: RoomKind;
  workspaceId: string | null;
  agentIds: string[];
  primaryAgentId?: string | null;
};

/** 房间本身的结构约束（与协作设置无关）。返回错误码数组，空数组表示合法。 */
export function validateRoomShape(room: RoomShape): string[] {
  const errors: string[] = [];
  if (room.agentIds.length < 1) errors.push("room_requires_at_least_one_member");
  if (new Set(room.agentIds).size !== room.agentIds.length) errors.push("room_members_must_be_unique");
  if (room.kind === "chat" && room.workspaceId !== null) errors.push("chat_room_must_not_bind_workspace");
  if (room.kind === "cowork" && !room.workspaceId) errors.push("cowork_room_requires_workspace");
  return errors;
}

/**
 * 协作设置相对于房间的合法性。所有跨字段规则集中在这里，
 * 前端与 sidecar 共用同一份判断，避免 UI 自行推断出不同结论。
 */
export function validateCollaborationSettings(room: RoomShape, settings: RoomCollaborationSettings): string[] {
  const errors: string[] = [];
  const members = new Set(room.agentIds);
  const multiMember = room.agentIds.length >= 2;

  if (room.kind === "chat") {
    if (settings.strategy !== "single") errors.push("chat_room_has_no_execution_strategy");
    if (settings.planConfirmation.mode !== "user") {
      errors.push("chat_room_has_no_plan_confirmation");
    }
  }

  if (settings.strategy === "adaptive" && !multiMember) errors.push("adaptive_requires_multiple_members");
  if (settings.strategy === "team" && !multiMember) errors.push("team_requires_multiple_members");
  if (settings.strategy !== "single") {
    if (!settings.assignment.coordinatorAgentId) errors.push("coordinator_required");
    else if (!members.has(settings.assignment.coordinatorAgentId)) errors.push("coordinator_must_be_room_member");
  }
  if (settings.assignment.callableAgentIds.some((id) => !members.has(id))) {
    errors.push("callable_agents_must_be_room_members");
  }
  if (settings.assignment.routing.mode === "manual" && settings.strategy === "team") {
    for (const [role, id] of [
      ["lightweight", settings.assignment.routing.lightweightAgentId],
      ["complex", settings.assignment.routing.complexAgentId],
      ["critical", settings.assignment.routing.criticalAgentId],
    ] as const) {
      if (id && !members.has(id)) errors.push(`${role}_agent_must_be_room_member`);
    }
  }
  if (settings.discussion.enabled) {
    if (!multiMember) errors.push("discussion_requires_multiple_members");
    if (settings.discussion.speakerOrder.length === 0) errors.push("discussion_speaker_order_required");
    if (settings.discussion.speakerOrder.some((id) => !members.has(id))) {
      errors.push("discussion_speakers_must_be_room_members");
    }
    if (!settings.discussion.summaryAgentId) errors.push("discussion_summary_agent_required");
    else if (!members.has(settings.discussion.summaryAgentId)) {
      errors.push("discussion_summary_agent_must_be_room_member");
    }
  }
  if (settings.planConfirmation.mode === "reviewer") {
    if (!settings.planConfirmation.reviewerAgentId) errors.push("reviewer_required");
    else if (!members.has(settings.planConfirmation.reviewerAgentId)) {
      errors.push("reviewer_must_be_room_member");
    }
  }

  return errors;
}

export function resolveCollaborationDefaults(
  defaults: RoomCollaborationSettings,
  room: RoomShape,
  primaryAgentId: string,
): RoomCollaborationSettings {
  const normalized = normalizeCollaborationSettings(defaults);
  const members = new Set(room.agentIds);
  const coordinator = normalized.assignment.coordinatorAgentId
    && members.has(normalized.assignment.coordinatorAgentId)
    ? normalized.assignment.coordinatorAgentId
    : primaryAgentId;
  const role = (id: string | null) => id && members.has(id) ? id : coordinator;
  const speakerOrder = normalized.discussion.speakerOrder.filter((id) => members.has(id));
  return {
    ...normalized,
    strategy: room.agentIds.length < 2 ? "single" : normalized.strategy,
    assignment: {
      ...normalized.assignment,
      coordinatorAgentId: coordinator,
      callableAgentIds: normalized.assignment.callableAgentIds.length
        ? normalized.assignment.callableAgentIds.filter((id) => members.has(id))
        : [...room.agentIds],
      routing: {
        ...normalized.assignment.routing,
        lightweightAgentId: role(normalized.assignment.routing.lightweightAgentId),
        complexAgentId: role(normalized.assignment.routing.complexAgentId),
        criticalAgentId: role(normalized.assignment.routing.criticalAgentId),
      },
    },
    discussion: {
      ...normalized.discussion,
      enabled: room.agentIds.length >= 2 && normalized.discussion.enabled,
      speakerOrder: speakerOrder.length ? speakerOrder : [...room.agentIds],
      summaryAgentId: role(normalized.discussion.summaryAgentId),
    },
    planConfirmation: {
      ...normalized.planConfirmation,
      reviewerAgentId: normalized.planConfirmation.reviewerAgentId
        && members.has(normalized.planConfirmation.reviewerAgentId)
        ? normalized.planConfirmation.reviewerAgentId
        : normalized.planConfirmation.mode === "reviewer"
          ? coordinator
          : null,
    },
  };
}

/**
 * Reviewer 不得审核自己正在执行的 Work Package——独立审核必须由第三方做出。
 * 命中时调用方应升级给用户，而不是让 Executor 自己批准自己。
 */
export function reviewerConflictsWithExecutor(reviewerId: string | null, executorId: string | null): boolean {
  return reviewerId !== null && executorId !== null && reviewerId === executorId;
}

export type RoomRuntimeKind = "single_chat" | "multi_chat" | "single_agent" | "multi_agent";

/** 统一的运行时解析：UI 与 sidecar 必须都用它，不得各自推断。 */
export function resolveRoomRuntime(
  room: RoomShape,
  settings: RoomCollaborationSettings,
): RoomRuntimeKind {
  if (room.kind === "chat") return room.agentIds.length === 1 ? "single_chat" : "multi_chat";
  return settings.strategy === "single" ? "single_agent" : "multi_agent";
}
