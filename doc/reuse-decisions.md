# M00 源码、许可证与复用决定

日期：2026-11-07。范围：`RUN_SCOPE=M00-M01`。本文件是当前分支的源码审计与选择依据；产品领域关系和 M01 接线见 [work-foundation-plan.md](work-foundation-plan.md)。尚未实施 M02–M07 的业务能力不得因本文件中出现名称而被视为完成。

## 1. 已核对的版本与证据边界

| 仓库/项目 | 实际版本 | 核对方法与结果 |
| --- | --- | --- |
| Socrates | `b71a8265b9e296947c1f5ef7879f08feca899852`，分支 `codex/multica-ux-m00-m01` 的起点 | 读本地 AGENTS.md、architecture、Native roadmap、实际 TS 源码；起点工作区干净。 |
| Multica 参考快照 | [`a9434451e1c7c5a72798e0b65fdfb769a9249dab`](https://github.com/multica-ai/multica/commit/a9434451e1c7c5a72798e0b65fdfb769a9249dab) | 官方 GitHub API 按完整 SHA 读取，34 个文本 blob 全部与该提交 tree 的 blob SHA 一致；无上游依赖安装或运行。 |
| Multica 当前 main | [`4239ec11eaa67541c28bb20e836768263e363286`](https://github.com/multica-ai/multica/commit/4239ec11eaa67541c28bb20e836768263e363286)，提交时间 2026-11-07T10:35:15Z | 在执行时读取 `branches/main`，并与临时 shallow clone HEAD 一致；这只代表本次观测时点。 |
| Multica LICENSE/README 漂移 | 两版本的 blob SHA 相同 | LICENSE=`9286fa5f8ecaf1132ed9c01ff52a262309c608aa`；README=`ab6a403f87124591cb29b4bf1ccd2e213ecc0b6d`。 |
| Multica AGENTS 漂移 | pinned=`515799d15cc46810f290f63cb24b885e48315297`；main=`c0df9bdf790723ad47e8411420948364c4754a84` | 当前版增加跨 workspace DB 测试断言约束和 PR 描述/截图要求；产品源码结论仍以 pinned 为准。 |

完整路径、blob SHA 和图片元数据见 [source-audit.json](assets/work-foundation/source-audit.json)。官方文件内容留在远端读取结果与临时只读参考目录，未放入 Socrates 源码树。临时目录为 `/private/tmp/socrates-multica-source-audit`，没有在其中启动 Multica、数据库或 coding-agent CLI。

Socrates 起点没有根目录 LICENSE/NOTICE，也没有在根、core、desktop、sidecar package.json 中声明 license 字段；tracked 文件中只有模型价格 fixture 和 DeepSeek Harness 的局部许可证。这不影响本仓库内部复用现有模块，但不能将其据此描述成已选择某种对外分发许可证。本轮没有擅自为 Socrates 加许可证。

Multica 的 [README](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/README.md) 和 [AGENTS](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/AGENTS.md) 确认其共享 views→core+ui、TanStack Query 服务端数据、Zustand 客户端偏好、Go/Chi/sqlc/WebSocket/PostgreSQL 与 daemon/CLI 架构。Socrates 继续采用 Tauri/React/Zustand、Bun/Hono/SQLite、Provider key 与自有 Native runtime；不照搬 Multica 的服务端状态或 desktop 路由。

## 2. 许可前置结果：Multica 默认仅作参考

已完整读取 pinned 的 [LICENSE](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/LICENSE)（Part I、Part II 及附录）与 [NOTICE](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/NOTICE)，并比较当前 main 同名 blob。以下是条款事实摘要，不是法律意见：

- Part I 和 Apache-2.0 全文组成单一 Multica License；发生冲突时 Part I 优先，重分发要求交付完整文件。
- 未另获商业许可，条款限制向组织外第三方提供托管服务（包括免费服务），也限制把 Multica 嵌入向第三方商业分发的产品。组织内使用与仅发布 fork 源码另有明确说明。
- 派生 UI 的 Multica 名称、Logo、版权和署名受品牌条款约束；移动、改名或抽包不会自动脱离该 UI 定义。无 UI 的 backend/daemon/CLI 也有保留声明及用户文档署名要求。
- 商业许可与书面 branding waiver 是分别授予的权利；贡献被审阅或接受不代表获得这些授权。

执行决定：Multica 的页面、组件、样式、图标、文案素材、运行协议文本与服务端代码，全部只读参考。没有证据表明 Socrates 已获适用商业许可或品牌豁免，因此本轮没有任何 `adapt_with_permission` 的获准内容。单独开源库从其原维护者发布包直接安装，遵循该包自己的许可证；不通过 `@multica/ui` 转存。

决策值定义：

| 值 | 本轮含义 |
| --- | --- |
| `reuse_existing` | 复用 Socrates 已存在的模块及数据权威。 |
| `adopt_independent_library` | 直接采用独立维护、已核对版本及许可证的发布包。 |
| `adapt_with_permission` | 只有已取得明确适用授权后才可考虑的上游代码改编；本轮数量为零。 |
| `reimplement_product_specific` | 从行为需求出发，在 Socrates 原有 seam 上独立编写产品绑定。 |
| `defer` | 需求不在 M00–M01、收益不足或验证未完成，本轮不引入。 |

## 3. 指定参考路径逐项阅读结果

以下路径均固定到 `a9434451e1c7c5a72798e0b65fdfb769a9249dab`，未将 main 链接作为快照证据。所有 Multica 项的观察许可证都是完整 Multica License，而非某个独立 MIT 组件。

| 原始路径与固定链接 | 已读到的实际机制 | 适配成本 / 决定 |
| --- | --- | --- |
| [`apps/docs/content/docs/squads.zh.mdx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/content/docs/squads.zh.mdx) | 长期 Squad、Leader/成员/职责、Leader 私有 instructions、派活和成员结果再唤醒。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`apps/docs/content/docs/assigning-issues.zh.mdx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/content/docs/assigning-issues.zh.mdx) | 长期负责人和单次运行分开；确认分配或仅保存；backlog 停放；改负责人不隐式停止旧 Run。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`apps/docs/content/docs/mentioning-agents.zh.mdx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/content/docs/mentioning-agents.zh.mdx) | 结构化 mention 临时触发；明确提及优先；忙碌时 steer/排队/重启的区别。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`apps/docs/content/docs/tasks.zh.mdx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/content/docs/tasks.zh.mdx) | Issue 保存任务目标；AgentTask 是一次运行；重试保留记录；Run completed 不等于任务验收。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/views/squads/components/squad-detail-page.tsx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/squads/components/squad-detail-page.tsx) | ObjectPage + 属性栏 + 成员职责/状态/活动任务 + instructions + recent issues；服务端管理权限控制编辑。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/views/modals/create-squad.tsx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/modals/create-squad.tsx) | 名称+Leader 创建；Leader 从额外成员选择中移除；成员追加失败逐项提示，创建并非一个跨调用事务。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/views/squads/components/squads-page.tsx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/squads/components/squads-page.tsx) | workspace 查询、mine/all 范围、过滤/排序/列偏好、头像/Leader/成员单元格、归档确认。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/views/issues/components/pickers/assignee-picker.tsx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/issues/components/pickers/assignee-picker.tsx) | member/agent/squad 多态负责人；按频次排序；权限及 runtime-bound 禁用理由；延迟挂载减少订阅。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/core/types/squad.ts`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/core/types/squad.ts) | Squad、成员、角色、evaluation、member status 协议；没有 Socrates Room/Provider/审批语义。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/core/agents/derive-presence.ts`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/core/agents/derive-presence.ts) | runtime 可达性与 running/queued workload 分别派生；归档优先；终态不计入当前工作量。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/core/agents/use-agent-presence.ts`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/core/agents/use-agent-presence.ts) | workspace 一次合并 Agent/runtime/task snapshot，Map O(1) 行读取，30秒时间衰减；查询失败降级。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/views/issues/components/issue-run-timeline.ts`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/issues/components/issue-run-timeline.ts) | 从 AgentTask 派生时段、成本、token、累计和按 Agent/model 汇总；依赖上游估价工具。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |
| [`packages/views/issues/components/issue-runs-dialog.tsx`](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/issues/components/issue-runs-dialog.tsx) | 按次/累计视图、分组列表、重试/转 transcript；custom-pricing store 变更触发重算。 | 高：类型、API、权限和 UI 体系不同；`reimplement_product_specific`，只参考行为。 |

