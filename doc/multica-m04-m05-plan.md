# M04–M05 implementation plan

Baseline: origin/main with M02–M03 merged (PR #153). Scope: M04–M05 only.

## Global constraints

Preserve Chat/Work, Native Runtime, room/history data and user edits. Reuse Socrates services/UI and installed compatible dependencies; no Multica source/assets. Availability and workload are independent evidence-based projections. Stable structured IDs only, no prose-triggered scheduling. Notes create no model call; dispatch is persistent and idempotent. Leader evaluation is bounded and uses existing TeamRunner, permissions, budgets and workspace leases. Unknown side effects block automatic repeat execution. Use temporary databases/workspaces and controlled models. No paid API, private upload, merge or release. Complete tests, typecheck, desktop build, browser verification, progress evidence and feature PR.

## Task 1: M04 Agent lifecycle and timeline

## M04：Agent 生命周期、Presence、Run Timeline

**目标：**可视化真实的成员工作状态，让用户知道哪个 Agent 在做什么、排队在哪里、什么时候需要介入，而不是仅显示多个头像。

### 工作项

1. 新增 `AgentAvailabilityProjection`：Provider/模型配置检查 + Sidecar/运行时健康 + 最近连接证据 + 工具能力；基于服务端事实产生 ready/degraded/unavailable/unknown。不要因为有 API Key 就显示 online。
2. 新增独立 `AgentWorkloadProjection`：来自真实 active/queued/paused/awaiting_approval 的 runs；不要让最后失败的 Run 永远改变可用性指示。
3. 统一时间线：按 Run/Attempt/WorkPackage 显示 trigger→queued→workspace waiting→running→tool/approval→completion/failure，含父子关联、成员身份、错误和重试分支。
4. Agent 详情：配置/职责/所属 Squad、目前队列、Active Tasks、最近执行、模型/Provider、费用（若已有真实计价）、成功/失败次数；时间跨度和分母需要明确。
5. Squad roster 中每个成员显示双轴：`可用性` + `当前工作`；例如已配置但网络未知、当前排队、正在运行、等待人工审批。
6. 时间线支持查看工具参数的安全摘要、错误分类、产物 Diff 和当前测试证据；删除或回退后不产生幽灵记录。
7. Timeline 流式事件与断线后重放复用现有 EventStore；保留稳定 cursor、runId、attemptNo，避免重复事件和历史覆盖。
8. 面板缩小时保留关键状态摘要，打开全文再显示诊断细节；长记录虚拟化/分页。

### 验收

- Agent idle 但 Provider 不可用时，工作负载仍 idle、可用性 unavailable；两者不混淆。
- 队列中、正在执行、等待审批、已暂停和已结束有准确状态，点击能找到关联 Run。
- A 房间仍在执行时切到 B，A 的 Run 正常继续，B 不显示 A 的 token 或错误。
- 多次 attempt 保留，时间线按序不重叠，用户能查看失败原因为何重试。
- 关闭窗口/重开和 SSE 重连后，状态不回退到错误旧快照。

---

## Task 2: M05 Structured routing, bounded handoff and Inbox

## M05：消息路由、Leader 再唤醒、执行中干预与 Inbox

**目标：**把多 Agent 从“轮流说话”变成“需要时自然交接”，同时限制冗余唤醒和用户通知噪音。

### 工作项

1. 明确操作：`@agent`、`@squad`、`assign owner`、`note without trigger`、`request human review`、`delegate package`。使用稳定结构化 ID，不解析模型生成的纯文本作为自动执行命令。
2. Composer 下方增加可展开的 **Will trigger** 预览：哪些成员将产生 Run？由什么规则触发？会不会改变 Owner？是否已经在队列中？不可用或权限不够原因？
3. Leader 由事件触发一轮评价：新任务分配给 Squad、成员提交结果/报告 blocker、用户明确要求重新规划；原有 `TeamRunner` 负责实际执行。把“评估→计划/委派→记录原因→结束当前 Leader Run”设计成确定性状态流。
4. 重复消息、同一工作包重复报告、Leader 自己发的总结不能反复唤醒自己；同一 WorkItem 的 pending leader evaluation 去重；设置每任务最大委派轮次和预算，空转时停止并标记 `no_action`。
5. 负责人有在途 Run 时，用户发送指示选择：`排队到下一轮`、`停止并重新执行`，仅当已有 Native Runtime 真正支持稳定 in-run 指令交付并可回执时才显示 `当前运行插入`。不支持时禁用并解释。
6. 引入本机 Inbox：所有等待用户批准、验证、处理未知副作用、预算停机、成员遇阻的工作项聚合；只在从无到有/状态变化时通知，非关键的 token 级事件不推送。
7. Inbox 消息含 deep link，点击能定位到具体 WorkItem/Package/Run/Approval；状态处理后自动消除需要操作的通知，不把已解决事项重新生成。
8. 可选择引入快捷操作：Reviews、Ask teammate、Summarize work、Run tests；复用 RoomCommandService 与现有权限/预算准入。

### 验收

- `@A` 只唤醒 A，原 owner 不改变；`assign Squad` 变 owner 并只唤醒 Leader；纯文本 `@A`、引号中的 `@A` 和 Agent 的 Markdown 输出不会自己触发 Run。
- `note` 保存消息但没有模型调用；同一请求重放不会二次派发。
- 两位成员同时报告进展不会导致重复的 Leader evaluation；Leader 评价 `no_action` 不会无限循环。
- 暂停/审批等待期间关闭页面再回来，Inbox 和 Run Timeline 都指向相同的持久事实。
- “停止后重启”仅在停止确认和副作用结算后产生新 Run，且原始 Run 保留审计。

---
