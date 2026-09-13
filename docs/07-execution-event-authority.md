# Phase 1A–3：执行事件权威、语义身份与持久检查点

## 目标

Phase 1A 为单 Agent 执行建立一个可重建、可审计的事实源；Phase 1B 将
Run 生命周期移交给 sidecar 内的 `RunSupervisor`；Phase 1C 让观察者从持久
序号恢复并无缝进入实时流。这些阶段都不改变公开对话历史的权威，也不提前实现
Tool 重试。Phase 2 在不提前创建 Step 身份的前提下，为单 Agent Provider 调用
增加显式、有限且可审计的重试。Phase 3 将 Turn、Step 和 ProviderAttempt
提升为规范执行身份，并让 Provider 调用服从持久化检查点。

## 权威边界

| 事实 | 唯一权威 | 可重建投影 |
| --- | --- | --- |
| 用户与 Assistant 可见消息、ToolCall/ToolResult 内容 | HistoryStore `room.jsonl` | SQLite 消息、UI、模型上下文 |
| 单 Agent Run 生命周期和规范化 Runtime 事件 | SQLite `runtime_events` | `agent_runs.event_seq`、未来 UI/审计视图 |
| Session 与 Multi-Agent 编排领域事件 | SQLite `task_events` | 现有协调器/UI 视图 |
| Multi-Agent 执行 Agent 的 Turn/Step/ProviderAttempt | SQLite `runtime_events` | 执行审计视图 |

执行日志不能进入模型上下文。模型只读取由 HistoryStore 派生的合法公开
消息；这避免 Runtime 状态、内部错误或未来 Tool 尝试记录污染下一轮采样。

## 事件信封

所有 v1 执行事件包含：

- `schemaVersion`、稳定 `eventId`、每个 Run 单调递增的 `seq`；
- `sessionId`、`runId`、`agentId`；
- 可选 `turnId`、`stepId`、`providerAttemptId`、`toolOperationId`、
  `toolAttemptId`；
- 类型化 `payload` 和 `occurredAt`。

身份必须形成合法层级：Step 属于 Turn，Provider Attempt 属于 Step，Tool
Operation 属于 Step，Tool Attempt 属于 Tool Operation。缺失父身份的事件会在
写入前失败关闭。

## 写入与重放规则

`ExecutionEventStore.append` 在 `BEGIN IMMEDIATE` 事务中分配序号、写入事件，
更新 `agent_runs.event_seq`，并执行调用方提供的同事务投影。相同稳定 ID 和
相同内容是幂等重放；相同 ID 与不同内容是协议冲突。
`listAfter(runId, cursor)` 只按序返回已提交的 v1 事件。

纯 Core reducer 只接受下一序号，忽略重复事件，并在缺号时返回 gap，而不猜测
状态。Migration 017 为旧 `runtime_events` 增加 Session、schema 和 Attempt 身份，
将所有迁移前记录标记为 legacy schema v0，保留并在可判定时回填 Session；旧
记录不会被误读成 v1，无法关联 Run 的旧孤儿记录也不伪造归属。
含 legacy 前缀的旧 Run 不再追加 v1 事件，避免产生错误序号基线或混合 schema
回放；新 Run 从 v1 序号 1 开始。

## 已发出的规范事件

- Run：created、started、cancel_requested、completed、failed、cancelled、
  interrupted；
- 审批：requested、decided；
- 上下文：context.truncated；
- Runtime：规范化 `runtime.event`。
- Turn：started、completed、failed、cancelled；
- Step：started、completed、failed；
- Provider Attempt：started、failed、retry_scheduled、completed。

Tool Operation/Attempt 和 `tool.outcome_unknown` 仍只有类型与身份契约，Phase 4
迁移到显式工具状态机后才允许发出。特别是非幂等 Tool 的未知结果不得自动重试。

## Phase 3：Turn、Step 与 ProviderAttempt

一个 Turn 是一次用户级 Agent 响应周期；一个 Step 是一次模型请求，以及促成下一次
模型请求的 ToolCall、审批和 ToolResult；一个 ProviderAttempt 恰好对应一次外部
Provider 调用。重试产生新的 ProviderAttempt，但仍属于同一 Step。身份由 Run 内稳定
序号派生，并满足 `Turn > Step > ProviderAttempt` 层级。

