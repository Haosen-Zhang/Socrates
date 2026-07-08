# Socrates 工程设计文档

## 1. 工程设计目标

本文件描述未来实现 Socrates 时建议采用的工程结构、领域模型、服务边界、存储设计、测试策略和发布策略。

当前仓库阶段不实现代码，只定义工程蓝图。

## 2. 领域模型

### 2.1 Provider

```ts
type ProviderType =
  | "openai_compatible"
  | "anthropic"
  | "google_gemini"
  | "ollama"
  | "custom";

type Provider = {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl?: string;
  apiKeyRef?: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
};
```

`apiKeyRef` 只引用系统 keychain 或加密 vault 中的 secret，不保存明文。

### 2.2 Model Capability

```ts
type ModelCapability = {
  providerId: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens?: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsJsonMode: boolean;
  supportsReasoningEffort: boolean;
  inputPricePerMTokens?: number;
  outputPricePerMTokens?: number;
};
```

### 2.3 Agent

```ts
type ToolPermission =
  | "read_files"
  | "search_files"
  | "read_git"
  | "write_files"
  | "apply_patch"
  | "run_terminal"
  | "network_access"
  | "git_write";

type Agent = {
  id: string;
  displayName: string;
  providerId: string;
  modelId: string;
  role: string;
  systemPrompt: string;
  style?: string;
  permissions: ToolPermission[];
  temperature?: number;
  maxTokens?: number;
  budgetLimitUsd?: number;
  canSummarize: boolean;
  canExecute: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### 2.4 Room

```ts
type RoomMode = "round_robin" | "debate" | "review_board" | "pipeline";

type Room = {
  id: string;
  name: string;
  projectPath?: string;
  agentIds: string[];
  defaultPolicyId?: string;
  roomRules?: string;
  memoryEnabled: boolean;
  createdAt: string;
  updatedAt: string;
};
```

### 2.5 Orchestration Policy

```ts
type OrchestrationPolicy = {
  id: string;
  name: string;
  mode: RoomMode;
  speakingOrder: string[];
  maxRounds: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  allowInterruption: boolean;
  requireCritique: boolean;
  requireCitationsToPreviousTurns: boolean;
  consensusRequired: boolean;
  finalSummaryAgentId: string;
  finalExecutorAgentId?: string;
  stopConditions: StopCondition[];
};

type StopCondition =
  | { type: "rounds_reached" }
  | { type: "budget_reached" }
  | { type: "consensus_reached" }
  | { type: "executor_ready" }
  | { type: "user_cancelled" };
```

### 2.6 Message and Turn

```ts
type MessageRole = "user" | "agent" | "tool" | "system";

type Message = {
  id: string;
  roomId: string;
  taskId?: string;
  role: MessageRole;
  agentId?: string;
  content: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

type Turn = {
  id: string;
  taskId: string;
  round: number;
  index: number;
  speakerAgentId: string;
  inputContextDigest: string;
  outputMessageId?: string;
  toolCallIds: string[];
  tokenUsage?: TokenUsage;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
};
```

### 2.7 Shared Blackboard

```ts
type Blackboard = {
  taskGoal: string;
  constraints: string[];
  assumptions: string[];
  findings: Finding[];
  proposals: Proposal[];
  critiques: Critique[];
  decisions: Decision[];
  actionPlan: ActionStep[];
  pendingQuestions: string[];
  executionArtifacts: ExecutionArtifact[];
};
```

黑板状态应按 task 保存快照，支持回放和 diff。

## 3. 服务模块

### 3.1 ProviderService

职责：

- 管理供应商配置。
- 测试连接。
- 拉取或手动维护模型列表。
- 暴露模型能力元数据。

### 3.2 AgentService

职责：

- 管理 Agent 配置。
- 校验 Agent 是否引用有效 Provider 和 Model。
- 管理 Agent 模板。

### 3.3 RoomService

职责：

- 管理 Room。
- 绑定项目路径。
- 管理 Room 成员。
- 管理 Room 默认策略。

### 3.4 OrchestrationService

职责：

- 启动任务。
- 暂停、继续、取消任务。
- 根据 policy 执行 turn loop。
- 发布 runtime event。

### 3.5 ContextService

职责：

- 构建每个 Agent 的输入上下文。
- 控制 token 预算。
- 记录上下文来源。
- 处理摘要和裁剪。

### 3.6 ModelGatewayService

职责：

- 统一调用 provider adapter。
- 处理 streaming。
- 标准化错误。
- 标准化 token usage。

### 3.7 ToolService

职责：

- 注册工具。
- 校验工具权限。
- 生成审批请求。
- 执行通过审批的工具调用。
- 写入审计日志。

### 3.8 StorageService

职责：

- SQLite 读写。
- migration。
- 数据导入导出。
- trace 保存。

## 4. Model Gateway 设计

### 4.1 统一输入

```ts
type ModelInput = {
  providerId: string;
  modelId: string;
  messages: ModelMessage[];
  system?: string;
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  responseFormat?: "text" | "json";
  stream: boolean;
  metadata?: Record<string, unknown>;
};
```

### 4.2 统一输出

```ts
type ModelOutput = {
  content: string;
  toolCalls?: ToolCallRequest[];
  finishReason?: "stop" | "length" | "tool_calls" | "error";
  tokenUsage?: TokenUsage;
  raw?: unknown;
};
```

### 4.3 Streaming Event

```ts
type ModelStreamEvent =
  | { type: "content_delta"; text: string }
  | { type: "tool_call_delta"; delta: unknown }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; output: ModelOutput }
  | { type: "error"; error: ModelError };
