# P08 实际复用调用链核验

基线：main b7ef93c，2026-11-11。本轮不添加依赖，不复制上游源码。

| 能力 | 实际生产链 | 本轮证据 |
|---|---|---|
| 价格数据 data_reuse | costRoutes `/prices/import` → PricingStore.importBundledModelsDev → SHA256 校验的冻结目录 → 持久快照 → ModelInvocationBroker.resolveAutomatic → CostLedger | `routes/cost.test.ts` 新用例从真实 HTTP 导入经确认的连接映射，实际命令调用采用目录快照；用户覆盖只影响新调用，旧快照保持；未知目录模型拒绝 |
| LangGraph adapter | RoomCommandService → AdaptiveWorkflowService → StateGraph.compile(BunSqliteCheckpointSaver) → 原 Native/Team hosts | adaptive-workflow/hosts/restart 测试及 P08 集成链；未注册原型 LangGraphAgentRuntime 作为第二工具循环 |
| OTel direct_dependency | `/flight-recorder` → FlightRecorderService → BasicTracerProvider/SimpleSpanProcessor | 真 SDK 内存 exporter/父子 span；新增 exporter 返回失败时本地持久记录和诊断仍可读。生产未提供 exporter，不默认外传 |
| promptfoo adapter | 可选 scripts/reuse arena → evaluate → ArenaTaskProvider → RoomCommandService → Native工具 → VerificationService/CostLedger | 本轮实际 evaluate 1 success/0 failures、2 Native 请求；全局网络禁用、临时配置与数据库；不是裸模型测试 |
| SQLite FTS5 / Zod | ProjectMemoryService 项目过滤检索/导入校验 → 冻结 manifest → Broker → Gateway/Native | 项目记忆单测/实际载荷测试、P08 跨阶段 memory→执行→记录及真实 UI |
| 路径、审批、lease | ToolExecutor/SupervisedCommandRunner/WorkspacePathPolicy 继续覆盖原执行与独立验收；Arena 额外保护定义与外部副作用 | verifier、arena-boundary/command-boundary、artifact apply 等实际 macOS/临时文件测试 |

精确版本/许可证沿用 P00–P07 已记录的本机源码审查：OTel SDK 2.6.0 Apache-2.0，promptfoo 0.125.1 MIT，LangGraph 的已锁定包及自有 Bun 存储 adapter；见 cost-aware-reuse.md、各阶段文档与锁文件。此处没有重新宣称最新上游版本。

自动价格参考与 models.dev 手动导入是不同路径；代理连接需要显式映射确认，预设估计不是目录已验证价格。真实 API 价格、供应商账单和模型效果没有在本轮测量。远程 Langfuse 配置、深度原文捕获、语义冲突检测未启用，不作为交付功能。
