# M02–M03 implementation plan

Baseline: origin/main 26a4352 (P08 merged). Scope: M02–M03 only.

## Global constraints

Preserve Chat/Work, Native Runtime, room/history data and user edits. Reuse Socrates services/UI and compatible dependencies; no Multica source/assets. Assign-only creates no command/run/model call. Explicit start is idempotent; Squad starts only its Leader through existing Coordinator. Runtime outcomes remain separate from human task review. Use temporary databases/workspaces and controlled models. No paid API, private upload, merge or release. Complete tests, typecheck, desktop build, browser verification, progress evidence and feature PR.

## Task 1: M02 Squad management

## M02：Squad 数据/列表/详情/成员/模板复用

**目标：**将可复用团队配置独立于 Work Room，提供从创建到任务使用的完整闭环。

### 工作项

1. `SquadTemplate`：项目作用域或显式可跨项目复用的作用域，存名称/头像/LeaderAgentId/说明/Instructions/成员/成员职责/更新版本/归档状态；逐步迁移，使用 SQLite `UNIQUE` 和外键约束防重复，现有房间不因未绑定 Squad 失效。
2. 建立 REST/service 和前端缓存：列出、创建、查看、编辑、增加/移除成员、调整 Leader、归档、查看正在使用的 Work Rooms/WorkItems；操作有稳定 ID 与并发版本。
3. Creator：先选 Leader（自动加入成员）；可从 Agent 库选择不同 Provider 模型角色，可在流程中创建新角色并返回选中；设置角色描述与 Squad 指令，不增加每个新建房间的必填字段。
4. Squad 列表展示 Member preview、Leader 和真实 Active WorkItem 数；筛选和搜索保持在本地 UI 状态，刷新后必要选择可恢复。
5. 详情页展示 roster、职能说明、可用性/工作负载（分开）、Active Tasks、Recent Runs、指令、设置。当前 Leader 不能直接被移除；换 Leader 时显式进行合法性和能力校验。
6. 更新 Squad 模板不改变正在执行中的运行成员快照；任务可以显式选择应用新的 Squad 配置。归档时先计算引用并提示迁移选择，保持历史。
7. UI 中提供“从 Squad 新建 Work Room/分配任务”入口；Squad 与房间的成员和默认响应者必须有明确版本关系，避免两个地方改了同一个设置但没同步。

### 验收

- 创建一个含 Claude/GPT/DeepSeek 不同 Provider 的 Squad，关闭应用重开，成员与职责和 Leader 均保留。
- 在房间 A、B 使用同一 Squad，变更模板后运行中的 A 不改变；可显式应用更新到 B。
- 不能删除现任 Leader；可先换 Leader 再删除旧 Leader。
- 成员不可用或 Provider 失效时，列表显示原因，仍可看历史，不把所有任务删除。
- 归档有受影响任务说明；已完成记录不会消失，不产生失效引用。

---

## Task 2: M03 Work task assignment

## M03：Work Task Center、明确分配与启动预览

**目标：**引入 Multica 值得借鉴的“任务/一次运行分开”和“分配 ≠ 自动执行”，但不迁移到 Multica 的 Issue 后端。

### 工作项

1. 根据 M00 确定的 `WorkItemProjection` 或最小 `work_items` 持久实体实现 Task Center；用户可以从 Work Room 消息或 Project 创建任务，保留来源链接。
2. 任务列表先实现：标题、workflow 状态、owner (user/agent/squad)、优先级、房间归属、当前 Run、最近更新时间、等待原因。可选 Board 且列顺序可调整；初版至少有 Backlog/To Do/In Progress/In Review/Done 语义（可映射旧状态，不额外复制实际 runtime 状态）。
3. 新建/分配对话框区分“选择 Owner”与“开始执行”。选择 Agent / Squad / 本机用户后展示 Owner 能力、预估执行目标、Workspace、工具许可、审批、费用预算/未知费用。
4. **显式双动作**：`分配并开始`、`只分配`。Backlog 创建和 assign-only 不能生成任何付费模型请求。点击确定后显示准确的状态与任务卡，失败时不得呈现已分配。
5. 分配 Squad 时只触发 Leader（一次、去重），并关联 parent WorkItem；Leader 调度现有 WorkPackage，使用现有 TeamRunner/Coordinator 接口而不是新建第二套执行循环。
6. 任务负责人变更时，明确运行中 Run 的后果：保留当前执行或停止再移交；状态与运行记录分别存储，不能因 Owner 更新自动取消没有选中的 Run。
7. 任务详情展示目标、对话消息、工作包、分配情况、验收标准、审核信息、产物、Run 列表；旧 Work 房间可用，不要求全部用户重建 Project。
8. 提供快捷操作（可在 M05 引入）：如“请 Reviewer 审查”“生成测试”，只在用户确认后触发对应 run，不偷偷改变 Owner。

### 验收

- assign-only 无 Agent 调用、无 Run；立即启动创建一次 Run（网络重试和双击仍一次）。
- assign-to-squad 只生成 Leader run，没有 N 个成员 run；对应 workpackage 执行根据 Coordinator 结果产生各成员 run。
- 换 Owner 后旧 Run 有完整身份和历史；页面显示当前真实 owner，不把旧执行结果伪装成新负责人产生。
- UI Task done 不因 child Run completed 而自动成立，等待用户审核时明显进入 In Review。
- List 与 Board、Room 和 TaskDetail 三处显示的状态与数量一致，切窗口/重连一致。

---
