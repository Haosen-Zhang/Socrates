import type { Migration } from "../migrations";
import { ensureColumns, migrationChecksum } from "../migrations";

/**
 * C1：把 `chat | single_agent | multi_agent` 收敛为 `RoomKind = chat | cowork`，
 * 并把协作治理（讨论/协作/Boss/审批/监督）落到独立的 collaboration 列。
 *
 * 迁移规则（幂等；保留 ID、消息、成员、已有 workspace）：
 *   legacy chat         → kind=chat  ，workspace 强制置空（Chat 永不绑定工作区）
 *   legacy single_agent → kind=cowork，保留原 workspace_id
 *   legacy multi_agent  → kind=cowork，保留原 workspace_id，collaboration 记为多 Agent
 *
 * 缺 workspace 的 legacy agent 会话标记 recovery='workspace_required'：
 * 打开时只允许查看历史，必须由用户显式选择工作区后才能执行——**绝不自动绑定**
 * 最近使用或全局 active workspace。
 */
export const roomKindMigration: Migration = {
  version: 9,
  name: "room_kind",
  checksum: migrationChecksum("009:room-kind:v1:chat-cowork-collaboration-settings-recovery"),
  up(db) {
    ensureColumns(db, "sessions", [
      "kind TEXT",
      "collaboration_json TEXT",
      "recovery TEXT",
    ]);
    ensureColumns(db, "rooms", ["kind TEXT", "collaboration_json TEXT"]);

    // sessions：按 legacy mode 推导 kind（幂等——只填未设置过的行）
    db.exec(`
      UPDATE sessions SET kind = CASE
        WHEN mode = 'chat' THEN 'chat'
        ELSE 'cowork'
      END WHERE kind IS NULL;
    `);
    // Chat 不得继承任何 workspace
    db.exec(`UPDATE sessions SET workspace_id = NULL WHERE kind = 'chat' AND workspace_id IS NOT NULL;`);
    // cowork 缺 workspace → 需要用户补选，不自动绑定
    db.exec(`
      UPDATE sessions SET recovery = 'workspace_required'
      WHERE kind = 'cowork' AND (workspace_id IS NULL OR workspace_id = '') AND recovery IS NULL;
    `);
    // 多 Agent 历史会话保留其多 Agent 协作语义（默认单 Executor，用户可再调）
    db.exec(`
      UPDATE sessions SET collaboration_json = json_object(
        'discussionMode', 'round_robin',
        'collaborationMode', 'single_executor'
      ) WHERE mode = 'multi_agent' AND collaboration_json IS NULL;
    `);

    // legacy rooms（群聊）一律视为 chat：它们从未拥有本地执行能力
    db.exec(`UPDATE rooms SET kind = 'chat' WHERE kind IS NULL;`);
    db.exec(`UPDATE rooms SET workspace_id = NULL WHERE kind = 'chat' AND workspace_id IS NOT NULL;`);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sessions_kind_archived ON sessions (kind, archived, updated_at);
      CREATE INDEX IF NOT EXISTS idx_rooms_kind ON rooms (kind, updated_at);
    `);
  },
};
