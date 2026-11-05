# Chat / Work 与持久成员协作验收

日期：2026-11-05（Asia/Singapore）。基线：最新远端 main `e13de16`；实现分支 `codex/chat-work-member-collaboration`。用户已有 `.reasonix/desktop-topic-auto-title-meta.json` 修改保持原样。本次未打开、迁移真实用户数据库，未使用真实 Provider 凭证。

## 实现契约

- 产品入口为 Chat / Work，内部继续使用 `chat` / `cowork`。新房间共用 sessions；legacy rooms 历史保持可访问。Chat 创建、工作区绑定、命令意图和 Native factory 都落实无本地工具边界。
- 人数、默认成员、显式 strategy、单轮目标彼此独立。第二位成员不会自动启用团队协作。新建房间默认 single；移除到一人会规范化非法团队配置。
- 全局 AgentDefinition 是模板，session_agents 是成员快照，RunProfile 是冻结执行配置。模板修改/删除不更改已有房间。`PUT /sessions/:id/agents/:agentId/template` 仅在空闲时显式应用更新。消息 authorSnapshot 根据 direct turn / team profile / discussion command 解析，防止模板更新改写历史模型标签。
- `POST /room-commands` 接受 `{roomId,clientRequestId,content,intent,mentions,attachmentIds?,workspaceRefIds?}`。mentions 只接受 composer 选择的 agent/all/file 稳定身份；服务端不解析正文中的 @。
- 无目标使用默认成员；单目标 direct 不修改默认成员；Chat 多目标/全体为有界讨论。Work/team 的明确命名目标交给 Manager；`@all` 为意见征询。讨论遵循轮数、顺序与选定总结者，独立记录作者和用量。
- 同请求重复提交重放相同命令，内容冲突拒绝；同房间启动预留防止不同请求 ID 并发穿透。命令、用户消息和真实子运行分层持久化；失联启动从稳定 turn key 或 team config 重新关联。无法证明已启动的命令标记中断，不盲目重放。
- 文件与目录 mention 按 workspace 校验。文件冻结内容，目录冻结至多 500 条目录项，不递归读取。讨论/Manager 的文件上下文作为不可信数据，Native 继续使用附件快照和既有路径/恢复机制。
- Manager 产出可检查的 StructuredPlan.workPackages；分配只能引用房间内可执行成员。用户可调整 owner，调整产生新计划版本/哈希，旧批准失效。未知价格和能力保持未知。
- WorkPackage 持久保存任务、目标、输入、依赖、owner/reviewer、预期文件、验收标准、状态、attempt/run、结果和失败原因。每个 child 复用 RuntimeManager / Native / ToolExecutor / 权限 / 审批 / 事件，无额外 Shell 路径。
- 第一版串行调度工作包，所有 direct、定向、package 和旧 ExecutionRunner 共用 WorkspaceLeaseManager 队列。child 拥有写租约，父团队不重复持锁；队列可取消，重启回收已终止 owner 的旧租约。
- 正常完成、失败、取消与预算中断分开。Native 最后一步仍有工具活动时发出 budget_exhausted；direct 为 interrupted，可同一 Turn 继续；package 为 budget_stopped，父任务 paused。继续保留原用户消息、配置和已持久工具事实。
- 无法解析的 Reviewer 输出不会批准；工作包最多自动返工一次。审核失败重试只重跑审核。失败/预算停止阻塞依赖；重试保留已完成工作包。团队停止取消排队并中断实际 child；恢复先对账持久终态，再对未知副作用要求确认。
- 产物汇总取实际成功 workspace_write 工具输出并关联 operation/run；预期文件不会被宣称为已产出。汇总列出完成、未完成、结果与审核记录，不声称自动证明所有验收标准。

## 验证证据

| 范围 | 可复跑证据 |
| --- | --- |
| Chat 边界、角色快照与显式刷新 | `routes/chat-sessions.test.ts`、`store/session-store.test.ts` |
| 结构化路由、@all、多目标与默认成员稳定 | `packages/core/src/room-command.test.ts` |
| 幂等、同房并发、讨论顺序/总结、公共作者 | `services/room-command-service.test.ts` |
| 真实 Supervisor/成员运行与历史模型标签 | `services/room-command-native.test.ts` |
| SSE Hono 字段顺序、重放与分块 | `packages/core/src/chat.test.ts`、desktop transport/protocol tests |
| 冻结配置、实际请求参数、预算继续、写队列 | runtime Native/SingleAgent/ExecutionRunner、run-profile、leases tests |
| 两成员实际写文件、审批、预算停止、重建与不重复写入 | `multi-agent/team-native-integration.test.ts` |
| 依赖、审核/返工、取消、部分失败、恢复终态 | team-runner / work-package-store / multi-agent routes tests |
| 旧库升级与 ID/消息/审批/快照保留 | migrations tests，含 `021_team_work_packages.test.ts` |
| 房间草稿/迟到响应/审批隔离和历史作者 | desktop roomStoreIsolation / roomNavigation / SessionMessageAuthor tests |
| 浏览器交互 | `output/playwright/ui-checks.json`：10 项；`team-checks.json`：2 项；均零 pageerror |

浏览器检查使用 `apps/sidecar/scripts/chat-work-preview.ts` 的内存 SQLite、模拟模型和 `/tmp` 工作区；生产路由、前端、协调器和成员执行路径真实运行。截图：`chat-directed.png`、`inline-role-room.png`、`team-plan.png`、`team-completed.png`。

原生集成场景只模拟模型流，文件写入、精确工具审批、SQLite、Native Runtime、ToolExecutor 和租约都是真实现。第二位成员写入后预算停止；重建调度器并继续后，两文件仍正确，总写入仅两次，用户消息一次，租约释放。

## 门禁与边界

执行 `bun test`、`bun run typecheck`、`bun run --cwd apps/desktop build`；最终宿主完整测试为 828 pass / 0 fail（153 files）；类型检查和桌面构建通过，修改文件的针对性 lint 通过。嵌套沙箱内普通测试跳过的 4 项 macOS 命令验证，已在真实 macOS 宿主的完整测试中执行通过。构建保留现有 Vite 体积和动态导入警告。

未做真实供应商 API、原生 Tauri 窗口/中文输入法真机播放、安装包与跨平台验证。Provider 参数传递已在模拟 AI SDK 流验证；未知模型的能力/温度组合由 Provider 明确报错，不猜测兼容性。现有全局 runtime capability 仍只开放人工计划确认，复杂 supervision、debate、LangGraph 生产编排、远程执行和 worktree 并行属于后续。

实现与验收保留在独立功能分支，按仓库流程通过 PR 审阅；main 未被直接修改。

浏览器复跑（在仓库根目录执行；需要已安装 Chrome、本地 45327/45328 两端口空闲，仅使用模拟环境）：

```bash
bun apps/sidecar/scripts/chat-work-preview.ts
bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45328
# 在另一个终端；默认导入已安装的 playwright，也可明确指定模块：
# export SOCRATES_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs
node output/playwright/validate.mjs
node output/playwright/team.mjs
```

其中 team 脚本需要 Work one 处于 single 策略；重复运行前重启模拟服务可恢复初始内存数据。所有真实数据、Keychain 和账号均不会被该服务使用。

运行记录：一次并发沙箱测试碰到既有命令测试 `stops background mutations before returning a normally exited leader’s result` 的 100 ms 限时；专项复跑和后续两轮宿主完整测试均通过。没有为此放宽超时或改变进程终止语义。
