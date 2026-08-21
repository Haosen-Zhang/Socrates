# Phase 1A–1B：执行事件权威与 Run 所有权

## 目标

Phase 1A 为单 Agent 执行建立一个可重建、可审计的事实源；Phase 1B 将
Run 生命周期移交给 sidecar 内的 `RunSupervisor`。两者都不改变公开对话历史
的权威，也不提前实现持久游标续传或 Tool 重试。

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

## Phase 1B：独立 Run 所有权

单 Agent HTTP 入口现在分为三个动作：

- `POST /agent/sessions/:sessionId/runs` 创建并启动持久 Run，返回 `202` 和
  `runId` / `turnId` / `threadId`；
- `GET /agent/runs/:runId/events` 仅作为观察者连接当前 sidecar 的实时流；
- `POST /agent/runs/:runId/cancel` 才会触发 Run 自有的 `AbortController` 和
  Runtime 中断。

`RunSupervisor` 持有执行 Promise、取消控制器和观察者集合。观察者写入失败、
WebView 刷新或 SSE 断开只会移除观察者，不会把请求 signal 传入 Runtime，也不会
改变 Run 终态。sidecar 受控关闭会中止仍在执行的 Run；非受控重启继续由启动恢复
把孤儿 Run 标记为 `interrupted` 并补齐权威事件。

POST 到首次 GET 之间只使用有事件数和字节上限的进程内短暂缓冲来避免握手丢事件；
超限会投影 `observer_gap`，慢观察者的队列同样有固定上限并会被断开。它们都不是
持久重放机制。
`GET /agent/runs/:runId` 可从 SQLite 读取当前或终态投影。

## 当前限制与后续阶段

- SSE 仍是执行过程的实时投影；Phase 1C 才按持久 `seq` 完成 replay → live
  无缝切换和跨 sidecar 重连。
- Provider SDK 内部 retry 仍不透明，不被虚构为 Provider Attempt。
- HistoryStore 终态与执行日志属于不同事实域；Phase 1A 启动对账依据已提交的
  Run 终态和审批决定补齐缺失事件，Phase 1B 再由独立 supervisor 持续负责。
- Migration 017 预留版本化 projection checkpoint 表，目前不改变任何 UI
  读取路径。
