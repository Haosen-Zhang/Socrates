# UI 性能审计（P0 基线与修复记录）

分支 `perf/p0-ui-stabilization`，基于 `e260a02`（= origin/main，PR #62 后）。本文档记录修复前基线、已确认根因（file:line）、修复映射与复验方式。

## 1. 修复前基线（2026-07-16 实测）

| 检查 | 命令 | 结果 |
| --- | --- | --- |
| 单测 | `bun test` | **219 pass / 0 fail**（70 文件，731 断言，1.35s） |
| 类型 | `bun run typecheck` (`tsc -p .`) | exit=0 |
| lint | `bun run lint` (biome) | 174 文件 0 问题 |
| 构建 | `bun run --cwd apps/desktop build` | ✓（chunk 大小警告，非阻塞） |

### Profiler 限制与手动步骤

本环境无法驱动 React DevTools / Chrome Performance 面板（无头 CLI）。替代证据：代码级订阅追踪测试（§3）+ 渲染成本静态分析（§2）。**手动 profiling 复现步骤**（留给真机验证）：

1. `bun run dev` 启动，打开 WebView DevTools（tauri dev 右键 → Inspect）。
2. Performance 面板录制以下场景各 ≥30s：单 agent 流式输出；多 agent 讨论；长会话（>200 消息）滚动；输入框连续输入；快速切换房间 ×10。
3. React Profiler 记录同场景，按 "commits" 排序找最频繁重渲染组件。
4. Memory 面板：录制前后各一次 heap snapshot，对比 Detached 节点与 listener 数。
5. 期望（修复后）：流式期间仅消息区组件 commit；Settings/Providers/MCP 零 commit；单帧 ≤1 次 store flush。

## 2. 已确认结构性根因（修复前 file:line）

| # | 问题 | 证据 | 放大效应 |
| --- | --- | --- | --- |
| R1 | **24 处无 selector 的 `useStore()`** 全量解构，任何 store 字段变更重渲染全部订阅组件 | App.tsx / ChatPage.tsx(×10) / Settings.tsx(×3) / ProvidersPage / AgentsSection / WorkspaceChip / AttachmentTray / McpSettings | 未来多 Executor/usage/事件日志的每次更新都全局重渲染 |
| R2 | **单 agent 流式逐事件 setState**：每个 SSE 事件 `set({agentEvents:[...prev, e]})`（store.ts:629 区域），数组全量拷贝 O(n²)；UI 每渲染重算 `filter().map().join("")`（ChatPage.tsx:646 区域） | store.ts `sendAgentPrompt`；ChatPage agent 视图 | token 级全局更新 × 未来并行多流 |
| R3 | **多 agent 750ms 全量轮询**（ChatPage.tsx:806 `setInterval(750)` → `loadMultiTask` 重取全部 messages+turns），SSE delta 被丢弃 | ChatPage MultiAgentSession；store.sendMultiTask | 任务越长轮询负载越大；非实时 |
| R4 | **流式 Markdown 全量重解析**：StreamingBubble 对增长中全文每次 render 重跑 react-markdown（ChatPage.tsx:186）；历史 Bubble 无 memo（:157/:685/:825） | ChatPage.tsx | O(n²) 解析；长消息流式期间主线程长任务 |
| R5 | **消息/日志列表无虚拟化/窗口化**：三个视图全 `.map()` | ChatPage timeline/sessionMessages/multi turns | 长会话 DOM 无上界 |
| R6 | 次要：一次性 `setTimeout` 未在卸载时清理（ProvidersPage.tsx:95、ChatPage.tsx:106,:120 等 confirm 复位计时器） | 同左 | 卸载后 setState 警告风险 |

已良好、无需动的：群聊 delta 已 rAF 批处理（store.ts streamPost）；粒子有 120 上限+回收（fx.ts:55-101）；全局 listener 均有清理（App.tsx:49-54、GlobalFxLayer、ResizableComposer、AttachmentTray、WorkspaceChip）；AudioContext 模块级单例（预期内）。

## 3. 修复映射（证据 → 改法 → 验证）

| 根因 | 修复 | 验证 |
| --- | --- | --- |
| R1 | 新增 `apps/desktop/src/selectors.ts` 纯 selector 按域拆分；全部 24 处改 `useStore(useShallow(selectX))`；高频字段（streaming/agentEvents/multi turns）只允许消息区 selector 触达 | `selectors.test.ts`：Proxy 属性访问追踪证明 Settings/Providers/MCP/侧栏 selector 不触达任何高频字段；shallow 稳定性测试证明无关字段变更时输出 shallow-equal（=不重渲染） |
| R2 | `sendAgentPrompt` 引入事件分类 + rAF 批处理管线（复用群聊 streamPost 模式）：text/reasoning delta 累积进缓冲与 `agentStreamText` 字符串，控制事件（error/done/cancelled/approval/tool state）先 flush 缓冲再立即处理，保证顺序 | `agentStream.test.ts`：分类器单测（顺序、控制事件立即、最终文本完整） |
| R3 | SSE delta 直接增量进 store（同一批处理管线）；750ms 轮询降级为「无活跃流时」的 5s 兜底对账 | 代码路径 + 手动场景（§1 手动步骤 2） |
| R4 | 完成消息 `Bubble` 加 `React.memo`（按 id+content）；StreamingBubble 的 Markdown 源用 250ms 节流值（完成时立即最终解析，内容完整性不变） | `useThrottledValue` 单测 + 手动验证 |
| R5 | 三个列表窗口化：默认渲染最近 80 条 + 顶部「显示更早」展开（无新依赖，不动滚动行为） | 窗口化纯函数单测（边界/展开/完整性） |
| R6 | confirm 复位 timer 抽成 `useConfirmingFlag` hook，卸载时清理 | hook 逻辑单测 |

## 4. 修复后复验（完成后填写）

- [ ] `bun test` 全绿（含新增订阅边界/管线/窗口化测试）
- [ ] `tsc` / lint / build 绿
- [ ] 手动 profiling（§1 步骤）由用户在真机执行确认
