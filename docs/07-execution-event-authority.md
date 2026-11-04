# Phase 1A–4：执行事件权威、持久检查点与工具恢复

## 目标

Phase 1A 为单 Agent 执行建立一个可重建、可审计的事实源；Phase 1B 将
Run 生命周期移交给 sidecar 内的 `RunSupervisor`；Phase 1C 让观察者从持久
序号恢复并无缝进入实时流。这些阶段都不改变公开对话历史的权威，也不提前实现
Tool 重试。Phase 2 在不提前创建 Step 身份的前提下，为单 Agent Provider 调用
增加显式、有限且可审计的重试。Phase 3 将 Turn、Step 和 ProviderAttempt
提升为规范执行身份，并让 Provider 调用服从持久化检查点。
Phase 4 为工具建立独立的逻辑操作与尝试记录，并在结果丢失后明确保留不确定性。

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
- Tool Operation：requested；Tool Attempt：checkpointed、started、result；
- Tool 恢复：`tool.outcome_unknown`。

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

## Phase 4：工具尝试与未知结果恢复

`tool_calls` 继续表示逻辑 ToolOperation；Migration 018 增加 `tool_attempts`，每次尝试
有独立 ID 和序号。Native Runtime 从 RuntimeManager 接收真实 Run/Turn 身份，并在
当前 Step 下执行工具。工具实现收到稳定的 `idempotencyKey`（逻辑 operation ID）
以及独立 `toolAttemptId`。旧适配器没有 Step 时仅更新原有 SQLite 记录，不伪造 v1 层级。

工具入口先提交 operation intent，再提交 attempt checkpoint 和 started，才允许进入
工具主体；任一检查点失败均不执行副作用。结果事件、输出和终态在同一个 SQLite 事务
中提交。结果序列化或落盘失败会中止 Native 采样，保留 started 状态，不能伪装成工具
执行失败。相同稳定 key 的并发调用复用同一个操作；跨输入、定义或执行 scope 的复用
失败关闭。

自动重试只适用于 read/idempotent 工具的已分类瞬时网络、限流或可重试超时错误，最多
3 次，采用短暂有界退避。文件不存在、参数/权限错误和未知错误不重试；非幂等工具
不自动重试。重试共用逻辑操作和幂等 key，各自留下 attempt 记录。

启动恢复，以及同进程内已停止 Run 的下一次对话，遵守以下规则：

| 持久证据 | 恢复结果 | 后续动作 |
| --- | --- | --- |
| 已提交输出 | 保留已知结果 | 不重复工具主体 |
| 尚未开始 | `TOOL_NOT_STARTED` | 旧审批过期，可重新请求 |
| 已开始、结果缺失，read/idempotent | `TOOL_OUTCOME_UNKNOWN` / `safe_to_retry` | 模型可明确重新请求 |
| 已开始、结果缺失，工作区修改 | `TOOL_OUTCOME_UNKNOWN` / `verify_then_continue` | 先检查文件状态；再次修改需新审批 |
| 已开始、结果缺失，其他非幂等工具 | `TOOL_OUTCOME_UNKNOWN` / `requires_user_confirmation` | 重新人工确认 |

恢复本身不执行工具。下一轮采样前，通过 HistoryStore-backed writer 补齐公开
ToolCall/ToolResult；等待审批、尚未进入 executor 的调用补为 `TOOL_NOT_STARTED`。
模型只看到可见工具结果及恢复提示，不接收执行日志。未知非幂等操作会使相同工作区、
同名工具重新要求人工审批，即使 Room policy 为 allow。当前采用保守保护，未实现
“已核验并清除未知状态”的 UI；每次新的操作均需自己的精确审批。

恢复区分和模型提示改编自 DeepSeek Harness 的
[`session/repair.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/8bd073392eef6f54e921a093b95076248eb08cbb/packages/core/session/src/repair.ts)，
固定版本 `8bd0733`，MIT 许可保留于 `third-party/DeepSeek-Harness-LICENSE`。
直接复用其恢复语义和提示，适配已有 SQLite/HistoryStore，未引入新的运行时框架。

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
- 工具检查点不能把外部副作用和 SQLite 提交变成同一个事务；Phase 4 明确表达这个
  不确定窗口。原子覆盖、乐观并发和文件崩溃对账留给 Phase 5。

本轮只交付 Phase 4。剩余 4 个阶段按可独立合并的小范围推进：

```text
Phase 5  文件修改：原子覆盖、并发校验、崩溃对账
Phase 6  Tool Contract v2：递归 schema、结构化输出、文档
Phase 7  执行策略：超时、重复调用防护、输出落盘、命令验证
Phase 8  故障注入与恢复验收、文档收尾
```