图片 [tutorial-squad-detail.webp](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/public/images/docs/tutorial-squad-detail.webp)、[tutorial-squad-dispatch.webp](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/public/images/docs/tutorial-squad-dispatch.webp)、[task-transcript.webp](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/apps/docs/public/images/docs/task-transcript.webp) 已在临时 clone 中目视阅读；三个图片 blob 与 pinned tree 相同。它们仅帮助确认身份/成员区、长期负责人、执行日志与工具 transcript 的信息层次；没有复制、裁切或改造成 Socrates 产品素材。

### 页面依赖链

`SquadDetailPage` 并不是一个只有 props 的独立组件。它依赖 `@multica/core/api`、auth、workspace paths/id、modal store、Query keys、issue statuses、快捷键和 i18n，再依赖 `@multica/ui` 的 ObjectPage 组合、图标、Popover/Dialog/AlertDialog、编辑器、ActorAvatar 与 sonner。Create/List/Assignee 同样依赖多态 actor、workspace 成员权限、Query 缓存和导航 adapter。相关 [UI manifest](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/ui/package.json) 只给出 `@base-ui/react ^1.3.0`、`cmdk ^1.1.1`、`react-resizable-panels ^4.7.5` 等版本范围，不能当成 Socrates 这次安装版本，也不能说明 `@multica/ui` 包可直接抽取。

