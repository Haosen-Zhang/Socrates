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
export type CollaborationMode = "single_executor" | "human_directed_multi_agent" | "agent_directed_multi_agent";
export type ApprovalMode = "human" | "executor_self_check" | "designated_reviewer";
export type SupervisionMode = "off" | "final_only" | "key_stages" | "every_work_package";

export type BossConfig = {
  enabled: boolean;
  bossAgentId: string | null;
  /** 默认 false：Boss 只做拆解/分配/监控/整合，不直接执行 */
  allowBossExecution: boolean;
};

export type RoomCollaborationSettings = {
  discussionMode: DiscussionMode;
  collaborationMode: CollaborationMode;
  boss: BossConfig;
  approvalMode: ApprovalMode;
  designatedReviewerId: string | null;
  supervisionMode: SupervisionMode;
  supervisorAgentId: string | null;
};

export const DEFAULT_COLLABORATION_SETTINGS: RoomCollaborationSettings = {
  discussionMode: "off",
  collaborationMode: "single_executor",
  boss: { enabled: false, bossAgentId: null, allowBossExecution: false },
  approvalMode: "human",
  designatedReviewerId: null,
  supervisionMode: "off",
  supervisorAgentId: null,
};

const ROOM_KINDS = ["chat", "cowork"] as const;
const DISCUSSION_MODES = ["off", "round_robin", "debate"] as const;
const COLLABORATION_MODES = ["single_executor", "human_directed_multi_agent", "agent_directed_multi_agent"] as const;
const APPROVAL_MODES = ["human", "executor_self_check", "designated_reviewer"] as const;
const SUPERVISION_MODES = ["off", "final_only", "key_stages", "every_work_package"] as const;

export function isRoomKind(value: unknown): value is RoomKind {
  return typeof value === "string" && (ROOM_KINDS as readonly string[]).includes(value);
}

function pickEnum<T extends readonly string[]>(values: T, raw: unknown, fallback: T[number]): T[number] {
  return typeof raw === "string" && (values as readonly string[]).includes(raw) ? (raw as T[number]) : fallback;
}

/** 把（可能来自旧数据或手工编辑的）输入规整成合法设置；非法值回退默认。 */
export function normalizeCollaborationSettings(raw: unknown): RoomCollaborationSettings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const boss = (r.boss ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  return {
    discussionMode: pickEnum(DISCUSSION_MODES, r.discussionMode, DEFAULT_COLLABORATION_SETTINGS.discussionMode),
    collaborationMode: pickEnum(COLLABORATION_MODES, r.collaborationMode, DEFAULT_COLLABORATION_SETTINGS.collaborationMode),
    boss: {
      enabled: boss.enabled === true,
      bossAgentId: str(boss.bossAgentId),
      allowBossExecution: boss.allowBossExecution === true,
    },
    approvalMode: pickEnum(APPROVAL_MODES, r.approvalMode, DEFAULT_COLLABORATION_SETTINGS.approvalMode),
    designatedReviewerId: str(r.designatedReviewerId),
    supervisionMode: pickEnum(SUPERVISION_MODES, r.supervisionMode, DEFAULT_COLLABORATION_SETTINGS.supervisionMode),
    supervisorAgentId: str(r.supervisorAgentId),
  };
}

export type RoomShape = {
  kind: RoomKind;
  workspaceId: string | null;
  agentIds: string[];
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
    // Chat 不参与协作治理：只允许保持默认（讨论仍可用，但不得配置执行相关字段）
    if (settings.collaborationMode !== "single_executor") errors.push("chat_room_has_no_collaboration_mode");
    if (settings.boss.enabled) errors.push("chat_room_has_no_boss");
    if (settings.approvalMode !== "human") errors.push("chat_room_has_no_approval_delegation");
    if (settings.supervisionMode !== "off") errors.push("chat_room_has_no_supervision");
  }

  if (settings.discussionMode !== "off" && !multiMember) errors.push("discussion_requires_multiple_members");
  if (settings.collaborationMode !== "single_executor" && !multiMember) {
    errors.push("multi_agent_collaboration_requires_multiple_members");
  }

  if (settings.collaborationMode === "agent_directed_multi_agent") {
    if (!settings.boss.enabled) errors.push("agent_directed_requires_boss");
    if (!settings.boss.bossAgentId) errors.push("boss_agent_required");
    else if (!members.has(settings.boss.bossAgentId)) errors.push("boss_must_be_room_member");
    if (!multiMember) errors.push("boss_requires_multiple_members");
  } else if (settings.boss.enabled) {
    errors.push("boss_requires_agent_directed_collaboration");
  }

  if (settings.approvalMode === "designated_reviewer") {
    if (!settings.designatedReviewerId) errors.push("reviewer_required");
    else if (!members.has(settings.designatedReviewerId)) errors.push("reviewer_must_be_room_member");
  }

  if (settings.supervisionMode !== "off") {
    if (!settings.supervisorAgentId) errors.push("supervisor_required");
    else if (!members.has(settings.supervisorAgentId)) errors.push("supervisor_must_be_room_member");
  }

  return errors;
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
  return settings.collaborationMode === "single_executor" ? "single_agent" : "multi_agent";
}
