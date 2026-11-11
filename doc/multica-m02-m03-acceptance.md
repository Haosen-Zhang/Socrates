# M02–M03：Squad 与工作事项

## 基线与边界

实现起点：`26a4352`，已合并 M00–M01 和成本 P00–P08。原提示词的 Alpha.1 基线已过时：本轮直接复用已有报价、预算、验证、路由及运行记录，不重复实现。使用独立 `codex/multica-ux-m02-m03` 分支；原 checkout 和所有历史数据不用于测试。

M00 已确定：现有 `WorkActivityRecord` 只能投影运行，不能表示没有 Run 的 backlog、长期 owner、独立审核。因此 M03 需要最小持久工作事项，引用原命令/运行，不复制消息、工作包、工具结果或费用。Squad 只保存团队配置，工作区和执行权威仍属于原服务。

## 复用复核

本轮重新读取临时只读参考快照 `/private/tmp/socrates-multica-source-audit`（HEAD `4239ec11eaa67541c28bb20e836768263e363286`）的 LICENSE Part I、创建 Squad、Squad 类型、Leader 校验及分配启动门控源码。此前完整固定源码审计见 [M00 复用记录](reuse-decisions.md)。该快照不是本轮对上游最新版本的声明。

- Multica 仅作行为参考，没有复制组件、源码、样式或素材，也没有运行其服务。继续遵守提示词要求的许可边界。
- 已安装 `@base-ui/react` **1.9.0 / MIT**，本轮再次核对发布包 package.json/LICENSE。复用 Socrates `ActorPicker`、`DetailPanel`、`ConfirmationDialog`、`ObjectPage`，不重复安装 UI 库。无需看板拖拽、Query 缓存或第二套组件体系。
- 执行复用 `RoomCommandService` → `MultiAgentCoordinator` / `TeamRunner` / `RunSupervisor`，报价复用 `TaskQuoteService`，权限/费用/冻结配置/工作区租约保持原权威。
- 数据层沿用 Bun SQLite migrations、SessionStore 和既有外键/版本模式；可用性显示配置证据与不可用原因，不能把配置存在称为在线。
- UI 复用 AgentEditor、AgentAvatar、RoomTimeline 和 Work 页导航，新的代码仅负责 Squad/WorkItem 的领域关联及交互。

## 验收范围

M02：多 Provider 成员与职责持久化；Leader 自动入组与不可直接移除；模板并发版本；房间 A/B 冻结快照和显式更新；不可用成员原因；归档影响与历史保留。

M03：项目/消息创建任务；只分配零命令、零运行、零模型调用；启动重试幂等；Squad 仅 Leader 规划并复用工作包执行；运行中换 Owner 的明确处置；完成执行后进入审核而不自动 Done；列表/详情/房间刷新一致。

真实浏览器验证使用现有生产 UI、临时 SQLite/工作区、受控模型流。本轮已运行真实浏览器并保存检查记录；最终数量见后文。

## 有意不扩展的范围

Board 在 M03 为可选，先完成列表；M04 的完整生命周期、M05 提及/收件箱/Leader 再唤醒、M06 运行交互与 M07 完整压力验收留后续阶段。不会引入多用户账户、云服务或新执行引擎。


## 实际领域与启动边界

- `squad_templates` / `squad_members` / `squad_room_bindings`：项目范围、成员职责和 Leader。模板 `revision` 与房间 `bindingVersion` 是独立并发令牌；解除绑定后再次绑定也继续递增。修改绑定房间的成员/默认响应者/策略/工作区，需要先显式解除绑定。归档保留冻结引用，拒绝新的模板使用。
- `work_items`：只存目标、来源、长期 Owner、优先级和审核版本。`work_item_runs` 引用原命令/执行房间并冻结当时负责人；`work_item_reviews` 将人工判断绑定具体 Run。旧房间不自动转为 WorkItem。
- `work_item_previews`：明确点击预览时，冻结独立执行房间、原成员配置、工作区、工具审批与真实报价；尚未启动的房间不出现在房间列表。不创建命令/Run/模型请求。重复预览会保留本地记录，本轮未加入清理策略。
- 启动检查事项版本、原报价及工作区/审批策略，并按事项+请求 ID 去重。Squad 只让 Leader 首先规划，原工作包审批后才运行成员；没有第二套 Agent 循环。源房间配置不变。
- 后端重启自动关联已接受但未回写的命令；没有接受命令的预约安全释放，不自动补发模型请求。公开旧执行入口也不能直接启动预览房间。
- `in_progress` 从根命令的运行/等待/预算状态投影；根完成后进入 `in_review`。子工作包完成不会直接 Done，必须本机用户明确审核。换负责人保留旧 Run 的真实身份，停止后移交只取消选定当前根执行；预算暂停的 single/team 也可终止，终止后不能恢复旧 Run。
- 任务详情从原消息/工作包/产物/运行记录读取，不复制业务账本。来源消息或房间删除可清空来源链接；有关联执行历史的执行房间删除/回溯明确拒绝，防止破坏审计关系。

