# P08 场景验收证据

本表针对 2026-11-11 的 `codex/cost-aware-p08` 工作区。所有模型响应均为受控替身，使用生产服务、真实 SQLite 和临时工作区；没有调用付费模型，也没有上传用户文件。API/服务测试不等于界面测试，实际产品界面证据由 implementation-progress.md 单独列出。

## 本轮新增集成证据

`apps/sidecar/src/services/p08-integration.test.ts`：

- **S12 完整链路**：真实 Manager 规划，低成本成员通过 Native `write_file` 写入不满足验收的结果，独立检查失败；升级先停在持久审批，批准前强成员没有请求。经实际 routing HTTP endpoint 确认后，强成员真实写入修复，独立检查通过。确认 memory 出现在实际 Native 请求与 manifest、原始失败证据保留、父任务下所有 invocation/price snapshot 可追踪、FlightRecorder 的 route/attempt/evidence/调用/产物哈希可离线导出，费用与权威账本一致，诊断包不包含私有背景正文。不是人为修改数据库伪造成功，也不是用宿主替身模拟任务完成。
- **S03 Quality + strict 同任务**：实际 Quality execute_review 任务使用 strict_admission；Worker 真实写入并通过包级机器检查后，高费用 Reviewer 因严格保守上界被拒绝，未发送审核请求。加额后恢复同一任务、同一 Reviewer，完成验证，写入总数仍为一次。fixture 仅提供明确标为 synthetic 的可信上下文描述，生产 Broker 计算上界；Native 网络被控制传输截获，planning/review 是本地生成器，测试全局 fetch 拒绝外部网络。没有向官方端点发请求。
- **S07 回退**：真实任务完成并计费后执行 SessionStore.rewind；命令变为 revoked，模型调用数不增，账本完全保留。旧验证不能再作为当前任务证据读取；修改产物也不会复活旧命令。
- **新准入开关**：`SOCRATES_ARENA_ADMISSION_ENABLED=false` 仅阻止新的实验准备。已有 requestId 的幂等返回、已有实验运行及验证均正常。先添加断言复现未阻止的新准入，再添加窄门禁通过。

## S01—S12 映射

