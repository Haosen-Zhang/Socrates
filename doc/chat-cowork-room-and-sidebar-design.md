# Chat / Co-work 房间模型、侧栏与协作治理设计

本文档记录把顶层产品形态收敛为 **Chat** 与 **Co-work** 两种后的领域模型、导航、侧栏、
建房与协作治理的设计与**真实实现边界**（哪些接了运行时、哪些还没）。对应 PR #67–#71。

交接给其他 agent/模型时，先读这一份即可掌握房间体系的全貌与坑。

## 0. 一句话现状

- 顶层只有 `Chat` 和 `Co-work` 两种模式（`AppMode = "chat" | "cowork"`）。
- Chat = 纯对话，**永不**绑定工作区、不开放工具；Co-work = 在工作区里协作，可执行。
- 协作治理（讨论 / Boss / 审批）里，**已接运行时**的是：讨论开关、Boss 统筹、指定审核者/执行者自检。
- **未接运行时**的是：多执行者分派、监督（supervision）。UI 已如实标注，不做假开关。

## 1. 领域模型（core，零 IO）

`packages/core/src/room-kind.ts`

| 类型 | 取值 | 说明 |
| --- | --- | --- |
| `RoomKind` | `chat` \| `cowork` | 房间归属，决定导航与是否绑工作区 |
| `DiscussionMode` | `off` \| `round_robin` \| `debate` | `off`/`round_robin` 已接；`debate` 无运行时 |
| `CollaborationMode` | `single_executor` \| `human_directed_multi_agent` \| `agent_directed_multi_agent` | `single_executor` / `agent_directed`(=Boss) 已接；`human_directed` 无运行时 |
| `ApprovalMode` | `human` \| `executor_self_check` \| `designated_reviewer` | 三者**全部**已接运行时 |
| `SupervisionMode` | `off` \| `final_only` \| `key_stages` \| `every_work_package` | **均未接**运行时 |

跨字段合法性集中在 `validateRoomShape` 与 `validateCollaborationSettings`，前端与 sidecar
**共用同一份**判断（避免 UI 自行推断出不同结论）。`DEFAULT_COLLABORATION_SETTINGS.discussionMode`
默认为 `off` —— 注意这个默认值**不能**被运行时当作「用户已关闭讨论」（见 §5 坑）。

## 2. 导航单一事实来源

`packages/core/src/navigation.ts`

旧模型有四个可独立变化的状态（`view` / `currentRoomId` / `currentSessionId` / 全局粘性
`activeWorkspace`），能组合出非法状态（最典型：Chat 房间打开着、同时全局 workspace 被高亮，
于是 Chat 看起来继承了工作区）。新模型：任意时刻只有一个 primary target，workspace **只能**
从 target 派生。`workspaceOfTarget` 对 chat **永远**返回 null —— 这是「Chat 不得隐式继承工作区」
在代码里的唯一执行点。Settings 不在导航联合类型内，是独立 overlay（关闭后回原 target）。

## 3. 建房（C4）

`apps/desktop/src/roomSelection.ts` + `NewRoomDialog`（ChatPage.tsx）

两张卡片 Chat / Co-work，两者都支持 1..N 成员。唯一结构差异是工作区：
- Chat 显式发 `workspaceId: null`（**不**从全局 `activeWorkspace` 继承）。
- Co-work 必须在对话框里明确选一个未归档的工作区；运行时 `mode` 由成员数派生。

三个旧入口（`createRoom` / `createAgentSession` / `createMultiAgentSession`）合并为
`createRoomFromDraft`，工作区只来自草稿。`SessionStore.create` 用 `validateRoomShape` 兜底，
且**拒绝绑定已归档工作区**（`workspace_archived`，PR #70）。新建 cowork 房间会落一份默认
协作设置（多成员 `round_robin`、单成员 `off`），保证 UI 显示与运行时一致。

## 4. 侧栏（C3）

`apps/desktop/src/sidebar/*` + ChatPage 侧栏区

顶部 Chat / Co-work 分段控件决定列表内容：Chat 是扁平房间列表，Co-work 是工作区树，
两者互不串场。搜索范围随模式收窄，且**不改动**任何持久化关系。折叠状态存进 `config.sidebar`。

已修的坑：
- 归档面板会显示归档的**工作区**（否则空工作区归档后只加计数点不开，PR #68）。
- `coworkGroups` 对「工作区已归档但仍挂着未归档房间」保留显示，避免房间彻底 orphan（PR #70）。
- mode 是真实状态：删除/归档清空选中时**不**弹回 chat（PR #71）。

## 5. 协作治理运行时（C5，真实语义）

`apps/sidecar/src/multi-agent/coordinator.ts`。协作设置持久化在 `sessions.collaboration_json`，
被协调器真实消费。**已接运行时**：

| 维度 | 真实行为 | 证据 |
| --- | --- | --- |
| 讨论开关 | `discussionMode="off"`（**显式**存的才算）跳过讨论轮，直接由综合者/Boss 从 prompt 生成计划 | `run()` discussionRounds |
| Boss 统筹 | 开启时由 Boss agent 整合出计划（替代 synthesizerId）；默认不执行，Boss 同为执行者→`boss_must_not_execute` | `effectiveSynthesizerId` / `assertBossExecutionAllowed` |
| 审批 | `executor_self_check`/`designated_reviewer` 真跑一次审核 Agent，产 approve/request_changes；后者自动重综合一版（只一轮防死循环）后停在人工审批 | `reviewPlan` / `effectiveReviewerId` |

审核 turn 复用讨论/综合那套幂等 turn 机制（`phase=reviewing`），resume 可回放。

**坑**：`discussionMode` 默认值是 `off`，但「未配置过的会话」必须保持历史行为（总是讨论）。
所以协调器判定是 `!!collaboration_json && discussionMode==="off"` 才跳过 —— 默认值不能当「已关闭」。

**未接运行时**（UI 标「尚未接入」，非假开关）：`supervisionMode`、`human_directed_multi_agent`、
`DiscussionMode.debate`。

## 6. 设置入口（C6）

Settings 是 overlay：左下角按钮、`⌘,`、macOS `Socrates > Settings…` 均打开同一单实例，
关闭后回到原房间。Co-work 协作设置从房间 ⋯ 菜单**和**多 Agent 会话头部「协作设置」按钮打开
（PR #69 补的入口——否则用户在建任务界面找不到）。

## 7. 待办（尚未实现）

| 项 | 为什么大 | 依赖 |
| --- | --- | --- |
| **多执行者分派** | `execution-runner` 现在硬假设单 `executionAgentId`，整份计划一个执行者串行跑；要让 Boss 计划的 work package 路由到不同 agent 分别执行并汇总 | 改执行阶段 |
| **监督（supervision）** | 要让监督 agent 在关键阶段/每个 work package 介入检查 | 依赖多执行者拆分 |
| **C7 能力边界接线** | `modeToolCeiling` 等能力边界与运行时的完整对接 | — |

## 8. 已知诊断项

多 Agent 计划批准后执行失败：执行是脱离 SSE 的后台任务，失败原因原来被吞。PR #70 已让
`terminalReason` 在多 Agent 会话里可见。**真机复现失败后需读取该原因**（很可能是
`codex_app_server` 执行运行时未配置）再定位。

## 9. 门禁基线（PR #71 后 = origin/main）

`bun test` **311 pass / 0 fail** · root & desktop `tsc` 0 · `biome lint` 干净 · `vite build` ✓
