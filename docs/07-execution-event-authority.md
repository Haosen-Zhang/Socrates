# Phase 1A–2：执行事件权威、持久重放与 Provider 重试

## 目标

Phase 1A 为单 Agent 执行建立一个可重建、可审计的事实源；Phase 1B 将
Run 生命周期移交给 sidecar 内的 `RunSupervisor`；Phase 1C 让观察者从持久
序号恢复并无缝进入实时流。这些阶段都不改变公开对话历史的权威，也不提前实现
Tool 重试。Phase 2 在不提前创建 Step 身份的前提下，为单 Agent Provider 调用
增加显式、有限且可审计的重试。

## 权威边界

| 事实 | 唯一权威 | 可重建投影 |
| --- | --- | --- |
| 用户与 Assistant 可见消息、ToolCall/ToolResult 内容 | HistoryStore `room.jsonl` | SQLite 消息、UI、模型上下文 |
| 单 Agent Run 生命周期和规范化 Runtime 事件 | SQLite `runtime_events` | `agent_runs.event_seq`、未来 UI/审计视图 |
| 现有 Session 与 Multi-Agent 领域事件 | SQLite `task_events` | 现有协调器/UI 视图 |

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

## Phase 1A 已发出的事件

- Run：created、started、cancel_requested、completed、failed、cancelled、
  interrupted；
- 审批：requested、decided；
- 上下文：context.truncated；
- Runtime：规范化 `runtime.event`。

Turn、Step、Provider Attempt、Tool Operation/Attempt 和
`tool.outcome_unknown` 已有类型与身份契约，但只有在相应执行层迁移到显式状态机
后才允许发出。特别是非幂等 Tool 的未知结果不得自动重试。

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
- Phase 2 生命周期通过持久 `runtime.event` extension 记录
  `provider_attempt_started`、`provider_attempt_failed` 和
  `provider_retry_scheduled`。Phase 3 建立 Step/ProviderAttempt 身份后再发出规范
  `provider.*` 执行事件；Phase 2 不虚构坐标。
- Multi-Agent `ModelGateway` 同样禁用 SDK 内部重试，但本阶段的显式策略只接入单
  Agent 执行链路。
- HistoryStore 终态与执行日志属于不同事实域；Phase 1A 启动对账依据已提交的
  Run 终态和审批决定补齐缺失事件，Phase 1B 再由独立 supervisor 持续负责。
- Migration 017 预留版本化 projection checkpoint 表，目前不改变任何 UI
  读取路径。