| 场景 | 已执行的测试与具体证据 | 覆盖边界 |
| --- | --- | --- |
| S01 小任务不需要团队 | `route-policy.test.ts` “reads real selected scope, picks a single worker…”：Economy/cost 的 README 单文件候选直接选一个 worker，预检无模型请求；`adaptive-hosts.test.ts` “real direct host…” 实际 Native 执行、角色与费用一致、独立文件验收通过 | 选择规则与实际宿主分别验证；没有把三成员数量当作启用团队的条件 |
| S02 跨模块任务需要分工 | `adaptive-hosts.test.ts` real plan_execute/team、冻结角色与计费；本轮 S12 的两个真实模块 + planning candidate + 用户批准 + 最终独立验收 | 受控计划工作包规模有限，不宣称真实大型仓库质量 |
| S03 Quality 不绕过预算 | `cost-flow.integration.test.ts` “an over-budget Reviewer pauses…”：已完成 Worker 不重写、Reviewer 预算前暂停、加额恢复；`model-invocation-broker.test.ts` strict 官方可信上界、用户覆盖拒绝、strict 父预算不能由 soft 子预算绕过；`route-policy.test.ts` Quality 的预算/价格排除 | 本轮新增 `p08-integration.test.ts` 的 S03 在同一 Quality strict 任务验证真实 Worker 完成、Reviewer 请求前预算暂停、机器证据可见、加额恢复且不重复写入；可信上下文元数据为显式受控 fixture，未请求官方 API |
| S04 @ 与 Custom 优先 | `route-policy.test.ts` explicit mentions/Custom；`routing-admission.test.ts` frozen speaker/summary/executor 校验与撤权；`routing-command.integration.test.ts` Custom 冻结配置不被后续房间默认值改写；`adaptive-workflow.test.ts` 精确升级审批与拒绝后无额外请求 | 运行时角色约束和审批分别覆盖 |
| S05 网络中断与未知消费 | `cost-flow.integration.test.ts` missing Native usage 跨 DB reopen 保留 exposure、加额不能重放已完成写入；实际 transport fault + invoice reconciliation 不改写原始事实 | 没有杀死本机桌面进程；受控传输故障与持久库重新打开覆盖对应恢复边界 |
| S06 暂停恢复与多房间 | `adaptive-workflow.test.ts` 原 child 恢复、并发重复 resume 只有一个所有者、预算暂停不新建 attempt；`adaptive-hosts.test.ts` cancel/interrupt 等待真实规划所有者收尾；`workspace/leases.test.ts`；HistoryStore selected Thread rewind 与 session key 隔离 | 房间切换/迟到 SSE/附件操作的浏览器交互不由这些服务测试代替，见总界面验收 |
| S07 回退不等于退费 | 本轮新增 p08 S07 真实已消费任务回退；`history-store.test.ts` rewind projection 重启重放及 Thread 隔离；`adaptive-history.test.ts` 未完成 routed task 不可因 child 停止而删除/回退 | 账本与不可恢复旧命令已直接断言 |
| S08 自证和验证失效 | `verification-service.test.ts` 真实 Bun tests 审批后运行、真实失败退出、检查脚本变更、文件变化失效、零执行/跳过不能认证；`verification-evidence.test.ts` 不采信“passed”文本、严格数量/退出码解析 | 包含实际受限本地进程；无付费模型裁判 |
| S09 记忆跨模型不跨权限 | `project-memory.integration.test.ts` 两个 Provider 实际网关输入、明确 Chat 绑定、真实 Native manifest；`project-memory.test.ts` 跨项目拒绝、撤权/过期、导入 proposed、冲突、来源删除；本轮 S12 升级成员仍收到授权冻结背景 | 不是仅检查存储行或静态上下文预览 |
| S10 Arena 隔离 | `arena-service.test.ts` 真实四变体成员/Manager/Reviewer、同快照独立工作区、五类真实工具/检查、并发总预算、取消保留消费、清理保留源项目；`project-memory.test.ts` 私有 clone 隔离、源授权撤销不能绕过 | 工具硬边界和明确产物应用另见专门 Arena 边界/产物测试与全仓库门禁，不以模拟模型比较质量 |
| S11 未知模型和空 Provider | `route-policy.test.ts` credential/egress/strict pricing、单成员、未知依赖；`model-invocation-broker.test.ts` 未知/多模态计费拒绝、unsupported dimensions、可信上下文边界；`routing-admission.test.ts` 当前权限与冻结价格 | 缺凭证等失败在本地被拒绝，不会为测错误而向真实 Provider 发请求；可操作 UI 由总界面验收核对 |
| S12 完整溯源 | 本轮 p08 集成测试单个真实根任务串起 planning→失败→批准升级→成功，以及 memory、price、调用、失败检查、产物哈希、脱敏离线诊断与全部费用；`flight-recorder.test.ts` 真实 OTel span、父子归属、留存、对账与分页 | 当前默认元数据导出保留检查状态和哈希，不含完整私有模型/工具正文；原始本地检查日志仍在生产 VerificationService 中 |

## 执行记录

- `/private/tmp/p08-strict-final.log`：最终新增四个 p08 集成场景及受共享 fixture 影响的 `cost-flow.integration`、`adaptive-hosts`，**22 passed / 0 failed / 202 assertions**，3 文件。包含精确 S03 Quality strict Reviewer 场景。

- `/private/tmp/p08-scenarios.log`：`bun test` 选择 `p08-integration`（当时仅 S12）、`adaptive-hosts`、`adaptive-workflow`、`adaptive-history`、`cost-flow.integration`、`route-policy`、`routing-command.integration`、`verification-service`、`verification-evidence`、`project-memory.integration`、`project-memory`、`flight-recorder`、`arena-service`。**143 passed / 0 failed / 752 assertions**，13 文件。macOS 本地验证进程在正常主机权限下执行，测试自身的进程限制保持启用。
- `/private/tmp/p08-extra-scenarios.log`：新 p08 三项测试，以及 `model-invocation-broker`、`routing-admission`、`store/session-store`、`store/history-store`、`workspace/leases`。**63 passed / 0 failed / 224 assertions**，6 文件。与上一批存在重叠，不累加为唯一测试数量。
- `/private/tmp/p08-gate-red.log` 保留开关补丁前失败断言；新集成文件独立结果及最终全仓库测试以总门禁记录为准。

## 未被这些测试独立证明的内容

没有覆盖“在每一种操作的每条指令中任意强杀进程”的故障矩阵；已有测试覆盖明确的持久化、发送未知消费、规划中断、预算恢复和验证恢复缝。测试不会证明外部 Provider 发票严格不超支，也不证明模型质量、节约比例或原生安装包可用性。S06 交互/SSE 和其他界面指标需总验收明确区分完成与未验证，不可仅凭这些服务测试宣称全部 UI 场景通过。