## 实际入口与 API

Work → Squads：创建/编辑/成员/职责/Leader/归档，创建绑定房间或显式应用版本，也可进入分配任务。Work → Tasks：创建事项、负责人选择、只分配、预览与分配并开始、人工审核、执行房间及原运行时间线。Work 消息操作条提供“创建工作事项”；执行房间上方链接同一事项状态。旧执行活动列表保留在“历史执行”。

`/squads` 提供 list/create、`/:id` detail/update、`/:id/impact`、`/:id/archive`、`/:id/rooms`、`/:id/bind`、`/rooms/:roomId/binding`、`/rooms/:roomId/detach`。

`/work-items` 提供 list/create、`/:id` detail、`/:id/assign`、`/:id/preview`、`/:id/start`、`/:id/review`。写操作使用 expectedRevision；start 使用固定 clientRequestId。同样的 POST 重试不会生成第二次执行。工具审批、计划审批、费用加额/恢复继续在原执行房间操作。

## 复验方法

```sh
bun test
bun run typecheck
bun run --cwd apps/desktop build
bun run lint
```

真实浏览器验收使用三个进程（仅本地 synthetic fixture）：

```sh
bun scripts/multica-m02-m03-browser-fixture.ts
bun run --cwd apps/desktop dev --host 127.0.0.1 --port 45368 --strictPort
SOCRATES_PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/multica-m02-m03-browser.mjs
```

可通过 `SOCRATES_MULTICA_METADATA` 和 `SOCRATES_MULTICA_UI_URL` 指定元数据文件与本地 UI 地址。fixture 退出会删除自己的临时数据库/工作区；不会读取正式数据库或 Keychain。检查记录及截图保存到 `output/playwright/multica-m02-m03/`。

没有进行付费模型、Tauri 原生窗口/真实输入法/屏幕阅读器或打包安装测试。浏览器验证的是生产 React UI 与实际 sidecar 服务，经受控模型 seam；不等价于上述未验环境。


## 最终验证结果

- `bun test`：**1261 pass / 0 fail / 23729 assertions / 218 files**。使用所需本机权限复验回环监听和 macOS 原生沙箱；未触及正式数据库。
- `bun run typecheck`、desktop build、lint（554 文件）、`git diff --check` 全部通过。Vite 原有大 chunk 警告仍存在，构建成功。
- Chrome 真实界面 **23/23** 检查通过，**0 renderer error / 0 external request**。包含保存/重开/归档、消息来源、只分配零调用、预览零调用、Leader 单次规划、人工审核、跨页面状态、停止移交、零预算暂停与暂停后移交，以及窄屏滚动。
- 两阶段审查与最终复审均通过。审查中修复独立绑定并发令牌、房间设置绕过、旧执行接口准入、崩溃关联恢复、预算暂停终止、工作区/审批快照失效；相关回归已纳入测试。

可机器读取的证据：[检查项](assets/multica-m02-m03/browser-checks.json)、[验证记录与截图 SHA-256](assets/multica-m02-m03/verification.json)。实际界面：[Squad 详情](assets/multica-m02-m03/squad-detail.png)、[启动预览](assets/multica-m02-m03/task-preview.png)、[移交后的历史身份](assets/multica-m02-m03/handoff-history.png)、[窄屏任务](assets/multica-m02-m03/task-narrow.png)。均为合成测试数据。
