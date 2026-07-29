# Socrates 单 Agent Runtime 架构审查报告

> 审查基线：`main` @ `7c69d17` (Merge pull request #73 — fix/codex-version-compat)
>
> 审查日期：2026-07-29
>
> 审查人：Socrates Agent Runtime Reviewer (automated)
>
> 原则：所有结论必须附带 `文件路径:行号` 证据。不修改任何应用代码。

---

## 1. Executive Summary

**Socrates 当前 Runtime 处于 Prototype 阶段，核心问题如下：**

1. **P0 — Codex CLI 硬依赖**：所有 `workspace-write` 沙箱模式强制走本地 `codex app-server --stdio`，Socrates 自身不拥有 Agent Loop、Tool Routing、模型采样循环。当前 Runtime 实质是 **External Codex CLI Wrapper**，不是产品级 Agent Runtime。

2. **P0 — Desktop/Core 耦合**：桌面端 `store.ts`（~50KB）同时承担 SSE 传输、协议解析、业务状态迁移、持久化和 UI 状态；`ChatPage.tsx` 直接解析 `RuntimeEvent` 类型并做出 UI 分支决策。

3. **P1 — 缺少正式的状态机和事件协议**：Run / Turn / Tool 状态散落在多个文件和 boolean 标记中，没有统一的 Run ID、Turn ID、sequence 编号、幂等事件总线。

4. **P2 — Native AI SDK 路径已存在且干净**：`NativeAgentRuntime` 是脱离 Codex 的正确方向，但它是 `read-only` 默认路径；`workspace-write` 路径被 Codex 独占。

**正面发现**：三层包结构清晰（core/sidecar/desktop）、313 测试全绿、SQLite + WAL + Migration、Keychain 密钥管理、ADR 文档齐全、`AgentRuntime` 接口设计合理。

---

## 2. 当前真实架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│  apps/desktop (Tauri + React + Zustand)                             │
│  ┌──────────┐  ┌────────────┐  ┌─────────────────────────────────┐ │
│  │ ChatPage │  │ store.ts   │  │ Tauri Commands (lib.rs)         │ │
│  │ .tsx     │◄─┤ (49KB)     │◄─┤ sidecar_handshake               │ │
│  │ 解析      │  │ SSE 解析   │  │ spawn bun → sidecar             │ │
│  │ Runtime  │  │ 协议解析    │  │ stdout 握手                      │ │
│  │ Event    │  │ 状态管理   │  │ SIGKILL 清理                     │ │
│  │ 直接渲染  │  │ HTTP fetch │  └─────────────────────────────────┘ │
│  └──────────┘  └────────────┘                                      │
├─────────────────────────────────────────────────────────────────────┤
│  HTTP + SSE (127.0.0.1:随机端口, Bearer token)                      │
├─────────────────────────────────────────────────────────────────────┤
│  apps/sidecar (Bun + Hono)                                         │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │ index.ts — 组装所有服务，注册 Runtime                          │  │
│  │ ┌──────────────┐  ┌────────────────┐  ┌───────────────────┐  │  │
│  │ │RuntimeManager│  │SingleAgentRunner│  │MultiAgentCoordin. │  │  │
│  │ │ 注册两种 RT:  │  │ run/decide/    │  │ (旧编排路径)       │  │  │
│  │ │ codex_app_   │  │ cancel         │  │                   │  │  │
│  │ │ server       │  │                │  │                   │  │  │
│  │ │ native_ai_sdk│  │                │  │                   │  │  │
│  │ └──────┬───────┘  └────────────────┘  └───────────────────┘  │  │
│  │        │                                                      │  │
│  │ ┌──────┴──────────────────────────────────────────────────┐   │  │
│  │ │ AgentRuntime 实现                                        │   │  │
│  │ │ ┌─────────────────────┐  ┌────────────────────────────┐ │   │  │
│  │ │ │ CodexRuntime        │  │ NativeAgentRuntime         │ │   │  │
│  │ │ │ → spawn codex       │  │ → Vercel AI SDK streamText │ │   │  │
│  │ │ │   app-server --stdio│  │ → ToolRegistry + Executor  │ │   │  │
│  │ │ │ → JSONL protocol    │  │ → createAiSdkNativeStream  │ │   │  │
│  │ │ │ → /Applications/    │  │                            │ │   │  │
│  │ │ │   ChatGPT.app/...   │  │                            │ │   │  │
│  │ │ └─────────────────────┘  └────────────────────────────┘ │   │  │
│  │ └────────────────────────────────────────────────────────┘   │  │
│  └──────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  External Process                                                  │
│  ┌──────────────────────┐     ┌──────────────────────────────┐    │
│  │ codex binary         │     │ Provider APIs (OpenAI etc.)  │    │
│  │ (ChatGPT.app 自带)    │     │ via Vercel AI SDK            │    │
│  └──────────────────────┘     └──────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. 实际请求调用链

### 路径 A：workspace-write（Codex 路径，默认）

```
用户操作
→ ChatPage.tsx:658 submit()
→ ChatPage.tsx:662 sendAgentPrompt(prompt, "workspace-write")
→ store.ts:567 sendAgentPrompt()
→ store.ts:590 HTTP POST /agent/sessions/:id/runs
→ store.ts:596 runtimeKind = "codex_app_server"
→ routes/agent-runs.ts:14 default runtimeKind = "codex_app_server"
→ routes/agent-runs.ts:15 streamSSE
→ single-agent-runner.ts:58 run()
→ runtime-manager.ts:66 run() → active.runtime.start()
→ codex-runtime.ts:79 start() → client.startTurn()
→ protocol-client.ts:80 startTurn() → supervisor.request("turn/start")
→ child-supervisor.ts:53 spawn("codex", ["app-server", "--stdio"])
→ binary.ts:6 configuredCodexBinary() → "/Applications/ChatGPT.app/Contents/Resources/codex"
→ codex 进程通过 stdout JSONL 返回事件
→ child-supervisor.ts:55 readline → consumeLine → notificationHandler
→ codex-runtime.ts:84 onNotification → consumeNotification → queue.push(RuntimeEvent)
→ codex-runtime.ts:103 yield RuntimeEvent
→ runtime-manager.ts:73 for await (event) → onEvent callback
→ single-agent-runner.ts:141 onEvent → emit(event)
→ routes/agent-runs.ts:16 stream.writeSSE(event)
→ store.ts:634 JSON.parse(data) as RuntimeEvent
→ store.ts:636-659 手动 switch event.type 分支处理
→ set({ agentStreamText, agentEvents, agentRunning, ... })
→ ChatPage.tsx:711 rendering agentStreamText
→ ChatPage.tsx:712 agentEvents.filter → 渲染 tool_call 卡片
→ ChatPage.tsx:720 approval 匹配 → 渲染审批按钮
```

### 路径 B：read-only（Native AI SDK 路径）

```
用户操作
→ ChatPage.tsx:662 sendAgentPrompt(prompt, "read-only")
→ store.ts:596 runtimeKind = "native_ai_sdk"
→ native-agent-runtime.ts:154 start()
→ native-agent-runtime.ts:59 createAiSdkNativeStream(model)
→ Vercel AI SDK streamText() → fullStream
→ native-agent-runtime.ts:90 for await (part of result.fullStream)
→ yield NativeStreamPart → yield RuntimeEvent
→ 之后同路径 A 的 SSE → store → UI 链
```

---

## 4. Desktop/Core 耦合审查

### 4.1 耦合发现矩阵

| Finding ID | Severity | Confidence | 文件:行号 | 问题 |
|---|---|---|---|---|
| CPL-001 | P0 | Confirmed | `apps/desktop/src/store.ts:634` | 直接 `JSON.parse(data) as RuntimeEvent`，在 UI 层解析 SSE 协议 |
| CPL-002 | P0 | Confirmed | `apps/desktop/src/store.ts:636-659` | `event.type === "text_delta"` / `"tool_call"` / `"approval_required"` 的 switch 分支在 store 中直接处理业务状态迁移 |
| CPL-003 | P1 | Confirmed | `apps/desktop/src/store.ts:596` | `runtimeKind` 选择逻辑（`"read-only" ? "native_ai_sdk" : "codex_app_server"`）硬编码在桌面端 |
| CPL-004 | P1 | Confirmed | `apps/desktop/src/ChatPage.tsx:712` | `agentEvents.filter((event) => event.type === "tool_call")` — UI 直接消费 RuntimeEvent 做渲染决策 |
| CPL-005 | P1 | Confirmed | `apps/desktop/src/ChatPage.tsx:720` | `agentEvents.find((event) => event.type === "tool_call" && event.callId === rawId)` — UI 做工具调用关联 |
| CPL-006 | P2 | Confirmed | `apps/desktop/src/ChatPage.tsx:726-728` | 审批按钮直接调用 `decideAgentApproval(approval.id, "allow_once")` — 审批动作散落在组件中 |
| CPL-007 | P1 | Confirmed | `apps/desktop/src/store.ts:1-50` | `store.ts` 全长 ~50KB，同时包含：SSE transport（260-375行）、配置管理、Provider CRUD、Agent CRUD、Room CRUD、Session/Agent Run/Multi-Agent/Attachment/MCP 全部状态 |
| CPL-008 | P2 | Confirmed | `apps/desktop/src/store.ts:137` | `agentRunning: boolean` — Agent 状态简化为 boolean，无法表达 waiting/approval/failed 等中间态 |
| CPL-009 | P2 | Confirmed | `apps/desktop/src/store.ts:139` | `activeAgentRunId: string | null` — 只有一个 active run，不支持并发、重试或历史 run 引用 |

### 4.2 CPL-001 详细分析

```text
文件路径: apps/desktop/src/store.ts:634
相关函数: sendAgentPrompt (闭包内的 SSE 消费循环)
问题描述: 桌面端自行解析 SSE byte stream，按 \n\n 分割事件块，
         用 JSON.parse 反序列化后通过 as RuntimeEvent 类型断言，
         然后手动 switch event.type 做状态迁移。
为什么构成耦合: 这相当于在 UI 层重新实现了协议解析器和事件路由器。
推荐责任归属: SSE 解析和事件路由应属于 sidecar→desktop 的 transport
               adapter，不应在 store 中内联。
最小修复方案: 提取 `parseAgentSSEStream(reader): AsyncIterable<AgentUIEvent>`
             为独立 transport 模块；store 只订阅已解析事件。
```

### 4.3 CPL-003 详细分析

```text
文件路径: apps/desktop/src/store.ts:596
相关函数: sendAgentPrompt
问题描述: runtimeKind 由 sandbox UI 选择直接映射为字符串常量：
         sandbox === "read-only" ? "native_ai_sdk" : "codex_app_server"
为什么构成耦合: 桌面端知道 Runtime 种类名称和映射规则，sidecar 新增/移除
             Runtime 时桌面端代码也需要修改。
推荐责任归属: sandbox 语义（read-only / workspace-write）应发给 sidecar，
             sidecar 内部选择具体 Runtime 实现。
最小修复方案: 移除 runtimeKind 参数，改为发送 { sandbox: "read-only" | "workspace-write" }；
             sidecar 根据 sandbox + 可用 Runtime 自行选择。
```

### 4.4 Tauri/Rust 层检查

```text
文件: apps/desktop/src-tauri/src/lib.rs
检查结果:
- 唯一的 Tauri command: sidecar_handshake (line 22-24) — 只返回 handshake 数据 ✓
- spawn_sidecar (line 40-71): 用 Command::new("bun") 启动 sidecar ✓
- 退出清理: RunEvent::Exit → child.kill() (line 132-134) ✓
- Rust 层不包含 Agent 核心逻辑 ✓
- 问题: 开发模式依赖系统 Bun（line 42），发布包不含 sidecar 可执行文件
  （line 39 注释写明 "out of MVP scope"）
```

### 4.5 Sidecar HTTP Routes 胖瘦检查

```text
文件: apps/sidecar/src/routes/agent-runs.ts
检查结果:
- 路由层只做: 参数校验 → 调用 runner → SSE 写入 (line 11-29) ✓
- 不包含 Agent loop ✓
- 问题: 默认 runtimeKind = "codex_app_server" (line 14)
  这个默认值应该由 sidecar 的 Runtime 注册顺序或配置决定，不应硬编码在路由中

文件: apps/sidecar/src/index.ts
检查结果:
- index.ts 承担了所有服务组装（~217行），包括:
  - Runtime 注册 + factory (line 87-161)
  - DB 初始化 + migration
  - 所有 route 绑定
  - 进程信号处理
- 这是合理的 "composition root"，不算过胖 ✓
```

---

## 5. Codex CLI Dependency Audit（独立章节）

### 5.1 确认：存在 Codex CLI 硬依赖

**判定：当前 Runtime 是 External Codex CLI Wrapper，不是 Socrates Agent Runtime。**

### 5.2 完整调用链

```
Socrates Desktop
  → store.ts:596 runtimeKind = "codex_app_server"
  → HTTP POST /agent/sessions/:id/runs { runtimeKind: "codex_app_server" }
  → sidecar agent-runs.ts:14 默认 "codex_app_server"
  → SingleAgentRunner.run()
  → RuntimeManager.run() → active.runtime.start()
  → CodexRuntime.start() [codex-runtime.ts:79]
  → CodexProtocolClient.startTurn() [protocol-client.ts:80]
  → JsonlChildSupervisor.request("turn/start") [child-supervisor.ts:72]
  → child process stdin ← JSON-RPC 消息

外部进程:
  spawn("codex", ["app-server", "--stdio"])  [child-supervisor.ts:53]
  二进制路径: configuredCodexBinary() [binary.ts:6]
    → SOCRATES_CODEX_BINARY 环境变量 或
    → /Applications/ChatGPT.app/Contents/Resources/codex (macOS 默认)
  env: { PATH, HOME, TMPDIR, LANG, LC_ALL, CODEX_HOME } [child-supervisor.ts:24]
  stdout: JSONL 协议消息
  stderr: 截断到 32KB 并 redact

事件流:
  codex stdout → child-supervisor.ts:55 readline
  → consumeLine → notificationHandler [protocol-client.ts:47]
  → CodexRuntime.consumeNotification [codex-runtime.ts:177]
  → 映射为 RuntimeEvent: text_delta / tool_call / approval_required / status
  → SSE → Desktop
```

### 5.3 受影响功能

| 功能 | 依赖 Codex? | 证据 |
|---|---|---|
| workspace-write 沙箱 | **是 — 唯一路径** | `store.ts:596`: `sandbox === "workspace-write"` → `"codex_app_server"` |
| 文件变更审批 | **是** | `codex-runtime.ts:171-173`: `file_change` / `shell_command` 审批来自 Codex |
| 命令执行 | **是** | `protocol-client.ts:101`: `item/commandExecution/requestApproval` |
| Turn 生命周期 | **是** | `codex-runtime.ts:184-188`: `turn/completed` 事件来自 Codex |
| Cancel/Interrupt | **是（子进程 kill）** | `codex-runtime.ts:157`: `client.interrupt()` → `supervisor.request("turn/interrupt")` |
| read-only 沙箱 | **否** | `store.ts:596`: 走 `native_ai_sdk` |
| multi-agent 编排 | **否** | 走旧 `MultiAgentCoordinator` |

### 5.4 对产品交付的影响

| 维度 | 影响 |
|---|---|
| **认证** | 要求用户安装 ChatGPT.app 并登录 Codex，Socrates 自身无独立认证 |
| **额度** | 消耗用户 Codex/ChatGPT 订阅额度，Socrates 不管理计费 |
| **取消** | Cancel = 发送 JSON-RPC `turn/interrupt` + kill 子进程；若 Codex 协议无响应，依赖 SIGTERM/SIGKILL |
| **状态机** | Turn 状态来自 Codex `turn/completed` 通知，Socrates 不自主管理 |
| **错误分类** | Codex 错误直接映射为 `RuntimeEvent.status = "failed"`，无细粒度分类 |
| **Multi-Agent** | Codex Runtime 不支持多 Agent 并发；每个 Agent 需要独立 child process |

### 5.5 受影响代码清单

```text
必须移除/替换:
  apps/sidecar/src/runtime/codex/codex-runtime.ts        — CodexRuntime 实现
  apps/sidecar/src/runtime/codex/protocol-client.ts       — Codex JSONL 协议客户端
  apps/sidecar/src/runtime/codex/binary.ts                — Codex 二进制发现
  apps/sidecar/src/runtime/codex/protocol-v0.144.5.ts     — 版本 pin 和类型定义
  apps/sidecar/src/runtime/codex/fixtures/fake-app-server.ts — 测试辅助
  apps/sidecar/src/runtime/child-supervisor.ts            — spawn 子进程（仅 Codex 使用）

需要隔离/修改:
  apps/sidecar/src/index.ts:87-109                        — Codex Runtime 注册
  apps/desktop/src/store.ts:596                           — runtimeKind 选择逻辑
  apps/desktop/src/ChatPage.tsx:688                       — UI 文案引用
  apps/desktop/src/i18n.ts:236,564,887                    — 翻译字符串
  apps/sidecar/src/routes/agent-runs.ts:14                — 默认 runtimeKind

可保留（仅参考架构思想）:
  apps/sidecar/src/runtime/codex/*.test.ts                — 测试用例架构参考

必须保留/迁移:
  apps/sidecar/src/runtime/native-agent-runtime.ts        — 正确的纯 Socrates Runtime
  apps/sidecar/src/runtime/single-agent-runner.ts          — Runner 逻辑（需适配）
  apps/sidecar/src/runtime/runtime-manager.ts              — Runtime 注册管理
```

### 5.6 不依赖 Codex 的最小替换方案

**目标架构：**

```text
Desktop
→ { sandbox: "read-only" | "workspace-write" }  (不传 runtimeKind)
→ Socrates Sidecar
→ SingleAgentRunner
→ NativeAgentRuntime (统一路径)
   ├── read-only:  ToolRegistry = createReadOnlyBuiltins
   └── workspace-write: ToolRegistry = createReadOnlyBuiltins + workspaceWriteTools
→ Vercel AI SDK streamText
→ 用户配置的模型 API (OpenAI / Anthropic / Google / Ollama)
```

**关键变化：**

1. `NativeAgentRuntime` 扩展为支持 `workspace-write` 工具（`write_files`、`apply_patch`、`run_terminal`）
2. `ToolExecutor` 已有审批集成（`single-agent-runner.ts:148-168`），可直接复用
3. 移除 `codex_app_server` Runtime 注册
4. `sandbox` → Runtime 选择的映射移到 sidecar 内部

### 5.7 迁移影响

迁移过程**不会**导致功能完全不可用：
- `read-only` 沙箱（`native_ai_sdk`）已经完整可用 → 零影响
- `workspace-write` 沙箱暂时不可用 → 需要实现原生写工具
- multi-agent 路径不受影响（走独立 coordinator）
- 所有现有测试（313 pass）在移除 Codex 后需要更新路径

### 5.8 验证脱离 Codex 的测试方法

```bash
# 1. 确认无 codex 引用
rg -n -i 'codex|CODEX_HOME' apps packages --include='*.ts' --include='*.tsx' --include='*.rs' \
  --exclude='*.test.ts' --exclude='node_modules' --exclude='target'

# 2. 确认无 spawn/execFile 启动外部二进制（除 sidecar 自身启动外）
rg -n 'spawn|execFile' apps/sidecar/src --include='*.ts' | grep -v 'test'

# 3. 运行完整测试套件
bun test && bun run typecheck && bun run --cwd apps/desktop build

# 4. 手动验证: workspace-write 模式下工具执行不依赖本地 codex 二进制
```

---

## 6. Runtime 能力矩阵

### 6.1 Runtime 基础

| 能力 | 状态 | 证据 |
|---|---|---|
| Thread/Run/Turn/Step/Item 区别 | **Missing** | 只有 `RuntimeEvent` 扁平类型，无层级结构 |
| Agent loop 入口 | **Prototype** | `NativeAgentRuntime.start()` (native-agent-runtime.ts:154) / `CodexRuntime.start()` (codex-runtime.ts:79) |
| 一次 Turn 内多次模型采样 | **Prototype** | `NativeAgentRuntime`: Vercel AI SDK 的 `maxSteps` 循环 (native-agent-runtime.ts:75)，但 Tool Result 回填后继续采样的逻辑不完整 |
| 文本和 Tool Call 统一处理 | **MVP** | `RuntimeEvent` 有 `text_delta` 和 `tool_call` 两种事件 |
| 明确终止条件 | **Prototype** | `maxSteps` 限制（默认 8），`stopWhen: stepCountIs(remainingSteps)` |
| 并发 Active Turn 限制 | **MVP** | `CodexRuntime`: `codex_runtime_turn_already_active` (codex-runtime.ts:81); `SingleAgentRunner`: `session_already_running` 检查 (single-agent-runner.ts:66) |
| 用户追加输入 | **Missing** | 仅在 multi-agent 路径有 pause/resume |
| Retry 语义 | **Missing** | 只有 multi-agent 路径的 `retryMultiTask` |
| Cancel 语义 | **Prototype** | `AbortSignal` → `interrupt()`，但无优雅降级 |

### 6.2 Command/Event 协议

| 属性 | 状态 | 证据 |
|---|---|---|
| runId | **Prototype** | 有 `runId` 在 `agent_runs` 表中 (single-agent-runner.ts:83)，但不在每个 `RuntimeEvent` 中 |
| agentId | **MVP** | 在 `RuntimeManager.run()` 回调中附加 (runtime-manager.ts:80) |
| turnId | **Missing** | 无独立 turnId，`CodexRuntime` 内部有 `turnId` 但不向外暴露 |
| itemId | **Missing** | 无 item 层级 |
| toolCallId | **MVP** | `RuntimeEvent.tool_call.callId` (runtime.ts:29) |
| eventId | **MVP** | `EventStore` 使用 `eventId` (events.ts:2) |
| sequence | **Prototype** | `SessionEvent.seq` (events.ts:5)，但 Runtime 事件不携带 |
| correlationId/causationId | **Missing** | 无因果追踪 |
| protocolVersion | **Missing** | 硬编码 `'1'` 在 runtime_sessions 表中 (runtime-manager.ts:53) |
| timestamp | **Prototype** | `SessionEvent.occurredAt` 可选 (events.ts:8)，Runtime 事件不携带 |
| command 幂等 | **Missing** | 无幂等键 |
| event 严格有序 | **Prototype** | `reduceSessionEvent` 检查 seq gap (events.ts:20-25)，但 Runtime 事件不通过此机制 |
| SSE 断线恢复 | **Missing** | 无 `Last-Event-Id` / seq 恢复 |
| 未知事件处理 | **Missing** | 无版本协商 |
| frontend 推导业务事实 | **P0** | `ChatPage.tsx:720` 从 `agentEvents` 数组关联 tool_call 和 approval |

### 6.3 Cancellation

| 传播层级 | 状态 | 证据 |
|---|---|---|
| HTTP request | **MVP** | `c.req.raw.signal` 传递给 runner (agent-runs.ts:25) |
| Agent Runtime | **MVP** | `AbortSignal` → `interrupt()` (native-agent-runtime.ts:252; codex-runtime.ts:156-160) |
| Model stream | **MVP** | Vercel AI SDK `abortSignal` (native-agent-runtime.ts:83) |
| Tool execution | **Prototype** | `ToolContext.signal` 传递，但无超时 |
| Child process | **MVP** | `child.kill("SIGTERM")` → `SIGKILL` (child-supervisor.ts:93-98) |
| Database state | **MVP** | `agent_runs.status = 'cancelled'` 写入 (single-agent-runner.ts:190-193) |
| SSE terminal event | **MVP** | `run_terminal` SSE event (agent-runs.ts:28) |
| 竞态: 快速取消 | **Unknown** | 无专项测试 |
| 竞态: 模型输出中取消 | **Prototype** | `interrupted = true` 标志 + reject pending approvals |
| 竞态: 完成瞬间取消 | **Unknown** | 无专项测试 |

### 6.4 Retry 和幂等性

| 类型 | 状态 | 证据 |
|---|---|---|
| 模型网络重试 | **MVP** | Vercel AI SDK `maxRetries: 2` (native-agent-runtime.ts:84) |
| 用户重新执行 Turn | **Missing** | 无 retry API |
| 从失败点恢复 | **Missing** | 无 checkpoint/resume |
| 完整 Run 重试 | **Missing** | 只有 multi-agent 的 `retryMultiTask` |
| 工具重试 | **Missing** | 无工具级重试 |
| 危险工具幂等保护 | **Prototype** | `makeToolCallKey` 提供幂等键 (tools.ts:54-56)，`hashToolInput` 在 approval 中使用 |

### 6.5 Persistence 和 Crash Recovery

| 特性 | 状态 | 证据 |
|---|---|---|
| SQLite WAL | **Production-ready** | `PRAGMA journal_mode = WAL` (db.ts:10) |
| Foreign Keys | **Production-ready** | `PRAGMA foreign_keys = ON` (db.ts:11) |
| Migration | **Production-ready** | 9 个 migration 文件，checksum + backup |
| Run 持久化 | **MVP** | `agent_runs` 表 (single-agent-runner.ts:99) |
| Turn 持久化 | **Prototype** | 只有 multi-agent turns 表 |
| Tool Call 持久化 | **MVP** | `tool_calls` 表在 migration 003 中定义 |
| Event Journal | **MVP** | `EventStore` / `SessionEvent` 类型 |
| 崩溃恢复 | **MVP** | `recoverInterrupted()` (single-agent-runner.ts:36-56, runtime-manager.ts:126-131) |
| 重启后误执行 Tool | **Protected** | `recoverInterrupted()` 将 pending approval 标记 `expired` |
| Pending Approval 恢复 | **MVP** | `approvals.recoverPending()` (agent-runs.ts:31) |
| 历史回放 | **Prototype** | 只是消息回放，不是 Runtime 状态恢复 |
| DB 写入与 SSE 发布不一致 | **Risk** | `onEvent` 在 `events.append` 后 emit，但 SSE 写入和 DB 提交不在同一事务 |

### 6.6 Model Runtime

| 特性 | 状态 | 证据 |
|---|---|---|
| Provider 统一接口 | **MVP** | `ModelGateway` (Vercel AI SDK) / `NativeStreamFactory` |
| 流式事件标准化 | **MVP** | `NativeStreamPart` 类型 |
| AbortSignal | **MVP** | 传递到 `streamText` |
| Timeout | **Missing** | Vercel AI SDK 无超时配置 |
| 有限重试 | **MVP** | `maxRetries: 2` |
| 错误分类 | **Missing** | 错误以 string message 传递，无结构化分类 |
| Token Usage | **MVP** | `NormalizedUsage` + `UsageCollector` |
| Context Window | **Missing** | 无 token 计数或窗口管理 |
| 上下文压缩 | **Prototype** | `ContextCompaction` service 存在但未集成到 NativeAgentRuntime |
| Provider 工具格式泄漏 | **Protected** | Vercel AI SDK 抽象了工具格式 ✓ |

### 6.7 Tool Runtime

| 特性 | 状态 | 证据 |
|---|---|---|
| Tool Registry | **MVP** | `ToolRegistry` (registry.ts) |
| Tool Schema | **MVP** | `ToolDefinition` + `JsonSchema` (tools.ts:14-23) |
| Tool Router | **Prototype** | `ToolExecutor.invoke()` (executor.ts)，但路由依赖 stableKey |
| Approval Policy | **MVP** | `ApprovalManager` + `permissionForTool` (native-agent-runtime.ts:145) |
| Workspace/Path Boundary | **MVP** | `WorkspacePathPolicy` (path-policy.ts) |
| Timeout | **Missing** | 工具执行无超时 |
| Cancellation | **MVP** | `ToolContext.signal` |
| stdout/stderr Streaming | **Missing** | 工具结果为最终值，无流式 |
| Output Truncation | **MVP** | `truncateToolOutput()` (tools.ts:58-73) |
| Exit Metadata | **Prototype** | `ToolCallStatus` 包含 `timed_out`，但未使用 |
| 非法 Tool Call | **Prototype** | `validateJsonSchemaInput` (tools.ts:37-52) |
| 重复 Tool Call | **MVP** | `makeToolCallKey` + `approvedCalls` set |
| 危险命令保护 | **MVP** | `risk: "destructive"` + `freshHumanRequired` |
| 沙箱 | **Missing** | 没有真实的沙箱/容器隔离 |

### 6.8 Sidecar 生命周期

| 特性 | 状态 | 证据 |
|---|---|---|
| Tauri 启动 sidecar | **MVP** | `spawn_sidecar()` (lib.rs:40-71), `Command::new("bun")` |
| 开发模式依赖系统 Bun | **Confirmed** | lib.rs:42 — "out of MVP scope" |
| 发布包不含 sidecar bin | **Confirmed** | lib.rs:39 注释 |
| 随机端口 + token 握手 | **MVP** | `Bun.serve({ port: 0 })` → stdout JSON (index.ts:197-217) |
| localhost binding | **Production-ready** | `hostname: "127.0.0.1"` + loopback origin check |
| 健康检查 | **MVP** | `GET /health` (index.ts:185) |
| 版本握手 | **Missing** | 无 sidecar/desktop 版本协商 |
| 启动超时 | **Prototype** | Desktop 轮询 40 次 × 250ms = 10s (store.ts:237-238) |
| 崩溃重启 | **Missing** | 无自动重启 |
| 退出清理 | **MVP** | SIGINT/SIGTERM → `stopManagedServices()` (index.ts:213-215) |
| 孤儿进程 | **Protected** | `process.ppid === 1` 检测 (index.ts:49) |
| 日志位置 | **Prototype** | console.log，无结构化日志 |
| 数据库升级兼容性 | **MVP** | 9 个 migration + backup |

---

## 7. 四状态域现状映射

### 7.1 Run State

**建议目标:**
```text
created → running → pausing → paused
                 → cancelling → cancelled
                 → completed
                 → failed
```

**当前实现:**

```text
实际位置: apps/sidecar/src/runtime/runtime-manager.ts:6
RuntimeStatus = "opening" | "ready" | "running" | "awaiting_approval"
              | "interrupted" | "completed" | "failed" | "closed"

实际位置: apps/sidecar/src/runtime/single-agent-runner.ts:22
AgentRunResult.status = "completed" | "failed" | "cancelled"

实际位置: apps/sidecar/src/runtime/single-agent-runner.ts:99
agent_runs.status 写入值: "preparing" | "running" | "awaiting_approval"
                         | "completed" | "failed" | "cancelled" | "interrupted"

实际位置: apps/desktop/src/store.ts:137
agentRunning: boolean  ← 只有 true/false，无中间态
```

**问题：**
- `RuntimeStatus` 混入 `opening`/`ready`/`closed` 等 Runtime 生命周期状态和 `running`/`completed` 等执行状态 → 一个字符串表达两个维度
- `agent_runs.status` 和 `runtime_sessions.status` 是两个独立列，但语义重叠
- 缺少 `pausing`/`paused` 状态和 `cancelling` 中间态
- 桌面端将 run 状态简化为 `boolean`

### 7.2 Agent State

**建议目标:**
```text
ready → running → waiting → interrupted → completed
                            → failed → stopped
```

**当前实现:** 无独立 Agent State。Agent 是静态配置，无运行时状态。

```text
实际位置: packages/core/src/runtime.ts:35-44
AgentRuntime interface — 只有方法，无状态字段

实际位置: apps/sidecar/src/runtime/single-agent-runner.ts:14
ActiveRun = { runtimeSessionId, calls: Map, cancelled: boolean }
```

**问题：** Agent 无运行时状态机。`NativeAgentRuntime` 内部用 `opened`/`interrupted` boolean 追踪。

### 7.3 Turn State

**建议目标:**
```text
queued → preparing → sampling → processing_response
       → awaiting_tool_approval → executing_tools
       → awaiting_user → compacting → finalizing
       → completed | failed | cancelled
```

**当前实现:**

```text
实际位置: packages/core/src/task-state.ts:1-4
TaskState = "idle" | "preparing" | "discussing" | "synthesizing"
          | "awaiting_plan_approval" | "revising_plan" | "executing"
          | "awaiting_tool_approval" | "paused" | "failed" | "cancelled" | "completed"

这是 multi-agent task 的状态，不是单 Agent Turn 状态。

单 Agent Turn 的实际状态:
  隐含在 NativeAgentRuntime.start() 的生成器生命周期中:
  - running (yield 之前)
  - sampling (streamText 调用中)
  - processing_response (处理 tool-call)
  - awaiting_tool_approval (approval_required 事件)
  - executing_tools (工具执行)
  - completed (yield status="completed")
  - 无独立 Turn 标识
```

**问题：**
- 单 Agent 路径无 Turn 概念，只有 Run
- 所有中间状态由事件推导，无显式状态机
- Turn 只在 multi-agent 路径中有 `turns` 表记录

### 7.4 Tool State

**建议目标:**
```text
proposed → awaiting_approval → approved → running
         → rejected           → succeeded | failed | cancelled | timed_out
```

**当前实现:**

```text
实际位置: packages/core/src/tools.ts:12
ToolCallStatus = "queued" | "awaiting_approval" | "running"
               | "succeeded" | "failed" | "cancelled" | "timed_out"

✓ 这个定义接近目标，但:
- "proposed" 和 "queued" 语义不同
- "approved" 状态缺失，"awaiting_approval" → "running" 跳过了批准确认
- 实际使用中，工具状态由 ToolExecutor 管理，不通过事件系统发布
```

### 7.5 状态迁移验证

| 检查项 | 状态 | 证据 |
|---|---|---|
| 状态混在 Room/Message/Task/UI store | **Confirmed** | `agentRunning: boolean` 在 store.ts 中 (line 137) |
| 同一字符串表达多维 | **Confirmed** | `RuntimeStatus` 混合 Runtime 生命周期和执行状态 |
| 允许任意代码直接写 status | **Confirmed** | `updateStatus(id, status)` 无校验 (runtime-manager.ts:138) |
| 非法迁移 | **Protected** | `runtimeTransitionAllowed()` 有检查但未被 `updateStatus` 调用 |
| 缺少终态 | **Partial** | `RuntimeStatus` 有 `completed`/`failed`/`closed` 终态 |
| Cancel/Retry/Pause 矛盾 | **Risk** | `cancelled` boolean + `interrupted` boolean 可能同时为 true |
| 数据库和内存状态漂移 | **Risk** | active Map 和 DB 行之间无事务性保证 |
| frontend 自行决定状态 | **Confirmed** | `ChatPage.tsx` 根据 `agentRunning` + `agentError` + `agentStreamText` 推断状态 |
| 纯 reducer 测试 | **Partial** | `reduceTaskState` (task-state.ts:38) 可测试，但 Runtime 状态无 reducer |

---

## 8. 状态迁移表和不变量

### 8.1 Run State 迁移表

| 当前状态 | 允许迁移到 | 触发条件 |
|---|---|---|
| `created` | `running` | `SingleAgentRunner.run()` 开始执行 |
| `running` | `completed` | 正常结束 |
| `running` | `failed` | 异常终止 |
| `running` | `cancelling` | 用户取消 |
| `running` | `awaiting_approval` | Tool 需要审批 |
| `awaiting_approval` | `running` | 审批决策完成 |
| `awaiting_approval` | `cancelling` | 用户在审批等待中取消 |
| `cancelling` | `cancelled` | 取消完成 |

**不变量：**
- 只有 `running` 状态的 Run 才能发出 `text_delta` / `tool_call` 事件
- 只有 `awaiting_approval` 状态的 Run 才能接收 `answerApproval` 调用
- `cancelling` 是瞬态，必须在有限时间内达到 `cancelled`
- 终态（`completed`/`failed`/`cancelled`）不可再迁移

### 8.2 Agent State 迁移表

| 当前状态 | 允许迁移到 | 触发条件 |
|---|---|---|
| `ready` | `running` | Run 开始 |
| `running` | `waiting` | 等待审批或用户输入 |
| `waiting` | `running` | 审批完成或用户继续 |
| `running` | `interrupted` | 收到 interrupt() |
| `interrupted` | `stopped` | close() |
| `running` | `completed` | Turn 完成 |
| `running` | `failed` | 不可恢复错误 |
| `completed` | `stopped` | close() |
| `failed` | `stopped` | close() |

### 8.3 Turn State 迁移表

| 当前状态 | 允许迁移到 | 触发条件 |
|---|---|---|
| `queued` | `preparing` | 开始构建上下文 |
| `preparing` | `sampling` | 发起模型请求 |
| `sampling` | `processing_response` | 收到完整响应 |
| `processing_response` | `completed` | 无工具调用 |
| `processing_response` | `awaiting_tool_approval` | 需要审批的工具调用 |
| `processing_response` | `executing_tools` | 不需要审批的工具调用 |
| `awaiting_tool_approval` | `executing_tools` | 审批通过 |
| `awaiting_tool_approval` | `completed` | 审批拒绝 |
| `executing_tools` | `sampling` | 工具结果回填，继续采样 |
| `executing_tools` | `completed` | 所有工具完成，无更多步骤 |
| 任意非终态 | `failed` | 错误 |
| 任意非终态 | `cancelled` | 取消 |

### 8.4 Tool State 迁移表

| 当前状态 | 允许迁移到 | 触发条件 |
|---|---|---|
| `proposed` | `awaiting_approval` | 工具需要审批 |
| `proposed` | `approved` | 工具无需审批 |
| `awaiting_approval` | `approved` | 用户批准 |
| `awaiting_approval` | `rejected` | 用户拒绝 |
| `approved` | `running` | 开始执行 |
| `running` | `succeeded` | 执行成功 |
| `running` | `failed` | 执行异常 |
| `running` | `timed_out` | 超时 |
| `running` | `cancelled` | Run 取消 |

**不变量：**
- `succeeded` 后才能将 output 回填模型
- `rejected` / `failed` / `timed_out` 作为错误信息回填
- 非幂等工具不能在同一个 Run 的同一个 Turn 中执行两次

---

## 9. 未来 Multi-Agent 兼容性

### 9.1 兼容性检查

| 检查项 | 状态 | 证据 |
|---|---|---|
| 稳定 agentId | ✓ | `AgentRuntime.start()` 上下文通过 `RuntimeOpenInput.agentId` 传递 |
| 独立 Turn/Context/Tool | ✓ | `AgentRuntime` 实例化时注入 `sessionId`/`agentId`/`workspaceId` |
| AgentRuntime 可多次实例化 | ✓ | `RuntimeManager` 的 `factories` Map + `active` Map 支持多个实例 |
| SingleAgentCoordinator 与 AgentRuntime 分离 | ✓ | `SingleAgentRunner` 不在 `AgentRuntime` 内部 |
| Provider/Tool/Approval 不依赖全局单例 | ✓ | 通过构造函数注入 |
| event 中可定位 agentId | ⚠ | `RuntimeManager.run()` 在 payload 中附加 `agentId` (runtime-manager.ts:80)，但 `RuntimeEvent` 类型本身不包含 |
| future parentAgentId | ✓ | 类型系统可扩展 |
| 旧编排路径干扰 | ⚠ | Round Robin/Debate 在 `orchestration.ts` 中是独立路径，不与新 Runtime 冲突 |
| 复用模型循环/工具/审批/取消/持久化 | ✓ | `NativeAgentRuntime` + `ToolExecutor` + `ApprovalManager` + `EventStore` 可复用 |

### 9.2 第一阶段不实现的内容（确认冻结）

```text
✗ Manager–Worker 调度 — 不实现，但 SingleAgentRunner 可被 Manager 调用
✗ 子 Agent spawn — 不实现
✗ Agent mailbox — 不实现
✗ 共享黑板 — 不实现（ADR 0003）
✗ 复杂 DAG — 不实现
✗ Agent Graph Scheduler — 不实现
✗ 新 Debate/Round Robin — 不实现（现有功能冻结）
✗ 长期记忆 — 不实现
✗ 远程执行 — 不实现
```

---

## 10. P0/P1/P2 风险列表

### P0 — 必须立即解决

| Finding ID | 风险 | 影响 |
|---|---|---|
| **CODEX-001** | Codex CLI 是 workspace-write 的唯一 Runtime | 产品无法独立交付；依赖用户安装 ChatGPT.app；消耗 Codex 订阅；Cancel 只是杀进程 |
| **CPL-001** | 桌面端 store.ts 自行解析 SSE 和 RuntimeEvent | UI 与协议耦合；修改事件格式需要同时改桌面端 |
| **CPL-002** | 桌面端 store.ts 手动处理 event.type 分支 | 业务状态迁移在 UI 层；重复事件处理、竞态条件 |

### P1 — 第一阶段必须解决

| Finding ID | 风险 | 影响 |
|---|---|---|
| **STATE-001** | 无正式 Run/Turn 状态机 | 无法可靠实现 Cancel/Retry/Pause |
| **STATE-002** | agentRunning: boolean 无法表达中间态 | UI 边界情况不可控 |
| **PROTO-001** | RuntimeEvent 缺少 runId/turnId/sequence/timestamp | SSE 断线无法恢复；无法去重；无法审计 |
| **CPL-003** | runtimeKind 选择逻辑在桌面端 | 新增 Runtime 需要改桌面代码 |
| **PERS-001** | DB 写入和 SSE 发布不在同一事务 | 崩溃时可能丢失已 SSE 但未持久化的事件 |
| **TOOL-001** | 工具执行无超时 | 单工具可无限阻塞整个 Run |

### P2 — 建议解决

| Finding ID | 风险 | 影响 |
|---|---|---|
| **CTX-001** | 无 Context Window 跟踪 | 可能超出模型限制 |
| **CANCEL-001** | 快速取消和完成瞬间取消竞态未测试 | 不确定行为 |
| **SIDECAR-001** | 发布包无 sidecar 可执行文件 | 只能开发模式运行 |
| **LOG-001** | 无结构化日志 | 调试和审计困难 |
| **STORE-001** | store.ts 50KB 单体 | 难以维护和测试 |

---

## 11. 建议的最小目标架构

```
┌────────────────────────────────────────────────────────────┐
│  apps/desktop                                              │
│  ┌──────────┐  ┌────────────────┐  ┌──────────────────┐   │
│  │ ChatPage │  │ AgentStore     │  │ TransportAdapter │   │
│  │ 只渲染    │  │ (UI 投影状态)  │  │ parseSSE / fetch │   │
│  │ UIEvent  │  │ agentRun       │  │ 不解析业务语义    │   │
│  └──────────┘  │ agentTurns     │  └──────────────────┘   │
│                │ agentTools     │                          │
│                │ agentApprovals │                          │
│                └────────────────┘                          │
├────────────────────────────────────────────────────────────┤
│  SSE (Protocol v1: 每个 event 携带 runId, turnId, seq)     │
├────────────────────────────────────────────────────────────┤
│  apps/sidecar                                              │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ SingleAgentRunner (重构)                              │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │  │
│  │  │ RunState     │  │ TurnLoop     │  │ EventBus   │  │  │
│  │  │ Machine      │  │ (纯函数)     │  │ (seq,去重) │  │  │
│  │  └─────────────┘  └──────────────┘  └────────────┘  │  │
│  │  ┌──────────────────────────────────────────────┐    │  │
│  │  │ NativeAgentRuntime (唯一 Runtime 实现)        │    │  │
│  │  │  ├─ read-only tools:  createReadOnlyBuiltins │    │  │
│  │  │  └─ write tools:      workspaceWriteTools    │    │  │
│  │  └──────────────────────────────────────────────┘    │  │
│  └──────────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────────┐  │
│  │ ToolExecutor + ApprovalManager + EventStore          │  │
│  │ (已有，无需大改)                                      │  │
│  └──────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────┘
```

**关键变化：**
1. 移除 `CodexRuntime` 和 `child-supervisor.ts`（Codex spawn 逻辑）
2. `NativeAgentRuntime` 扩展为唯一 Runtime，支持 read-only 和 workspace-write 两种 tool set
3. `SingleAgentRunner` 内部增加显式 Run/Turn 状态机
4. 事件总线增加 sequence 编号和去重
5. 桌面端提取 TransportAdapter，store 只保存 UI 投影状态
6. sandbox 选择从桌面端移到 sidecar 内部

---

## 12. 按文件列出的最小重构计划

| 文件 | 动作 | 优先级 |
|---|---|---|
| `apps/sidecar/src/runtime/codex/*` | **移除** 整个目录（6 个文件） | P0 |
| `apps/sidecar/src/runtime/child-supervisor.ts` | **移除**（仅 Codex 使用） | P0 |
| `apps/sidecar/src/index.ts:87-109` | **移除** Codex Runtime 注册 | P0 |
| `apps/sidecar/src/routes/agent-runs.ts:14` | **修改** 默认 runtimeKind 为 `native_ai_sdk` | P0 |
| `apps/desktop/src/store.ts:596` | **修改** 移除 runtimeKind 选择，改为传 sandbox | P0 |
| `apps/desktop/src/ChatPage.tsx:688` | **修改** 移除 Codex 文案引用 | P0 |
| `apps/desktop/src/i18n.ts:236,564,887` | **修改** 移除 Codex 翻译字符串 | P0 |
| `packages/core/src/runtime.ts` | **扩展** RuntimeEvent 增加 runId/turnId/sequence/timestamp | P1 |
| `apps/sidecar/src/runtime/native-agent-runtime.ts` | **扩展** 支持 workspace-write 工具 | P1 |
| `apps/sidecar/src/runtime/single-agent-runner.ts` | **重构** 增加 Run/Turn 状态机 | P1 |
| `apps/sidecar/src/runtime/runtime-manager.ts` | **修改** 使用 transition 校验 | P1 |
| `apps/desktop/src/store.ts` | **拆分** 提取 TransportAdapter (~500行 SSE 解析) | P1 |
| `apps/desktop/src/store.ts` | **拆分** 拆分为 agentStore / roomStore / providerStore | P2 |
| `packages/core/src/task-state.ts` | **新增** 单 Agent Run/Turn 状态 reducer | P1 |

---

## 13. 测试缺口

### 现有的测试（313 pass）
- ✓ 核心类型测试（handshake, provider, chat, config, orchestration 等）
- ✓ Sidecar routes 测试
- ✓ Tool executor/registry 测试
- ✓ Approval manager 测试
- ✓ Migration 测试
- ✓ Codex Runtime 集成测试（将被移除）
- ✓ Native Agent Runtime 测试

### 第一阶段需要的测试

```text
□ state transition tests — Run/Turn/Tool 状态迁移的纯函数测试
□ single-agent runtime integration test — 完整 Run 从 prompt 到 completed
□ provider stream mock test — 模拟模型流式响应
□ tool approval test — 审批流程端到端
□ cancellation race tests — 快速取消 / 模型输出中取消 / 完成瞬间取消
□ SSE reconnect/replay test — 断线后从 last sequence 恢复
□ idempotency test — 重复事件不重复更新 UI
□ sidecar crash/restart test — 崩溃恢复不误执行 Tool
□ SQLite migration test — 已有（009_room_kind），需增加
□ packaged Tauri smoke test — 目前无法执行（无 sidecar bin）
□ workspace-write tool tests — 写文件/执行命令
□ tool timeout test
□ context window overflow test
```

---

## 14. Phase 1 验收标准

1. **Codex 完全移除**：`rg -i codex apps packages --include='*.ts' --include='*.tsx'` 仅在注释/文档中出现，无运行时引用
2. **workspace-write 可用**：在 `native_ai_sdk` 路径下，通过 ToolRegistry 执行 `write_files` 和 `shell` 工具
3. **Run/Turn 状态机**：`packages/core/src/` 中有纯 reducer 函数和单元测试
4. **事件协议增强**：每个 RuntimeEvent 携带 `runId`、`turnId`、`sequence`、`timestamp`
5. **桌面端解耦**：`store.ts` 中的 SSE 解析提取为独立 transport 模块
6. **sandbox 选择在 sidecar**：桌面端只传 `{ sandbox: "read-only" | "workspace-write" }`
7. **测试全绿**：`bun test` + `bun run typecheck` + `bun run --cwd apps/desktop build`
8. **新增测试**：状态迁移测试 + 取消竞态测试 + 审批测试 + 工具超时测试

---

## 15. 最终判断

### 1. 当前架构是否真正实现 UI 与 Agent Core 解耦？
**否。** 桌面端 `store.ts` 直接解析 SSE 字节流和 `RuntimeEvent` 类型，`ChatPage.tsx` 根据事件 type 做出 UI 分支决策。Runtime 选择逻辑（`codex_app_server` vs `native_ai_sdk`）硬编码在桌面端。虽然 `packages/core` 本身零 IO 零 UI，但桌面端越过了 sidecar 的抽象边界直接消费领域事件。

### 2. 当前 Runtime 属于 Prototype、MVP 还是 Production-ready？
**Prototype。** 关键缺失包括：正式的 Run/Turn 状态机、事件序列号和去重、SSE 断线恢复、工具超时、Context Window 管理、优雅取消的竞态处理。更根本的是，workspace-write 路径完全依赖外部 Codex CLI 进程。

### 3. 当前最优先的三个 P0
1. **CODEX-001**：移除 Codex CLI 依赖，将 `NativeAgentRuntime` 扩展为唯一 Runtime
2. **CPL-001 + CPL-002**：桌面端 SSE 协议解析和事件分支逻辑提取到 transport 层
3. **STATE-001 + PROTO-001**：实现 Run/Turn 状态机和增强事件协议（runId/turnId/sequence/timestamp）

### 4. 第一阶段最小可交付范围
- 单 Agent 工作流：read-only + workspace-write
- 基于 `NativeAgentRuntime` + Vercel AI SDK + ToolExecutor 的纯 Socrates Runtime
- Run/Turn 状态机
- 增强事件协议
- 桌面端 transport 解耦
- 取消/重试/审批
- 现有的 Provider 管理、Agent 配置、Session/历史回放保持不变

### 5. 哪些现有代码应该保留
- `packages/core/` 全部类型定义（`runtime.ts`、`tools.ts`、`approvals.ts`、`events.ts`、`message-parts.ts` 等）
- `apps/sidecar/src/runtime/native-agent-runtime.ts` — 核心 Runtime
- `apps/sidecar/src/runtime/single-agent-runner.ts` — Runner 框架（需重构）
- `apps/sidecar/src/runtime/runtime-manager.ts` — Runtime 注册管理
- `apps/sidecar/src/tools/` — Tool Registry + Executor + Builtins
- `apps/sidecar/src/approvals/` — Approval Manager
- `apps/sidecar/src/store/` — Event Store + Session Store + Migrations
- `apps/sidecar/src/services/` — Context Compaction + Usage Collector
- `apps/desktop/src/` — UI 组件大部分保留，store 需拆分

### 6. 哪些代码只应移动或拆分
- `apps/desktop/src/store.ts` → 拆分为 `transport.ts` + `agentStore.ts` + `roomStore.ts` + `providerStore.ts`
- `apps/sidecar/src/index.ts` 中的 Runtime 注册逻辑 → 提取到 `runtime/bootstrap.ts`

### 7. 哪些代码必须重写
- `apps/sidecar/src/runtime/codex/*` → **移除**
- `apps/sidecar/src/runtime/child-supervisor.ts` → **移除**
- `apps/sidecar/src/runtime/single-agent-runner.ts` → 状态机部分重写
- `apps/sidecar/src/routes/agent-runs.ts` → 移除 Codex 默认值

### 8. 哪些 Multi-Agent 功能必须暂时冻结
- Manager–Worker 调度
- 子 Agent spawn / Agent mailbox
- 共享黑板
- 新 Debate/Round Robin 功能
- Agent Graph Scheduler
- 长期记忆 / 远程执行

**现有 Round Robin 和 Debate 功能保留不动，但不再扩展。** 新的 Multi-Agent 工作流将在 Phase 2 基于重构后的单 Agent Runtime 构建。

---

## 附录 A：测试执行结果

```
bun test:        313 pass, 0 fail, 955 expect() calls (80 files, 1.4s)
bun run typecheck: 通过（无错误输出）
bun run --cwd apps/desktop build: 通过（构建成功，545KB JS + 43KB CSS）
```

## 附录 B：工作区状态

```
branch:  main
HEAD:    7c69d17 Merge pull request #73 from Haosen-Zhang/fix/codex-version-compat
status:  clean (仅 .reasonix/ 未跟踪)
```

## 附录 C：Codex CLI 依赖完整证据链

| # | 文件:行号 | 证据 |
|---|---|---|
| 1 | `child-supervisor.ts:24` | `CODEX_HOME` 在允许的 env 列表中 |
| 2 | `child-supervisor.ts:53` | `spawn(executable, args)` — 启动 codex 子进程 |
| 3 | `binary.ts:3` | 硬编码路径 `/Applications/ChatGPT.app/Contents/Resources/codex` |
| 4 | `binary.ts:6-14` | `configuredCodexBinary()` 查找逻辑 |
| 5 | `protocol-client.ts:1` | `import { execFile } from "node:child_process"` |
| 6 | `protocol-client.ts:24` | `execFileAsync(binaryPath, ["--version"])` — 检查版本 |
| 7 | `protocol-client.ts:39` | `new JsonlChildSupervisor([binaryPath, "app-server", "--stdio"])` |
| 8 | `codex-runtime.ts:44-45` | `class CodexRuntime implements AgentRuntime { kind = "codex_app_server" }` |
| 9 | `index.ts:87` | `runtimes.register("codex_app_server", ...)` |
| 10 | `agent-runs.ts:14` | `const runtimeKind = ... \|\| "codex_app_server"` — 默认值 |
| 11 | `store.ts:596` | `sandbox === "read-only" ? "native_ai_sdk" : "codex_app_server"` |
| 12 | `ChatPage.tsx:688` | UI 文案 `"runtime_codex_experimental"` |

---

> **报告完成。等待人工批准实施计划。**
> 根据审查要求，本报告未修改任何应用代码。