Presence 的纯函数仍依赖 Multica Agent/AgentRuntime/AgentTask 与 runtime health；workspace hook 进一步依赖三组 Query hooks。Timeline 的纯数据函数又依赖 Multica 任务模型、运行时间工具和估价函数，UI 依赖 custom pricing store 与 transcript/retry 组件。分别抽走这些函数仍会引入产品语义、许可和状态权威成本，不采用。

## 4. 实际后端追踪：选择 → Leader → 执行 → 活动/运行记录

1. [AssigneePicker](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/issues/components/pickers/assignee-picker.tsx#L353) 只产生 `assignee_type=squad` 和稳定 ID；独立 [run-confirm gate](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/issues/actions/run-confirm-gate.ts#L72) 判断是否需要确认，[RunConfirmModal](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/views/modals/run-confirm.tsx#L141) 的“暂不开始”在写入载荷加 `suppress_run`。它没有同时执行所有成员。
2. [API client](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/core/api/client.ts#L1609) 的 updateIssue 写入服务端，[router](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/cmd/server/router.go#L2116) 将 `PUT /api/issues/{id}` 交给 UpdateIssue；Squad CRUD 是同文件 2254 起的 `/api/squads` 路由，Leader evaluation 是 2270 的 `POST /api/issues/{id}/squad-evaluated`。
3. [UpdateIssue](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/issue.go#L4161) 调用共享 [IssueService.WillEnqueueRun](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/service/issue_trigger.go#L106)，在服务端依据当前状态、负责人变化、backlog、实际 Leader readiness 与 pending 判定；随后 `!req.SuppressRun` 约束副作用。负责人写入与启动执行是两个动作。改负责人或状态通常不会取消既有 Run；代码有单独的 workflow 停前任选项。
4. [dispatchIssueRun](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/issue_trigger.go#L85) 的 squad 分支调用 [enqueueSquadLeaderTask](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/squad.go#L1189)，先校验归属 workspace、可调用 Leader 权限和 pending 去重，再调用 [EnqueueTaskForSquadLeaderWithHandoff](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/service/task.go#L1456)。
5. [enqueueMentionTaskWithCommentPlan](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/service/task.go#L1464) 实际创建 AgentTaskQueue 行（1497），只写入 Leader 的 agent_id/runtime_id，同时保留 squad_id、is_leader_task、issue、触发评论/人类归责等；1542 发布 task:queued，再通知 queue。该行就是一次 Run，不是 Squad 本体。
6. [daemon claim/start/message 路由](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/cmd/server/router.go#L1642) 由绑定 runtime 领取；[buildClaimedTaskResponse](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/daemon.go#L3217) 只在任务带 Leader 标记且当前 Leader 匹配时附加 [briefing](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/squad_briefing.go#L253)。briefing 包含协议、去归档花名册/mention ID 和 Squad instructions；父任务状态权由“该任务确实分配给此 Squad”单独判断，guest @Squad 不获得状态所有权。
7. daemon [handleTask/runTask](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/daemon/daemon.go#L5684) → 运行环境准备 → StartTask → [executeAndDrain](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/daemon/daemon.go#L9742) 的 `backend.Execute`，真正启动 coding-agent backend。它与 Socrates Provider key 驱动的 Native runtime 不同。
8. daemon 的 [ReportTaskMessages](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/daemon/daemon.go#L9936) 批次汇报，经 [client](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/daemon/client.go#L628) 到 handler；[handler](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/daemon.go#L5891) 先按序落库，再发布 task:message。complete/fail/usage 同样有真实服务路由和持久化路径；[TaskService](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/service/task.go#L7565) 经 Bus 发布生命周期事件。
9. Leader 派活评论经过 [computeCommentAgentTriggers](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/comment.go#L2666) 解析结构化 mention，显式目标在前，普通文本不产生 UUID 目标；Agent 结果与 assigned/guest Leader 回调有独立路由与 pending 合并。Leader 的 [evaluation handler](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/server/internal/handler/squad.go#L976) 写 activity 并发布 activity:created。前端 [realtime sync](https://github.com/multica-ai/multica/blob/a9434451e1c7c5a72798e0b65fdfb769a9249dab/packages/core/realtime/use-realtime-sync.ts#L990) 刷新 task snapshot、issue task/usage 与 Squad member-status，避免 task:message 每条都触发全局 presence refetch；运行记录视图消费该读模型。

这里只确认静态源码链路；没有启动 Multica 后端、真实 daemon 或付费 Agent 进行端到端执行。

## 5. Socrates 现有权威与可复用模块

以下引用固定到本轮起点 `b71a8265b9e296947c1f5ef7879f08feca899852`；“当前仓库内部代码”不是对外许可证声明。成本是本轮适配相对工作量，不是工时承诺。

| 能力 | 已存在的原始路径 | 当前已提供 | 采用边界 | 成本 / 决定 |
| --- | --- | --- | --- | --- |
| RoomComposer + roomNavigation + composerIme | [`apps/desktop/src/RoomComposer.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/RoomComposer.tsx) | 已有结构化 mention、房间草稿、IME 保护、文件引用与报价绑定。 | 保留发送、草稿、报价权威；新 Picker 接选项，不替换命令输入。 | 低 / `reuse_existing` |
| RoomTimeline | [`apps/desktop/src/RoomTimeline.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/RoomTimeline.tsx) | 按 roomId 记忆滚动位置，用户已在底部时才追随新增内容。 | 对象详情使用本地滚动容器；Room 历史继续走已有容器。 | 低 / `reuse_existing` |
| TeamTaskPanel | [`apps/desktop/src/TeamTaskPanel.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/TeamTaskPanel.tsx) | 当前工作包负责人、审核者、依赖、尝试次数、未知结果确认与重试。 | Task 详情投影现有 workPackages；Picker 只改已有 assignWorkPackage 调用。 | 低 / `reuse_existing` |
| AgentAvatar / AgentEditor | [`apps/desktop/src/AgentAvatar.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/AgentAvatar.tsx) | 已有角色头像与独立角色模板编辑入口。 | 保持持久 Agent 身份及原角色系统；不把 Squad 当 Agent 模板。 | 低 / `reuse_existing` |
| WorkspaceDock + 已装 react-virtual | [`apps/desktop/src/workspace/WorkspaceDock.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/workspace/WorkspaceDock.tsx) | 已有 workspace 文件树和 useVirtualizer；react-virtual=3.14.9，包声明 MIT。 | 沿用 workspace 文档/引用；仅数据量需要时用既有虚拟化。 | 低 / `reuse_existing` |
| PanelResizeHandle + panelResize | [`apps/desktop/src/layout/PanelResizeHandle.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/layout/PanelResizeHandle.tsx) | pointer capture、RAF 调整、separator ARIA、键盘 resize、commit 回调。 | 现有左右栏尺寸与 config 持久化继续用；不引第二套布局状态。 | 低 / `reuse_existing` |
| NestedDialogPortal + dialogLayer | [`apps/desktop/src/dialog/NestedDialogPortal.tsx`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/desktop/src/dialog/NestedDialogPortal.tsx) | 现有嵌套对话层有 Tab trapping、Escape、原焦点恢复。 | 保护旧路径；新基础 Dialog 采用独立 Base UI；不在本轮强制替换所有旧 Modal。 | 低 / `reuse_existing` |
| RoomCommandService + room-command | [`apps/sidecar/src/services/room-command-service.ts`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/sidecar/src/services/room-command-service.ts) | 输入 fingerprint、幂等 clientRequestId、服务端路由、成员快照与恢复。 | 后续 Task/Squad dispatch 绑定现有命令；保持普通 @ 文本无调度效果。 | 中 / `reuse_existing` |
| Coordinator / TeamRunner / WorkPackageStore | [`apps/sidecar/src/multi-agent/team-runner.ts`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/sidecar/src/multi-agent/team-runner.ts) | Manager 计划、批准版本检查、依赖调度、串行写租约、独立审核、持久 attempts。 | Squad 只是组织配置，不能新建与现有 TeamRunner 并行的执行所有者。 | 中 / `reuse_existing` |
| RunSupervisor / ExecutionRunner / Native runtime | [`apps/sidecar/src/runtime/run-supervisor.ts`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/sidecar/src/runtime/run-supervisor.ts) | 服务端持有 AbortController；Native seam 统一审批、工具与运行恢复。 | Run 的 UI 只投影现有运行记录，不借用 Multica CLI daemon。 | 中 / `reuse_existing` |
| EventStore / ExecutionEventStore / History / SSE | [`apps/sidecar/src/store/event-store.ts`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/sidecar/src/store/event-store.ts) | 持久序号、事件幂等与历史；运行事件和 task_events 各有当前所有者。 | ActivityTimeline 读取归一化投影，不给同一任务另存可写状态。 | 中 / `reuse_existing` |
| InvocationBroker / CostLedger / UsageCollector | [`apps/sidecar/src/services/model-invocation-broker.ts`](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/sidecar/src/services/model-invocation-broker.ts) | 逐调用账本、预算 admission/保留、价格快照与 Native/Gateway 共同 seam；旧 usage 按 attempts 聚合。 | 费用详情读取既有账本，unknown 保持 unknown；不引上游 estimateCost 或第二套 router。 | 中 / `reuse_existing` |

实际调用链已读：

`RoomComposer.submit` → `store.sendRoomCommand` → `POST /room-commands` → `RoomCommandService.submit/dispatch` → core `resolveRoomCommand`。直接运行进入 `RunSupervisor/SingleAgentRunner`；团队进入 `Coordinator.create/run`，用户批准版本后由 `TeamRunner` 调度已有 `WorkPackageStore`，再交 `ExecutionRunner` → `RuntimeManager(native_ai_sdk)` → `NativeAgentRuntime`。这是 [sidecar index.ts](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/apps/sidecar/src/index.ts) 的实际注入接线。

`EventStore(task_events)`、`ExecutionEventStore(runtime_events)`、HistoryStore 和 room-command SSE 供 store 中按房间的投影消费，ChatPage/RoomTimeline/TeamTaskPanel 使用这些状态。模型调用统一经过 `ModelInvocationBroker`（Native 和 Gateway 都已接入），它与 CostLedger/BudgetLedger/PricingStore 决定逐调用费用和预算；UsageCollector 保留历史 token 汇总，不能被新 UI 改造成第二费用账本。

core 的 `adaptive`、cost/balanced/quality 类型并不表示生产自动路由已开放：当前 [room-kind.ts](https://github.com/Haosen-Zhang/Socrates/blob/b71a8265b9e296947c1f5ef7879f08feca899852/packages/core/src/room-kind.ts) 明确支持 single/team、`routing:false`、`planConfirmation:[user]`。M00–M01 不重建或宣传尚未启用的 cost router。费用 P00–P08 的各项状态和后续接缝需保留原验收记录，不能仅因文件存在而宣称全部完成。

## 6. 独立第三方候选及取舍

来源是各包官方发布元数据/原始包 LICENSE，非 Multica 包。大小为 registry 的 **dist.unpackedSize**，不是打包后 JavaScript、gzip、磁盘增量或 Tauri 安装包增量。上游版本范围与下表本次精确候选版本分开记录。

| 候选 / 原始来源 | 独立许可、精确版本与大小 | API / Socrates 契合与依赖链 | 成本 / 决定 / PoC |
| --- | --- | --- | --- |
| [@base-ui/react 官方发布包](https://registry.npmjs.org/@base-ui/react/1.9.0)，原始路径 `package/LICENSE`、`package/combobox`、`package/dialog`、`package/tooltip` | MIT，1.9.0，10,377,319 bytes unpacked；已读安装包完整 LICENSE（Material-UI SAS）；peer React/DOM 17/18/19，适配当前 React 19。 | 无样式行为层，可继续使用 Socrates pixel 样式；ESM/CJS/subpath export、sideEffects=false。直接依赖 @babel/runtime、@base-ui/utils=0.5.0、@floating-ui/react-dom、@floating-ui/utils、use-sync-external-store。日期相关 peer 为可选，不为 Picker/Dialogue 安装。 | 中；`adopt_independent_library`。父任务已实际安装 1.9.0 并接入生产 ActorPicker/Dialog/Tooltip；build/render/keyboard 结果在文末续填，不能用安装成功替代。 |
| [cmdk 官方发布包](https://registry.npmjs.org/cmdk/1.1.1)，原始路径 `package/LICENSE`、`package/dist` | MIT，1.1.1，81,852 bytes unpacked；父任务已读原发布包完整 LICENSE。 | 适合全局命令菜单和过滤列表；React 18/19；带 @radix-ui/react-dialog、compose-refs、id、primitive、use-callback-ref 与 use-sync-external-store；会引入另一套 Dialog/焦点依赖。 | 中；`defer`。本轮 ActorPicker 的搜索/导航可由已采用 Base UI 覆盖，未装入产品、未做 render PoC；不是测试失败。 |
| [react-resizable-panels 官方发布包](https://registry.npmjs.org/react-resizable-panels/4.19.1)，原始路径 `package/LICENSE.md`、`package/dist` | MIT，4.19.1，2,026,821 bytes unpacked；父任务已读原发布包完整 LICENSE。 | React 18/19；无 runtime dependencies；Panel/Group/Separator 覆盖复杂嵌套尺寸布局，但本轮已有 PanelResizeHandle、键盘 resize、尺寸约束和 config 保存。 | 中；`defer`。没有必要同时保留两套 resize/持久化状态；未装入产品、未做 render PoC。 |
| 已装 [@tanstack/react-virtual](https://registry.npmjs.org/@tanstack/react-virtual/3.14.9) | MIT，3.14.9（已有锁定依赖） | 已在 WorkspaceDock 中实际使用；不为了 Squad 少量列表强制虚拟化。 | 低；`reuse_existing`，没有新增依赖。 |

`@dnd-kit`、sonner 和 TanStack Query 没有因参考仓库使用就自动加入。DnD 任务板、服务端缓存改造或新的全局 toast 依赖如无明确 M01 必要性则 `defer`；后续如采纳，需另记精确版本、LICENSE 与真实场景验证。现有 Zustand 服务端投影保持单一权威。

macOS/Tauri/Vite/Bun 的判断分层：peer/exports 与包内依赖审计支持“可尝试集成”；Socrates Vite build 与真实浏览器 render/keyboard 才能证明 Web UI 集成；仅这些仍不等于已验证 Tauri WKWebView、签名包或干净机器安装。

## 7. 产品差异和本轮执行约束

| Multica 行为/模型 | Socrates 对应边界 | 决定 |
| --- | --- | --- |
| 长期 Squad + Leader + 成员职责 | Squad 是后续组织配置；Room 仍承载 Chat/Work、成员快照、会话和 workspace；角色模板继续独立。 | M00 记录关系，M01 仅导航/基础展示；业务 CRUD 到 M02，`reimplement_product_specific`。 |
| polymorphic issue assignee + 单次 AgentTaskQueue | WorkItem 业务目标、Room 上下文与 Run/WorkPackage 尝试分层；不得给同一任务两份可写执行状态。 | 详细 ER/状态与迁移方案见 foundation plan；M00–M01 不新增可执行 Task 队列，`defer`。 |
| runtime heartbeat availability | Socrates 用 Provider/模型配置和 native runtime 就绪信号；运行中来自具体 Run，用户界面不得把“持久 Agent 存在”写成在线。 | 复用现有 run 状态；正式双维 presence 到 M04，`reimplement_product_specific`。 |
| guest @Squad / 评论唤醒 | 现有 structured RoomMention 只支持 agent/all/file；类型扩展、授权、去重与停止边界需由后端实现。 | M05 才实现新触发，不改普通文本语义，`defer`。 |
| 运行成本来自 usage 与估价 | Socrates 逐调用价格快照、预算 admission、unknown/outcome 与审核边界已存在。 | 读取原账本并保持币种及未知值，`reuse_existing`。 |
| daemon/CLI + Go/Postgres + Electron + 多用户 auth | 本地 Provider key + Native runtime + Bun/SQLite + Tauri；原审批、workspace lease、EventStore 继续生效。 | 不移植基础设施；本轮无新 daemon 或 CLI 前置，`defer`。 |

本轮源码与素材来源检查：没有 vendored Multica 文件、`@multica/*` 依赖或上游图片进入产品；所有新增 Socrates 组合组件和绑定逻辑独立编写。未访问或重置真实用户数据库、未调用付费模型、未推送或发布。

## 8. 独立组件 PoC 的最终验证

`@base-ui/react@1.9.0` 已在实际 React 19 / Vite / Bun 应用构建并用于生产业务入口：`foundation/ActorPicker.tsx` → `ChatPage.SessionMembersDialog`，以及 `foundation/overlays.tsx` → `WorkProjectHub` 与成员管理。Toast/Tooltip 也有实际调用。原始 MIT 许可与版权保留在 [第三方说明](third-party-ui-notices.md)。不是安装即完成，也没有复制 Multica wrapper。

最终实际 Chrome 检查 **65/65**：项目/任务流 29 项；成员/组件流 36 项。覆盖中文搜索、ArrowDown/Enter、IME、Tab/Shift+Tab、Escape、删除触发器后的焦点返回、嵌套 AgentEditor、窄屏抽屉、通知、三语言和亮/暗主题。两个流程 renderer/external requests 均为 0；相比夹具初始化后的调用计数，未增加 Native/Gateway 执行。完整证据与复现见 [验收报告](work-foundation-acceptance.md) 和 [实现进度](../implementation-progress.md)。

最终门禁：1016 项测试、类型检查、desktop build 与 lint 全部通过。生产构建 JS/CSS gzip 总量从同机冻结基线 575,438 bytes 到 649,945 bytes，整轮增量 74,507 bytes（72.76 KiB）；这不是单个库或安装包的体积。详见 [比较 JSON](assets/work-foundation/bundle-comparison.json)。