`provider_attempt_started` 是 Provider 前检查点信号。`RuntimeManager` 必须先提交
`step.started` 和 `provider.attempt.started`，生成器才会继续进入真实 Provider 调用；
任一写入失败都会关闭生成器并阻止请求发出。Provider 流结束只完成 Attempt，不提前
完成 Step。Runtime 完成响应消息、审批和 ToolResult 处理后发出内部 Step 边界，
`RuntimeManager` 提交 `step.completed` 后才允许下一次模型请求。

模型/UI Runtime 事件在活跃 Step 中携带 `stepId` 和 `providerAttemptId`。规范
`provider.*` 事件可重新投影为与实时流相同的扩展事件；它们依旧不会进入模型历史。
启动对账会从持久 Turn/Run 关系补齐缺失的 Turn started/terminal 事件。
Multi-Agent 计划执行使用持久 `multi_task_attempts.id` 作为 Turn 身份；暂停后恢复会
创建新的 Turn，因而新的 Step/ProviderAttempt 身份不会与上一执行尝试冲突。启动
对账会从已完成、失败、取消或暂停的持久 attempt 补齐缺失的 Turn 终态；重启或人工
暂停留下的已启动 Turn 均以失败关闭，等待显式恢复创建新 Turn。

## Phase 1B–1C：独立 Run 所有权与持久观察

单 Agent HTTP 入口现在分为三个动作：

- `POST /agent/sessions/:sessionId/runs` 创建并启动持久 Run，返回 `202` 和
  `runId` / `turnId` / `threadId`；
- `GET /agent/runs/:runId/events?afterSeq=N` 从持久序号之后开始观察；
- `POST /agent/runs/:runId/cancel` 才会触发 Run 自有的 `AbortController` 和
  Runtime 中断。

`RunSupervisor` 只持有执行 Promise 和取消控制器。观察者写入失败、WebView 刷新或
SSE 断开不会把请求 signal 传入 Runtime，也不会改变 Run 终态。sidecar 受控关闭会
中止仍在执行的 Run；非受控重启继续由启动恢复把孤儿 Run 标记为 `interrupted` 并
补齐权威事件。

事件端点先用 `listAfter` 按 `seq` 读取已提交批次，再等待下一次提交；等待注册后会
重查尾序号，关闭“读完到开始等待”之间的丢唤醒窗口。每个 SSE `id` 等于事件的持久
`seq`，响应携带完整 `ExecutionEvent` 信封。慢客户端只影响自己的 SQLite 读取和
响应写入，不会反压执行或事件提交。

Desktop 校验 schema、Run 身份、连续序号以及 SSE `id`。重复事件被忽略，缺号会从
最后确认的序号重新请求；传输断开也从该游标重连。当前 Run 身份和已确认序号保存在
本地恢复句柄中；WebView 重建时从序号 0 重放 UI 投影，终态或显式取消后才清除句柄。
`GET /agent/runs/:runId` 可从 SQLite 读取当前或终态投影。

## 当前限制与后续阶段

- 单 Agent `native_ai_sdk` 禁用 AI SDK 内部重试；一次 `streamText` 调用就是一次
  Provider attempt。Socrates 最多执行 5 次有限尝试，只重试网络、超时、408、429、
  5xx 和安全的空响应，并遵守有上限的 `Retry-After`。
- 鉴权、授权、无效请求、永久额度、取消和未知错误失败关闭。文本、ToolCall、审批请求
  或 ToolResult 等权威输出一旦开始，后续失败不会盲目重放整个采样。
- Provider 生命周期现在写为规范 `provider.*` 事件，并由 Step/ProviderAttempt 身份
  定位；Phase 2 的扩展信号只保留为 Runtime 与执行管理器之间的内部协议。
- Multi-Agent 讨论用 `ModelGateway` 同样禁用 SDK 内部重试；获批计划的执行 Agent
  通过 Native Runtime 接入本阶段的显式 ProviderAttempt 与 Step 检查点。
- HistoryStore 终态与执行日志属于不同事实域；Phase 1A 启动对账依据已提交的
  Run 终态和审批决定补齐缺失事件，Phase 1B 再由独立 supervisor 持续负责。
- Migration 017 预留版本化 projection checkpoint 表，目前不改变任何 UI
  读取路径。
- Side-effecting Tool 的执行前检查点、ToolOperation/ToolAttempt 以及未知结果恢复属于
  Phase 4，本阶段不把 Provider 检查点误称为 Tool 副作用保障。