```

## 5. 存储设计

建议 SQLite 表：

- `providers`
- `models`
- `agents`
- `rooms`
- `room_agents`
- `policies`
- `tasks`
- `messages`
- `turns`
- `blackboard_snapshots`
- `tool_calls`
- `approvals`
- `usage_records`
- `audit_logs`

### 5.1 Secret 存储

API Key 不进 SQLite 明文字段。

桌面端优先使用：

- macOS Keychain。
- Windows Credential Manager。
- Linux Secret Service。

SQLite 只保存 `apiKeyRef`。

### 5.2 Trace 存储

每次任务都应保存完整 trace。

Trace 用于：

- UI 回放。
- debug 编排问题。
- 统计成本。
- 复盘模型表现。
- 生成 bug report。

## 6. 权限模型

权限分为三层：

1. Agent permission：Agent 是否有资格请求某类工具。
2. Room policy：当前 Room 是否允许这类工具。
3. User approval：具体操作是否获得用户批准。

只有三层都通过，工具才会执行。

## 7. 错误处理

### 7.1 Provider 错误

包括鉴权失败、限流、上下文过长、模型不存在、网络错误。

处理策略：

- 显示明确错误。
- 支持重试。
- 支持跳过当前 Agent。
- 支持替换模型继续。

### 7.2 Context 错误

包括文件不存在、权限不足、token 超限。

处理策略：

- 降级为摘要。
- 请求用户缩小范围。
- 跳过不可读文件并记录。

### 7.3 Tool 错误

包括 patch 冲突、命令超时、权限不足。

处理策略：

- 不自动重试破坏性操作。
- 保存失败记录。
- 将失败反馈给群聊，让 Agent 重新计划。

## 8. 并发和取消

MVP 可以先顺序执行每个 turn。

未来可支持：

- Review Board 中多个审查 Agent 并发发言。
- Context indexing 后台任务。
- Streaming UI 和 trace 写入并发。
- 用户随时取消任务。

所有长任务都应支持 cancellation token。

## 9. 测试策略

### 9.1 单元测试

重点覆盖：

- policy speaker selection。
- context token budgeting。
- provider adapter schema conversion。
- permission decision。
- blackboard update。

### 9.2 集成测试

重点覆盖：

- 一个完整 Room 的多轮讨论。
- provider mock streaming。
- tool approval flow。
- SQLite persistence。

### 9.3 回归测试

为常见任务保存 golden trace，例如：

- 三模型 round robin。
- debate 模式。
- provider 失败后跳过。
- 预算耗尽停止。
- 用户取消任务。

### 9.4 手工 QA

重点场景：

- 首次添加 API Key。
- 创建 Agent 和 Room。
- 长输出 streaming。
- 中途停止。
- 低网速和 provider 失败。
- 历史记录回放。

## 10. 可观测性

每个任务应产生 structured trace event。

建议事件：

- `task.started`
- `turn.started`
- `model.requested`
- `model.stream.delta`
- `model.completed`
- `blackboard.updated`
- `tool.requested`
- `approval.requested`
- `approval.granted`
- `tool.completed`
- `task.completed`
- `task.failed`

MVP 可只做本地日志和 UI trace，不做远程遥测。

## 11. 发布策略

### 11.1 MVP 内测

只发布 macOS unsigned 或本地构建版本即可。

### 11.2 V1

提供 macOS signed build，并开始支持 Windows。

### 11.3 V2

引入自动更新、崩溃报告、可选云同步。

## 12. 工程原则

- 先把多模型讨论做顺，再做自动执行。
- 所有副作用都必须可审计。
- Provider adapter 不应该泄漏到 UI。
- UI 不应该直接调用工具层。
- 任何模型输出都不能被默认信任。
- 用户永远能看见执行前的计划和影响范围。
