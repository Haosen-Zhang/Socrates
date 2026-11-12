# M06–M07 implementation plan

## Global constraints

Preserve Chat/Work, user edits/history, Native Runtime and existing authority. Reuse existing services and licensed installed components, no Multica code/assets. Unified ledger, backend budget/routing/permission gates, real verification and authorized versioned memory only. Test temporary SQLite/workspaces and controlled providers, no paid models/private uploads. Complete stages sequentially with tests/typecheck/build/browser evidence and automatic feature PR; no merge/release.

## Task 1: M06 Cost and verification integration

## M06：与成本感知、Verified Work、项目记忆和 Flight Recorder 衔接

**目标：**兼容此前的“Economy / Balanced / Quality / Custom、Verified Work、Task Budget、Arena、Memory、Flight Recorder”，但本轮不重新制造这些基础功能。

### 工作项

1. 核对先前 P00—P08 实现状态，建立一张可追踪集成表：哪些能力已真正接通、哪些只是类型、哪些需要本轮预留 hook。
2. Work Item / Squad / Agent / Package / Run 的成本、使用量及报价从统一 Usage/Cost Ledger 查询，不能新开 Squad 专属计费系统。
3. Squads 使用已实现的路由策略输入；如果 `adaptive/routing:false`，不暴露为真正可操作选项。Cost-first 的 Leader 调度遵循此前预算与路由守卫，不自发启动所有成员讨论。
4. 预算不足时正确标识 `budget_stopped` / 等待确认；不能隐藏任务或将其标记为 completed。预算判定在后端模型调用入口，不在按钮 handler 里。
5. Verified Work 的检查证据可在任务详情看见，`agent says done`、`run completed`、`verification passed` 三者分开。证据失效（修改代码后旧测试结果失去对应版本）可触发重新审核。
6. Portable Project Memory 仅通过已授权、已版本化的项目约束入口注入 Squad leader 和 WorkPackages，不把外部评论/Agent 输出升级成系统指令。
7. Flight Recorder 中 Squad activity 以 `who/why/when/with which model/which evidence/what cost` 表示；Agent Arena 可以选择不同 Squad 模板作为方案，但不在无隔离工作区中并行比较文件修改。

### 验收

- 成本/预算未知时 UI 明确显示未知，不显示 $0.00 并误导。
- “经济优先”不会绕过质量验证、人工高风险审批和指定成员限制。
- 同一工具调用和同一模型 attempt 的 Usage 不会在 Agent、Squad、WorkItem、Project 汇总时重复计数。
- 同一次工作完成后能定位到验证证据和执行成本，文档说明未接入的成本策略/评估能力。

---

## Task 2: M07 Integration QA and delivery

## M07：全链路测试、性能、可访问性、兼容和交付

**目标：**把上述功能变成可用产品，而不是视觉演示。

### 工作项

1. 测试：领域契约、数据库迁移幂等、Squad 改成员/换 Leader/归档、WorkItem owner 与 Run 生命周期、触发预览与实际执行一致、重复提交去重、暂停/取消/重试、审核与预算状态。
2. 从真实 `RoomCommandService`、`TeamRunner`、`EventStore`、SQLite、Zustand 走集成测试，模拟 Provider 与网络的延迟/故障；避免仅测试复制实现的 mock reducers。
3. UI 验收：全新安装/已有 Alpha.1 数据、Chat 单成员/多成员、Work 单成员/团队、多个 Project/Room、窄窗口、中文输入法、长历史、截屏/主题、焦点与键盘操作。
4. 性能：几十个角色、十多个 Squad、至少一百个 WorkItem 与长时 Run 流；评估首屏、过滤、列表虚拟化和高频流事件不引起无关组件重渲染。
5. 数据迁移：升级后恢复旧房间、member snapshot、work package、审批、事件和回退；必要时给迁移前备份/失败恢复策略，不强制重建数据。
6. 更新中英文 README、变更日志和 Alpha 发行说明草稿；说明真正支持哪些功能、哪些依赖本地 Provider/工作区、哪些留待后续。README 截图必须来自真实 UI，不能把演示内容当成真实任务成功证明。
7. 做许可清单复查：没有不符合 Multica 自定义许可证条件的源代码/图标/品牌资产被搬进 Socrates；第三方许可证文件和 attribution 按实际使用生成。

### 必须跑的门禁（按仓库命令调整）

```bash
bun test
bun run typecheck
bun run --cwd apps/desktop build
```

按需加独立 UI 测试、Playwright、Tauri 宿主测试。macOS 专属工具在非 macOS 环境失败时单独报告，不为了全部绿灯而降低权限或删除相关测试；不要把旧验收文档的 pass 计为本轮结果。

### 最终交付格式

- 对应的 HEAD SHA 和修改路径、数据库迁移号。
- 复用清单：使用了哪些独立开源库及许可证；哪些已有 Socrates 组件复用；哪些是新业务代码；明确没有从 Multica 复制受限制源码。
- 每个用户流程的功能说明与真正接通的调用链。
- 每阶段测试命令、通过/失败/跳过结果、UI 截图，已验证的边界。
- 旧数据迁移与回滚方式。
- 当前保留的限制与后续工作，不能把尚未实现的 Provider/模型注入能力当成已支持。

---
