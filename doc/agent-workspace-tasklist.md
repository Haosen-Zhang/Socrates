# Socrates Agent Workspace 原子任务清单

> 状态：Issue-ready 规划稿，所有任务均未实施。
>
> 基线：`9f7955d5704918e9e8375b4b89c31a7d44a31a2f`（文件树与 `main@48d982c` 一致）。架构与安全依据见 `doc/agent-workspace-master-plan.md`。

## 使用规则

- 一票一分支、一票一 PR；分支建议 `codex/<ticket>-<slug>`。
- 每票合并前至少运行该票列出的命令，再运行仓库 gate：`bun test`、`bun run typecheck`、`bun run --cwd apps/desktop build`。`ENG-001` 合并后追加 `bun run lint`。
- 任务只可依赖已合并 ticket；不得在 UI 票中顺手开放 shell/fs，也不得在 Runtime 票中重写 UI。
- 涉及 schema 的票必须带 migration fixture；涉及外部进程的票必须带 fake/transcript；真实 API key 不进入 CI。
- 每项状态初始均为 `未开始`。只有验收标准和命令全部通过才可关闭。

## P0 — UI 交互正确性

### UI-001 — 重建硬边 micro pixel icons 与尺寸 token

- **优先级 / 状态：** P0 / 已完成（2026-07-16）
- **目标：** 消除 Pixel 1998 导航/设置图标的模糊、紫边和过小问题；大生成图只保留在装饰位。
- **依赖：** 无。
- **修改文件：** `apps/desktop/src/PixelIcon.tsx`、`PixelIcon.test.tsx`、`App.tsx`、`Settings.tsx`、`index.css`。
- **新增文件：** `apps/desktop/src/icons/micro/*.tsx`；必要的截图 fixture 放测试目录，不覆盖现有 sprite。
- **关键实现：** 用 8×8/10×10/16×16 整数网格 SVG rect 或原生 1x/2x PNG；分开 `micro`/`decorative` renderer；删除生成 micro icon 的 `scale(1.16)`；top tab 18–20px、settings nav ≥20px、hit target ≥36px。
- **验收：** 1x/2x、80/100/125/150% zoom、light/dark 下无半透明 halo/非整数 transform；classic theme 不回归；设置与聊天图标可辨。
- **测试命令：** `bun test apps/desktop/src/PixelIcon.test.tsx && bun run --cwd apps/desktop build`，再执行 UI-004 的截图矩阵。
- **主要风险：** 视觉资源版权和主题回归；micro icon 不得继续复用 418px source cell。

### UI-002 — 修正 hover 音效的 interactive-root enter 语义

- **优先级 / 状态：** P0 / 已完成（2026-07-16）
- **目标：** 指针进入一个按钮只播放一次，在同一按钮的图标/文字子节点间移动不重复播放。
- **依赖：** 无。
- **修改文件：** `apps/desktop/src/App.tsx`、`apps/desktop/src/fx.ts`。
- **新增文件：** `apps/desktop/src/fx/interactiveEntry.ts`、`interactiveEntry.test.ts`。
- **关键实现：** 从 `target` 与 `relatedTarget` 分别解析 enabled interactive root，只有 root 变化且进入新 root 才触发；保留单一 delegated listener 和 cleanup；不用 debounce。
- **验收：** 外部→A 1 次、A child→A child 0 次、A→B 1 次、离开再进 1 次；disabled/aria-disabled 不响；rerender 不增加 listener。
- **测试命令：** `bun test apps/desktop/src/fx/interactiveEntry.test.ts && bun run --cwd apps/desktop build`。
- **主要风险：** 只匹配 `button` 会漏掉未来 role/button/link；selector 必须集中定义并做可访问性过滤。

### UI-003 — 建立全局、点击坐标准确的像素粒子层

- **优先级 / 状态：** P0 / 已完成（2026-07-16）
- **目标：** 所有真实 pointer/tap 点击在点击点产生一次粒子；删除/归档/关闭不再依赖局部 handler。
- **依赖：** UI-002（复用全局交互监听约定）。
- **修改文件：** `apps/desktop/src/App.tsx`、`fx.ts`、`ChatPage.tsx`、`ProvidersPage.tsx`、`AgentsSection.tsx`、`index.css`。
- **新增文件：** `apps/desktop/src/fx/GlobalFxLayer.tsx`、`globalFx.test.ts`。
- **关键实现：** capture `click` 且 `event.detail > 0`；调用 `pixelBurstAt(clientX, clientY)`；删除所有局部 `pixelBurst(element)`；节点设 `pointer-events:none`，限制并发数量并尊重 reduced motion。
- **验收：** 按钮、消息区、设置区和空白区各 1 次且中心误差 ≤2 CSS px；键盘激活无伪坐标粒子但功能正常；拖拽/disabled 不触发；删除/关闭不双发。
- **测试命令：** `bun test apps/desktop/src/fx/globalFx.test.ts && bun run --cwd apps/desktop build`，再执行 UI-004 真机 smoke。
- **主要风险：** 全局动画节点泄漏或高频点击掉帧；必须有上限和 cleanup 断言。

### UI-004 — 增加 UI 视觉与交互回归矩阵

- **优先级 / 状态：** P0 / 已完成（2026-07-16；1x/2x browser matrix，Tauri 真机交互待用户目视确认）
- **目标：** 为 micro icons、hover、particle 建可重复 baseline，作为后续 Agent Workspace UI 的视觉 gate。
- **依赖：** UI-001、UI-002、UI-003。
- **修改文件：** `apps/desktop/package.json`、`vite.config.ts`；可能增加根测试脚本。
- **新增文件：** `apps/desktop/tests/visual/*`、`apps/desktop/tests/harness/*`、baseline manifest。
- **关键实现：** 使用 Vite mock API 启动 deterministic 页面；矩阵覆盖 theme×light/dark×DPR×zoom×reduced-motion；事件计数由 test hook 读取，不靠听觉主观判断。
- **验收：** baseline 可在干净环境复现；像素差阈值和更新流程有文档；真机 1x 外屏与 2x Retina 各留一组人工记录。
- **测试命令：** 新增的 `bun run test:visual` 加仓库 gate。
- **主要风险：** 截图受字体/OS 漂移；baseline 要固定 viewport/font 并把结构断言与像素断言分开。

## P1 — Durable、安全与 Runtime 基础

### ARC-001 — 固化 Agent Runtime、Workspace 与 Event Journal ADR

- **优先级 / 状态：** P1 / 进行中（ADR 0004–0007 与 threat model 已落地；旧架构文档交叉引用待补）
- **目标：** 在代码改动前冻结 ownership、协议和安全边界。
- **依赖：** P0 可并行；不依赖生产代码。
- **修改文件：** `docs/02-system-architecture.md`、`03-engineering-design.md`、`04-orchestration-protocol.md`、`05-security-permissions.md`。
- **新增文件：** `docs/adr/0004-agent-runtime-boundary.md`、`0005-workspace-capability-and-approvals.md`、`0006-event-journal-and-recovery.md`、`0007-codex-app-server-adapter.md`、`docs/security/agent-workspace-threat-model.md`。
- **关键实现：** 明确 Socrates-owned state 与 adapter-owned runtime、renderer 无权限、plan/tool approval 分离、一个 workspace writer、非幂等不自动 replay。
- **验收：** ADR 互相引用、标明 supersede/不修改旧 ADR 历史；与 master plan 无冲突；安全阻断项可转成测试。
- **测试命令：** `rg -n "danger-full-access|auto-review|outcome_unknown|one.*write|一个.*write" docs`，再人工 architecture review。
- **主要风险：** 文档先于实现被误读为已上线；每份明确 `proposed/accepted/not implemented`。

### ENG-001 — 建立低噪声 lint/format gate

- **优先级 / 状态：** P1 / 进行中（Biome 低噪声 lint gate 已完成；独立 format/CI gate 待补）
- **目标：** 补齐当前没有 lint script 的工程缺口，不制造全仓格式噪声。
- **依赖：** 无。
- **修改文件：** 根 `package.json`、`bun.lock`。
- **新增文件：** `biome.json`（或 spike 证明更合适的单一配置）、CI 配置（若仓库存在对应 workflow）。
- **关键实现：** 首次只启用 correctness/a11y/import 基础规则；format 独立命令；不在同 PR 重排无关文件。
- **验收：** `bun run lint` 存在且当前仓库通过；故意的未使用变量 fixture 能失败；IDE/CI 命令一致。
- **测试命令：** `bun run lint && bun test && bun run typecheck && bun run --cwd apps/desktop build`。
- **主要风险：** 规则过多阻塞功能开发；采用增量 baseline 而非 blanket ignore。

### DB-001 — 引入事务化、校验 checksum 的正式 migration runner

- **优先级 / 状态：** P1 / 已完成（事务、checksum 漂移、失败回滚、VACUUM INTO 一致备份）
- **目标：** 替换继续增长的 ad-hoc schema upgrade，并支持一致性 backup/失败恢复。
- **依赖：** ARC-001。
- **修改文件：** `apps/sidecar/src/db.ts`、`index.ts`。
- **新增文件：** `apps/sidecar/src/store/connection.ts`、`migrations.ts`、`migrations/001_baseline.ts`、`migrations.test.ts`、旧 schema fixtures。
- **关键实现：** `schema_migrations`、checksum、`BEGIN IMMEDIATE`、SQLite online backup、大 migration 可重复 backfill；旧 db helper facade 暂保留。
- **验收：** 当前 schema→新 baseline 无数据损失；同 migration 重跑无操作；checksum 漂移拒启动；注入失败完整回滚且 backup 可恢复。
- **测试命令：** `bun test apps/sidecar/src/store/migrations.test.ts && bun test`。
- **主要风险：** WAL 下直接复制产生坏备份；必须用 SQLite 一致性方法并测试 busy/disk failure。

### DB-002 — Event journal、projection transaction 与 replay SSE

- **优先级 / 状态：** P1 / 进行中（journal/seq/去重/同事务/replay API 已完成；live SSE 与 desktop gap 补流待接）
- **目标：** 让 UI 断线/重启后按 sequence 恢复，不再依赖 request-bound SSE。
- **依赖：** DB-001。
- **修改文件：** `apps/sidecar/src/index.ts`、`rooms.ts`、`apps/desktop/src/store.ts`、`packages/core/src/index.ts`。
- **新增文件：** `packages/core/src/events.ts`/test、`apps/sidecar/src/store/event-store.ts`/test、`routes/events.ts`、`apps/desktop/src/events/sessionEventReducer.ts`/test。
- **关键实现：** session 内严格 seq、eventId 去重、append+projection 同事务、`GET ...events?after=` replay 后 live、SSE `id`；有界 delta checkpoint。
- **验收：** 断开时产生 20 个 events，重连无丢失/重复；gap 自动补；未知 type 不崩 UI；未提交事件永不广播。
- **测试命令：** `bun test packages/core/src/events.test.ts apps/sidecar/src/store/event-store.test.ts apps/desktop/src/events/sessionEventReducer.test.ts`。
- **主要风险：** 每 token 一行导致 DB 膨胀；必须在测试中断言聚合上限。

### DB-003 — Session/mode、Agent snapshot 与 legacy Room 兼容 schema

- **优先级 / 状态：** P1 / 进行中（三模式 SessionStore、快照与 interrupted migration 已完成；legacy Room adapter 待接）
- **目标：** 同一产品支持 `chat/single_agent/multi_agent`，不破坏现有 Room/history。
- **依赖：** DB-001、DB-002。
- **修改文件：** `packages/core/src/chat.ts`、`apps/sidecar/src/rooms.ts`、`db.ts`、相关 tests。
- **新增文件：** `packages/core/src/conversation.ts`、`agent-session.ts` 及 tests；`apps/sidecar/src/store/session-store.ts`。
- **关键实现：** mode discriminator、session_agents immutable snapshot、agent_sessions/runtime mapping；旧 Room API 作为 adapter；legacy running task 标 interrupted。
- **验收：** 当前 fixture 的 room/agent/message count 和 text hash不变；新三模式可创建；旧 history 可读；旧 running task不自动执行。
- **测试命令：** `bun test packages/core/src/conversation.test.ts apps/sidecar/src/store/session-store.test.ts apps/sidecar/src/rooms.test.ts`。
- **主要风险：** Room/session 双主键；迁移期只允许 SessionStore 成为新 authority。

### CAP-001 — 建立 ModelCapabilities、Provider 错误与 Usage 基础契约

- **优先级 / 状态：** P1 / 进行中（capability/error/usage null 契约已完成；catalog TTL 与 Provider UI 待接）
- **目标：** 在任务开始前知道 text/image/file/tool/reasoning/runtime 能力，并保留真实错误。
- **依赖：** ARC-001。
- **修改文件：** `packages/core/src/provider.ts`、`index.ts`、`apps/sidecar/src/gateway-aisdk.ts`、`providers.ts`、`ProvidersPage.tsx`。
- **新增文件：** `packages/core/src/model-capabilities.ts`、`usage.ts` 及 tests；provider adapter fixtures。
- **关键实现：** capability catalog + user override + TTL；auth/rate/network/capability error taxonomy；usage unknown=null；模型列表失败不再静默变手输。
- **验收：** 不支持 image/effort 在 preparing 前阻止；UI 区分 provider list 失败与空列表；现有 OpenAI-compatible/Anthropic text path 通过。
- **测试命令：** `bun test packages/core/src/model-capabilities.test.ts packages/core/src/usage.test.ts apps/sidecar/src/gateway-aisdk.test.ts apps/sidecar/src/providers.test.ts`。
- **主要风险：** 模型名称频繁变化；未知 capability fail closed，不硬编码“最便宜”而无价格证据。

### SEC-001 — 迁移 secret refs，并收紧 CSP/CORS/日志 redaction

- **优先级 / 状态：** P1 / 已完成（2026-07-17；Provider/MCP/proxy credentials 均留 Keychain，递归诊断 redaction 已接入）
- **目标：** Provider/MCP/proxy credential 统一留在 Keychain，缩小 Renderer↔sidecar 攻击面。
- **依赖：** DB-001、ARC-001。
- **修改文件：** `apps/sidecar/src/secrets.ts`、`config-store.ts`、`net.ts`、`index.ts`、`apps/desktop/src-tauri/tauri.conf.json`、core config/tests。
- **新增文件：** `apps/sidecar/src/security/redaction.ts`/test、config migration fixture。
- **关键实现：** typed secret ref；proxy password 成功写 Keychain 后才改 TOML；Origin/Host allowlist；最小 CSP；错误/log/event recursive redaction。
- **验收：** TOML、SQLite、logs、diagnostic payload 不出现测试 secret；旧代理配置迁移失败时不丢原值；Tauri UI/loopback API 仍能通信。
- **测试命令：** `bun test apps/sidecar/src/config-store.test.ts apps/sidecar/src/net.test.ts apps/sidecar/src/security/redaction.test.ts && bun run --cwd apps/desktop build`。
- **主要风险：** CSP 阻断 loopback/blob；必须按真实 dev/release origin smoke，不能退回 `csp:null`。

### WS-001 — 原生 Workspace picker、Recent 与 Session binding

- **优先级 / 状态：** P1 / 进行中（原生 picker、recent、canonical identity、Session binding 与 active lock 已完成；recent 切换 UI/bookmark seam 待补）
- **目标：** 用户显式选择目录，sidecar 以 canonical identity 绑定 session。
- **依赖：** DB-003、SEC-001。
- **修改文件：** Tauri `Cargo.toml`/`Cargo.lock`、`src/lib.rs`、capabilities、desktop `package.json`/store/ChatPage。
- **新增文件：** `packages/core/src/workspace.ts`、sidecar `workspace/manager.ts`、`routes/workspaces.ts`、desktop `WorkspacePicker.tsx`/`WorkspaceChip.tsx` 及 tests。
- **关键实现：** `tauri-plugin-dialog` 最小权限；picker path 发 sidecar realpath；workspaces/recent schema；active task 时阻止原地切换。
- **验收：** 选择/取消/重开 recent 正常；同一目录不同拼写合并 identity；不存在/不可读目录报错；Renderer 无 direct fs capability。
- **测试命令：** `bun test apps/sidecar/src/workspace apps/desktop/src/workspace && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- **主要风险：** sandboxed macOS 跨重启授权；P5 分发模式决定前保留 bookmark adapter seam。

### WS-002 — Canonical path policy、secret deny 与 write lease

- **优先级 / 状态：** P1 / 进行中（traversal/symlink/hardlink/secret/TOCTOU 与 write lease 已完成；跨平台 case/unicode suite 待补）
- **目标：** 防 traversal/symlink/TOCTOU/outside escape，并保证一个 canonical workspace 一个 writer。
- **依赖：** WS-001、DB-002。
- **修改文件：** Workspace core/manager、store migrations。
- **新增文件：** `apps/sidecar/src/workspace/path-policy.ts`、`leases.ts` 及 adversarial tests。
- **关键实现：** lexical+realpath、create nearest parent、lstat/open/re-stat、secret patterns、outside ask/default write deny、lease owner/expiry。
- **验收：** `../`、absolute、symlink swap、hard link/case/unicode fixtures被正确处理；两个 write task 第二个被拒/排队；crash lease 可审慎回收。
- **测试命令：** `bun test apps/sidecar/src/workspace/path-policy.test.ts apps/sidecar/src/workspace/leases.test.ts`，并在 macOS 真机跑专门 suite。
- **主要风险：** 跨平台 fs 语义；任何未覆盖平台保持 write feature disabled。

### TOOL-001 — Tool contract、Registry、输出上限与 idempotency

- **优先级 / 状态：** P1 / 进行中（统一 schema/generation/stable key/输出上限与五个只读工具已完成；超大输出 storage ref 待补）
- **目标：** 建统一、可过滤、可审计的 Tool 定义和 lifecycle，不立即开放 shell。
- **依赖：** CAP-001、DB-002、WS-002。
- **修改文件：** `packages/core/src/index.ts`、sidecar composition root。
- **新增文件：** `packages/core/src/tools.ts`/test、`apps/sidecar/src/tools/registry.ts`、`executor.ts`、read-only builtin tools/tests。
- **关键实现：** JSON schema validation、risk/idempotency、generation、stable call key；大输出 preview+storage ref；首批仅 list/read/search。
- **验收：** mode/agent policy 可过滤；重名/旧 generation/schema mismatch fail closed；相同 idempotency key 不重复 execute；输出有 byte/line/time 上限。
- **测试命令：** `bun test packages/core/src/tools.test.ts apps/sidecar/src/tools`。
- **主要风险：** read tool也可泄密/DoS；必须先走 path/secret policy和输出限制。

### PERM-001 — 实现纯 PermissionManager 与策略优先级

- **优先级 / 状态：** P1 / 已完成（纯函数优先级、mode ceiling、fresh-human 与冲突表测试）
- **目标：** 统一 global hard deny > capability ceilings > scoped rule > approval/grant 的判定。
- **依赖：** TOOL-001、ARC-001。
- **修改文件：** core exports；设置 schema只加 domain types，不先做完整 UI。
- **新增文件：** `packages/core/src/permissions.ts`、`permissions.test.ts`。
- **关键实现：** action/resource/risk、mode ceiling、freshHumanRequired、policy version、reason codes；模型文本不可作为授权。
- **验收：** 冲突规则 table tests 全覆盖；discussion/synthesis 无 write；outside write/destructive/secret hard deny不能被 session grant覆盖。
- **测试命令：** `bun test packages/core/src/permissions.test.ts`。
- **主要风险：** last-match 误放宽；测试必须穷举优先级而不是只测 happy path。

### APR-001 — Durable ApprovalManager 与 exact-input 防重放

- **优先级 / 状态：** P1 / 进行中（durable request/decision/grant、幂等 decision key、exact evidence 与 expiry recovery 已完成；审批 routes/cards 待接）
- **目标：** 审批可重开/replay、decision 幂等且只绑定 exact request。
- **依赖：** DB-002、PERM-001。
- **修改文件：** sidecar index/routes、ToolExecutor、core exports。
- **新增文件：** `packages/core/src/approvals.ts`/test、`apps/sidecar/src/approvals/manager.ts`/test、`routes/approvals.ts`。
- **关键实现：** request/decision/grant 表；input hash+workspace+attempt+policy version；allow_once/session/deny；fresh-human 禁持久；pending expiry/recovery。
- **验收：** duplicate decision 同结果；任一 hash/version/workspace变化旧批准失效；重启后 pending card可恢复；deny 形成 tool result。
- **测试命令：** `bun test packages/core/src/approvals.test.ts apps/sidecar/src/approvals/manager.test.ts`。
- **主要风险：** approval 与执行之间 TOCTOU；执行前再次比较 exact hash和workspace evidence。

### RUN-001 — AgentRuntime interface、Manager 与 normalized event mapping

- **优先级 / 状态：** P1 / 进行中（Runtime interface/manager、journal-first mapping、opaque extension 与 interrupted recovery 已完成；后台订阅与 UI replay 待接）
- **目标：** 把 rich Agent lifecycle 与一次性 text `ModelGateway` 分开。
- **依赖：** DB-002、CAP-001、TOOL-001、APR-001。
- **修改文件：** core exports、sidecar index、gateway 保持兼容。
- **新增文件：** `packages/core/src/runtime.ts`/test、sidecar `runtime/runtime-manager.ts`、`single-agent-runner.ts`、fake runtime/tests。
- **关键实现：** open/start/answer/interrupt/resume/close；capabilities；adapter events先 journal；unknown fields opaque；runtime external ID只是 mapping。
- **验收：** fake runtime 的 text/tool/approval/usage/cancel 全映射；UI断开不影响运行；restart 无 authoritative resume时标 interrupted而不重发。
- **测试命令：** `bun test packages/core/src/runtime.test.ts apps/sidecar/src/runtime`。
- **主要风险：** 过早抽象成最低公分母；保留 typed extension payload且不让 UI依赖 backend-specific ID。

### CODEX-001 — 固定 Codex app-server 协议与 child supervisor spike

- **优先级 / 状态：** P1 / 进行中（0.144.5 最小协议投影、版本 gate、JSONL correlation、双向审批、timeout/malformed/crash/interrupt fake tests 已完成；真实 initialize 与进程树/发布 hash 待补）
- **目标：** 证明固定版本 `codex app-server --stdio` 可安全初始化、双向审批、interrupt 和退出，不开放生产写入。
- **依赖：** RUN-001、SEC-001。
- **修改文件：** sidecar composition；release manifest 草案。
- **新增文件：** `runtime/child-supervisor.ts`、`runtime/codex/protocol-client.ts`、versioned generated schema/types、mapper、JSONL fixtures/tests。
- **关键实现：** binary path/version/hash检查；initialize/initialized；stdout仅JSONL、stderr redacted；request correlation；graceful terminate+kill tree；协议版本 mismatch fail closed。
- **验收：** 官方固定 transcript 可 replay；fake child malformed JSON/timeout/crash 不拖死 sidecar；command/file approval request可往返；无 real workspace write。
- **测试命令：** `bun test apps/sidecar/src/runtime/codex apps/sidecar/src/runtime/child-supervisor.test.ts`，另手动运行受支持 binary smoke。
- **主要风险：** app-server protocol 漂移与 binary分发；schema和binary必须成对固定，不能自动用任意 PATH版本。

## P2 — Chat、Single Agent 与附件

### MODE-001 — 三模式 Session 创建与切换 UI

- **优先级 / 状态：** P2 / 进行中（三模式创建卡、Single Agent Session authority 与切换已完成；Chat/Multi 仍走 legacy Room compatibility path）
- **目标：** 用户在创建 session 时明确选择 Chat、Single Agent 或 Multi-Agent，并看到各自能力说明。
- **依赖：** DB-003、WS-001、CAP-001。
- **修改文件：** `apps/desktop/src/App.tsx`、`ChatPage.tsx`、`store.ts`、`i18n.ts`、`index.css`、sidecar routes。
- **新增文件：** desktop `stores/sessionStore.ts`、mode/session dialog tests；sidecar `routes/sessions.ts`。
- **关键实现：** mode 是 session immutable identity；选 Agent/participants/workspace 时 capability preflight；active task 下不原地换 mode/workspace。
- **验收：** 三种 session 创建/恢复/归档互不串状态；不满足 runtime/image/tool能力时选择器明确禁用并说明；旧 Room仍可打开。
- **测试命令：** `bun test apps/desktop/src/stores/sessionStore.test.ts apps/sidecar/src/routes/sessions.test.ts && bun run --cwd apps/desktop build`。
- **主要风险：** 只在 UI 切 mode 而后端仍按旧 Room运行；API和DB discriminator必须为 authority。

### CHAT-001 — 将现有 Chat 迁移到结构化消息与 replay，保持无工具隔离

- **优先级 / 状态：** P2 / 进行中（MessagePart/Event contracts 与 Single Agent replay 已完成；legacy Chat 双写/reconnect reducer 待完成）
- **目标：** 保持现在简单聊天体验，同时获得 event replay、content parts 与 usage，不继承 workspace工具权限。
- **依赖：** MODE-001、DB-002、CAP-001。
- **修改文件：** `packages/core/src/chat.ts`、sidecar `rooms.ts`/gateway、desktop ChatPage/store。
- **新增文件：** `packages/core/src/message-parts.ts`/test、sidecar `services/context-assembler.ts`/test。
- **关键实现：** text-first structured parts、legacy adapter、POST accepted + event follow；Chat ToolRegistry为空；用户显式附件才进入 context。
- **验收：** text streaming/Markdown/cancel/rewind/history均不回归；刷新/reconnect不丢回复；绑定 workspace但未附文件时模型看不到任何文件。
- **测试命令：** `bun test packages/core/src/message-parts.test.ts apps/sidecar/src/rooms.test.ts apps/desktop/src/composerIme.test.ts`。
- **主要风险：** 双写消息导致排序/重复；seq reducer和migration compatibility必须共同覆盖。

### NATIVE-001 — Native Single Agent 的只读 Tool Loop

- **优先级 / 状态：** P2 / 已完成（真实 AI SDK Provider、5 个只读工具、8-step 上限、持久化 ToolCall、附件能力 fail-closed）
- **目标：** 用现有 AI SDK 7 为所有受支持 Provider 提供 list/search/read 的多步 Agent Loop。
- **依赖：** RUN-001、TOOL-001、PERM-001、MODE-001。
- **修改文件：** `apps/sidecar/src/gateway-aisdk.ts`、Provider adapter、runtime manager。
- **新增文件：** `runtime/native-agent-runtime.ts`/test、read/list/search tool tests、provider loop fixtures。
- **关键实现：** ToolSet按policy物化；step/turn上限、AbortSignal、usage累积；工具结果重新输入模型；禁止 write/shell/network/MCP。
- **验收：** fake Provider 完成“搜索→读取→回答”并记录每个 item；超 step/上下文/输出预算有明确 terminal；模型请求未知工具 fail closed。
- **测试命令：** `bun test apps/sidecar/src/runtime/native-agent-runtime.test.ts apps/sidecar/src/tools/builtin`。
- **主要风险：** read loop大量读取/烧 token；目录、bytes、steps和budget都有限制。

### CODEX-002 — 上线有 sandbox 与审批的 Codex Single Agent

- **优先级 / 状态：** P2 / 进行中（Codex adapter、sandbox、双向审批、取消/关闭与 UI 已完成；受控真实 workspace smoke 和发布发现待完成）
- **目标：** 首次提供成熟 write/shell Agent Runtime，同时由 Socrates 保存 presentation、approval和audit。
- **依赖：** CODEX-001、WS-002、APR-001、MODE-001、SEC-001。
- **修改文件：** runtime manager、single-agent runner、Tauri release discovery（开发期）、desktop capability UI。
- **新增文件：** `runtime/codex/adapter.ts`、mapper tests、supported-runtime manifest、manual smoke script/document。
- **关键实现：** cwd=canonical workspace；只允许 read-only/workspace-write；映射 thread/turn/item、command/file approval、usage/interrupt；禁止 danger-full-access、auto-review、unsandboxed shell；binary mismatch禁用该 Runtime。
- **验收：** 临时 Git workspace 内完成 read→approved edit→test；deny command后可继续；cancel杀进程树；重启不会重发未知 command；UI显示实际 sandbox/approval mode。
- **测试命令：** transcript/fake `bun test apps/sidecar/src/runtime/codex`；受控真机 `bun run smoke:codex-runtime`；完整仓库 gate。
- **主要风险：** Codex自身read boundary较宽；Socrates secret/path policy和干净cwd必须在turn前验证，正式分发决策仍是P5阻断项。

### TL-001 — Structured timeline、Tool/Approval/Plan cards

- **优先级 / 状态：** P2 / 进行中（Tool/Approval/usage runtime events 与基础卡片已完成；reducer、PlanCard、可访问性/大输出交互待完成）
- **目标：** 不把 tool/approval/runtime事件压进 Markdown 文本，用户能审计每一步。
- **依赖：** DB-002、APR-001、MODE-001；Plan card先支持占位数据，P4接真状态。
- **修改文件：** `ChatPage.tsx`、`store.ts`、`index.css`、`i18n.ts`。
- **新增文件：** `timeline/Timeline.tsx`、`ToolCallCard.tsx`、`ApprovalCard.tsx`、`PlanCard.tsx`、timeline reducer/interaction tests。
- **关键实现：** stable item IDs、pending/terminal状态、stdout preview/展开、exact approval details、虚拟化预留；未知 event显示diagnostic卡而非崩溃。
- **验收：** replay后卡片不重复；pending可操作，decision后不可二次提交；键盘/读屏可读；大输出不冻结窗口。
- **测试命令：** `bun test apps/desktop/src/timeline && bun run --cwd apps/desktop build && bun run test:visual`。
- **主要风险：** timeline成为第二套状态机；所有状态必须由event reducer投影，组件不自行推断。

### ATT-001 — Attachment schema、受控存储与 GC

- **优先级 / 状态：** P2 / 进行中（hash/dedup、原子存储、Workspace 绑定和 limits 已完成；retention GC 待完成）
- **目标：** bytes不进SQLite/消息/localStorage，附件可hash、引用和清理。
- **依赖：** DB-001、DB-003、SEC-001。
- **修改文件：** store migrations、sidecar composition、core message parts。
- **新增文件：** `store/attachment-store.ts`、`attachments/resolver.ts`、`mime.ts`、`gc.ts` 及 tests。
- **关键实现：** temp→stream hash/size/magic MIME→atomic rename；10MiB image/25MiB file/10 files/50MiB batch默认；reference count+retention GC；拒symlink/read-race。
- **验收：** 相同bytes可去重；失败/取消无半文件；删除消息后retention前仍可回放；GC只删无引用；SVG/HTML不active preview。
- **测试命令：** `bun test apps/sidecar/src/attachments apps/sidecar/src/store/attachment-store.test.ts`。
- **主要风险：** disk exhaustion和恶意文件；streaming limits必须在完整写入前生效。

### ATT-002 — Picker、拖放、粘贴与 AttachmentTray

- **优先级 / 状态：** P2 / 进行中（picker、Tauri drop、clipboard bytes、draft retain-on-failure 已完成；显式 retry/progress 待完成）
- **目标：** 文件/图片以统一draft item进入composer，支持进度、失败重试和删除。
- **依赖：** ATT-001、WS-001、CHAT-001。
- **修改文件：** Tauri `lib.rs`/capabilities、desktop ChatPage/package/i18n/index.css。
- **新增文件：** Tauri `dialog.rs`；desktop `composer/AttachmentTray.tsx`、draft attachment reducer/tests；sidecar attachment route。
- **关键实现：** native picker和Tauri drag/drop paths都发sidecar import；clipboard bytes multipart；draft upload中禁发送；失败不清空正文。
- **验收：** picker取消无副作用；drop/paste多文件limits正确；重试只重试失败项；发送后draft清理但历史preview仍有效；无绝对路径显示给模型。
- **测试命令：** `bun test apps/desktop/src/composer apps/sidecar/src/routes/attachments.test.ts && cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`。
- **主要风险：** WebView drag/drop路径信任；所有输入仍需sidecar realpath/MIME/size验证。

### ATT-003 — 有界 `@path` 搜索与结构化 WorkspaceRef

- **优先级 / 状态：** P2 / 进行中（bounded search、opaque ref、send-time containment/hash 已完成；caret/Unicode reducer 与 cache generation 待完成）
- **目标：** composer可快速引用workspace文件，但suggestion不等于授权。
- **依赖：** WS-002、CHAT-001。
- **修改文件：** ChatPage/composer state、workspace routes、ContextAssembler。
- **新增文件：** desktop `PathReferenceMenu.tsx`、matcher/cache tests；sidecar workspace search/ref resolver tests。
- **关键实现：** caret前尾token、一层目录/有界搜索、5秒generation cache、opaque refId；send时重做containment/secret/size/hash。
- **验收：** 空格/Unicode/删除token行为正确；workspace变化使cache失效；旧ref或secret文件send失败；纯文本`@foo`不隐式读取。
- **测试命令：** `bun test apps/desktop/src/composer/PathReferenceMenu.test.ts apps/sidecar/src/workspace`。
- **主要风险：** 索引大仓库卡顿/泄露被ignore文件；明确depth/count/time/ignore策略。

### ATT-004 — Provider/Runtime attachment capability 与上传映射

- **优先级 / 状态：** P2 / 进行中（Codex image/text mapping、Native text/ref mapping 与 image fail-closed 已完成；per-model capability UI 和 Provider upload cache 待完成）
- **目标：** 清楚区分文本注入、原生图片、Provider file upload和Runtime path item。
- **依赖：** ATT-001、CAP-001、NATIVE-001、CODEX-002。
- **修改文件：** Provider adapters、ContextAssembler、runtime mappers、Agents/Providers UI。
- **新增文件：** provider attachment mapper tests、upload mapping store migration。
- **关键实现：** per-model preflight；provider upload ID按attachment hash/expiry缓存；Multi参与者取capability交集；无能力不做静默OCR/丢弃。
- **验收：** text-only模型附图明确阻止；vision模型收到同一hash；过期upload重传不改消息；Multi不兼容成员必须移除或取消。
- **测试命令：** `bun test apps/sidecar/src/providers apps/sidecar/src/services/context-assembler.test.ts apps/sidecar/src/runtime`。
- **主要风险：** Provider能力/上传API差异；adapter内封装并保留raw error category，不把临时ID暴露core/UI。

### ATT-005 — 安全图片/文件预览与下载

- **优先级 / 状态：** P2 / 进行中（Bearer content route、Blob URL revoke、nosniff/sandbox/disposition 已完成；download/GC 410 与恶意 fixture 待完成）
- **目标：** UI可预览、复制/另存受控附件，不执行active content或泄露storage path。
- **依赖：** ATT-001、ATT-002、SEC-001。
- **修改文件：** sidecar auth/API、Timeline/ChatPage、CSP。
- **新增文件：** authenticated content route/tests、desktop preview component/tests。
- **关键实现：** Bearer鉴权、Content-Type/Disposition/nosniff、range可选；Blob URL生命周期；SVG/HTML强制下载或安全栅格化；错误不回显绝对路径。
- **验收：** 未授权请求401；有效image可预览且URL被revoke；恶意SVG script不执行；删除/GC后返回稳定410/404。
- **测试命令：** `bun test apps/sidecar/src/routes/attachments.test.ts apps/desktop/src/composer && bun run test:visual`。
- **主要风险：** CSP/Blob和浏览器MIME sniff；必须用恶意fixture验证。

## P3 — MCP

### MCP-001 — MCP config schema、Keychain refs 与设置 UI

- **优先级 / 状态：** P3 / 已完成（2026-07-17）
- **目标：** 用户配置global/workspace stdio或Streamable HTTP server，并看到真实连接状态。
- **依赖：** SEC-001、WS-001、DB-001。
- **修改文件：** core config/index、sidecar config/secrets/index、desktop Settings/i18n/store。
- **新增文件：** `packages/core/src/mcp.ts`/test、MCP migrations/routes、desktop `settings/McpSettings.tsx`/tests。
- **关键实现：** 非敏感config与secret refs分离；server name/scope唯一；disabled/disconnected/...状态；import/export默认redacted。
- **验收：** key/header/env secret不能读回UI；workspace server只在绑定workspace可见；配置错误说明字段；disable触发teardown请求。
- **测试命令：** `bun test packages/core/src/mcp.test.ts apps/sidecar/src/routes/mcp.test.ts apps/desktop/src/settings/McpSettings.test.tsx`。
- **主要风险：** command/env配置本身可执行；保存不代表运行，连接前仍过policy。

### MCP-002 — stdio 与 Streamable HTTP transport 生命周期

- **优先级 / 状态：** P3 / 已完成（2026-07-17）
- **目标：** Manager可连接、协商、停止、崩溃退避，不产生orphan child。
- **依赖：** MCP-001、CODEX-001 的 supervisor、SEC-001。
- **修改文件：** sidecar composition/health。
- **新增文件：** `mcp/manager.ts`、`connection.ts`、`transport-stdio.ts`、`transport-http.ts`、fake servers/tests。
- **关键实现：** 官方MCP SDK封装；1/2/5/10/30s jitter backoff；needs_auth不风暴重试；generation；graceful stop+kill；egress hooks。
- **验收：** connect/discover/stop稳定；崩溃撤下能力并按时重连；退出无child；remote redirect/loopback policy不被绕过。
- **测试命令：** `bun test apps/sidecar/src/mcp`。
- **主要风险：** SDK协议升级；锁minor并把SDK types关在adapter内。

### MCP-003 — Discovery、命名空间与 ToolRegistry generation

- **优先级 / 状态：** P3 / 已完成（2026-07-17）
- **目标：** tools/resources/prompts被验证、快照并按generation安全暴露。
- **依赖：** MCP-002、TOOL-001。
- **修改文件：** ToolRegistry、MCP manager、settings status UI。
- **新增文件：** MCP discovery/schema validation tests、runtime snapshot store。
- **关键实现：** `mcp__server__tool`命名；schema hash/complexity限制；server annotations只能升风险不能降；断开即撤下旧generation。
- **验收：** 同名server/tool不覆盖builtin；schema变化使旧call失败；超复杂/非法schema禁用该tool但server可degraded。
- **测试命令：** `bun test apps/sidecar/src/mcp apps/sidecar/src/tools/registry.test.ts`。
- **主要风险：** 恶意JSON Schema耗CPU/内存；validator有深度/size/time限制。

### MCP-004 — MCP per-tool 权限、审批与 Agent 暴露策略

- **优先级 / 状态：** P3 / 已完成（2026-07-17）
- **目标：** MCP工具遵循和builtin一致的mode/agent/room/policy/approval链。
- **依赖：** MCP-003、PERM-001、APR-001、NATIVE-001。
- **修改文件：** PermissionManager inputs、ToolExecutor、Agents/MCP settings、i18n。
- **新增文件：** MCP policy store/fixtures/tests。
- **关键实现：** server/tool allow/ask/deny；risk override；resources也是untrusted；discussion默认无side-effect MCP；decision绑定generation+input hash。
- **验收：** denied tool不调用server；ask重启可恢复；generation变更旧批准失效；prompt injection无法提升权限。
- **测试命令：** `bun test packages/core/src/permissions.test.ts apps/sidecar/src/mcp apps/sidecar/src/approvals`。
- **主要风险：** Server错误标注read-only；本地policy默认ask/deny并允许管理员升风险。

### MCP-005 — MCP 恢复、诊断、redacted import/export 与 Runtime ownership

- **优先级 / 状态：** P3 / 已完成（2026-07-17；Codex MCP sync 保持关闭）
- **目标：** 让用户理解连接失败并确保Native/Codex不会双重托管同一server。
- **依赖：** MCP-004、CODEX-002。
- **修改文件：** settings/diagnostics、runtime manager、release docs。
- **新增文件：** diagnostics exporter/tests、MCP owner lease mapping。
- **关键实现：** health分类、redacted config export、retry/reset controls；每task/server一个host owner；Codex sync feature默认off。
- **验收：** export无secret；Native owner时Codex不连接；owner断开不静默切换；diagnostic可定位auth/transport/schema/policy错误。
- **测试命令：** `bun test apps/sidecar/src/mcp apps/sidecar/src/security/redaction.test.ts`。
- **主要风险：** 为“兼容”自动双连导致重复side effect；ownership必须是durable事实。

## P4 — Multi-Agent 讨论、计划审批与执行

### MULTI-001 — 实现唯一合法的 TaskStateMachine 与 attempt/checkpoint

- **优先级 / 状态：** P4 / 已完成（12 状态 reducer、attempt、resumeFrom、terminal/非法转换与 DB 单入口已实现并回归）
- **目标：** 用纯 reducer 实现 12 个精确状态及所有合法转换，取代分散的 status 字符串和内存 resolver。
- **依赖：** DB-002、DB-003、ARC-001。
- **修改文件：** `packages/core/src/orchestration.ts`、core exports、sidecar task route/store。
- **新增文件：** `packages/core/src/task-state.ts`/test、store task-attempt migration/tests。
- **关键实现：** `idle/preparing/discussing/synthesizing/awaiting_plan_approval/revising_plan/executing/awaiting_tool_approval/paused/failed/cancelled/completed`；resumeFrom；terminal不可复活；retry新attempt。
- **验收：** transition table正反例全覆盖；任何非法转换typed error且不改DB；cancel/decision幂等；legacy running task进入needs-review而非续跑。
- **测试命令：** `bun test packages/core/src/task-state.test.ts apps/sidecar/src/store`。
- **主要风险：** UI和route绕过reducer；DB state update只暴露一个state-machine transaction入口。

### MULTI-002 — AgentSession、顺序、轮数、effort 与 participant snapshot

- **优先级 / 状态：** P4 / 已完成（participant snapshot、20 Agent 顺序、轮数、总结/执行 Agent 已进入任务冻结配置；effort capability UI 归 UX-002）
- **目标：** 每个参与者拥有独立history/runtime mapping和不可变profile snapshot，保持现有拖拽顺序语义。
- **依赖：** MULTI-001、CAP-001、RUN-001。
- **修改文件：** core chat/orchestration、sidecar agents/rooms、desktop room member/order UI。
- **新增文件：** multi participant/session service/tests、desktop task setup panel/tests。
- **关键实现：** nickname/role/model/runtime/policy snapshot；position唯一；per-agent effort/capability；participant变更只影响下一个task版本。
- **验收：** 20个Agent列表可滚动/拖动/键盘排序；显示nickname而非角色模板名；同task中编辑Agent不改变已运行turn；不支持effort不可选。
- **测试命令：** `bun test packages/core/src/agent-session.test.ts apps/sidecar/src/agents.test.ts apps/desktop/src/roomSelection.test.ts`。
- **主要风险：** live Agent记录漂移污染历史；所有event/turn引用snapshot ID。

### MULTI-003 — 只读讨论阶段与确定性 turn idempotency

- **优先级 / 状态：** P4 / 已完成（串行只读讨论、stable turn、durable usage、completed-turn replay 与 outcome-unknown 防盲重放）
- **目标：** 将现有 Round Robin/Debate 迁入 `discussing`，保证不产生写副作用且重启不重复turn。
- **依赖：** MULTI-001、MULTI-002、NATIVE-001、WS-002。
- **修改文件：** `packages/core/src/orchestration.ts`、sidecar `rooms.ts`、gateway。
- **新增文件：** `services/multi-agent-coordinator.ts`/tests、discussion fixtures。
- **关键实现：** stable key=`task:attempt:phase:round:index`；串行默认；可选trusted read-only tools；每turn记录input cutoff/snapshot/usage；retry/skip/fallback显式事件。
- **验收：** sidecar在turn完成前后崩溃分别安全处理；同key不二次模型调用；write/shell/MCP side-effect tool从registry不可见；现有round/debate输出顺序不回归。
- **测试命令：** `bun test packages/core/src/orchestration.test.ts apps/sidecar/src/services/multi-agent-coordinator.test.ts apps/sidecar/src/rooms.test.ts`。
- **主要风险：** Provider已接收但未回包的请求无法判定；标interrupted并让用户决定，不自动重发。

### MULTI-004 — Structured PlanSynthesizer、版本与 evidence hash

- **优先级 / 状态：** P4 / 已完成（JSON schema repair、canonical hash、版本/parent、cutoff 与 evidence stale 检查）
- **目标：** 讨论完成后生成可审、可编辑、带范围/风险/验证的结构化计划，而不是一段不可绑定的Markdown。
- **依赖：** MULTI-003、ATT-003、DB-002。
- **修改文件：** core exports、gateway/ContextAssembler、task store。
- **新增文件：** `packages/core/src/plan.ts`/test、`services/plan-synthesizer.ts`/test、plan migrations。
- **关键实现：** Plan schema含steps/files/commands/risks/verification/evidence；canonical serialization+hash；parentVersion；schema repair上限；discussion cutoff固定。
- **验收：** 相同canonical plan hash稳定；编辑产生新version；invalid plan不会进awaiting approval；workspace evidence变化可检测并标stale。
- **测试命令：** `bun test packages/core/src/plan.test.ts apps/sidecar/src/services/plan-synthesizer.test.ts`。
- **主要风险：** hash受key顺序/展示文本影响；用明确canonical serializer和版本字段。

### MULTI-005 — Plan approve/edit/replan/reject UI 与 durable decision

- **优先级 / 状态：** P4 / 已完成（exact version/hash/client key 决策、编辑批准、replan/reject 与刷新恢复 UI）
- **目标：** 用户审核exact plan后才能进入执行，并可编辑、要求重做或拒绝。
- **依赖：** MULTI-004、TL-001、MULTI-001。
- **修改文件：** timeline PlanCard、ChatPage/store/i18n、sidecar routes/state service。
- **新增文件：** plan decision route/tests、plan editor/dialog tests。
- **关键实现：** decision带version/hash/client key；edit-and-approve生成新version再批准；replan进入revising；reject终止reason=plan_rejected；旧decision失效。
- **验收：** 双击/重放decision不重复execute；hash mismatch返回409并刷新计划；刷新应用后pending plan仍可操作；键盘可完整审核。
- **测试命令：** `bun test apps/sidecar/src/routes/plan-decisions.test.ts apps/desktop/src/timeline/PlanCard.test.tsx`。
- **主要风险：** “批准计划”被误作所有tool授权；UI文案和domain type都明确分离。

### MULTI-006 — Designated ExecutionRunner、approved-plan handoff 与 write lease

- **优先级 / 状态：** P4 / 已完成（指定执行 Agent、单 writer lease/续租、plan scope、独立工具审批、取消与终态释放）
- **目标：** 只让一个合格Agent在一个write lease内执行批准计划，具体tool继续过permission/approval。
- **依赖：** MULTI-005、CODEX-002、APR-001、WS-002。
- **修改文件：** runtime manager/state service、desktop execution-agent selector。
- **新增文件：** `runtime/execution-runner.ts`/test、plan scope evaluator/tests。
- **关键实现：** 校验plan hash/evidence/runtime capability；获取lease；新Default execution turn引用plan；tool input对plan scope；scope expansion pause/replan；terminal释放lease。
- **验收：** 无批准/旧hash/不合格Agent不能执行；第二writer被阻止；tool ask仍出现；cancel/crash释放或过期回收lease；workspace diff可审计。
- **测试命令：** `bun test apps/sidecar/src/runtime/execution-runner.test.ts apps/sidecar/src/workspace/leases.test.ts`，再受控Codex E2E。
- **主要风险：** Plan自然语言无法完美限制command；scope evaluator只作额外约束，高风险tool仍需人工审批。

### MULTI-007 — Replan、fallback、compaction 与 restart recovery

- **优先级 / 状态：** P4 / 进行中（restart reconcile、pause/resume、新 attempt、unknown 人工确认重试、replan、显式 fallback 与 range/hash compaction 已完成；跨 sidecar task ownership lease 与分类 rate-limit backoff 仍待）
- **目标：** 任务在失败、上下文超限、Agent不可用或应用重启后可解释恢复，不伪造连续性。
- **依赖：** MULTI-006、DB-002、CAP-001。
- **修改文件：** coordinator/state/store/runtime supervisor、timeline recovery UI。
- **新增文件：** recovery reconciler/tests、context compaction service/tests、fallback policy tests。
- **关键实现：** ownership lease；safe checkpoint；`outcome_unknown`；explicit fallback order；compaction event+covered range/hash；resumeFrom；rate-limit retry边界。
- **验收：** crash matrix每个点有确定状态；non-idempotent不自动重放；fallback显示真实Agent/model；compaction失败保留原history；用户可resume/retry/cancel。
- **测试命令：** `bun test apps/sidecar/src/services/recovery* apps/sidecar/src/services/context-compaction* packages/core/src/task-state.test.ts`。
- **主要风险：** 把外部Runtime“presentation resume”当执行事实；只信Socrates journal和authoritative tool terminal。

## P5 — 产品化、恢复与发布

### UX-001 — Per-Agent/current/cumulative Usage 与成本展示

- **优先级 / 状态：** P5 / 进行中（Chat/Single/Multi 的 current/cumulative token、cache/reasoning 与 unavailable 已统一持久化展示；可信 pricing snapshot 未接入，费用保持 unavailable）
- **目标：** Chat/Single/Multi统一显示输入、输出、cache、reasoning、估算成本和来源。
- **依赖：** CAP-001、DB-002、MULTI-002。
- **修改文件：** Provider adapters、gateway/runtime mappers、timeline/settings/i18n。
- **新增文件：** `services/usage-collector.ts`/test、usage store migration、`timeline/UsageSummary.tsx`/test。
- **关键实现：** unknown=null；raw redacted；pricing snapshot/version；current vs cumulative；Agent/task/session维度；estimated标记。
- **验收：** totals与fixture一致；缺字段不显示0；replay不重复累加；成本无price时显示unknown而非猜测。
- **测试命令：** `bun test packages/core/src/usage.test.ts apps/sidecar/src/services/usage-collector.test.ts apps/desktop/src/timeline/UsageSummary.test.tsx`。
- **主要风险：** Provider token语义不同；保留source/raw-redacted并不做不可验证对齐。

### UX-002 — Reasoning effort capability 与安全展示

- **优先级 / 状态：** P5 / 已完成（能力未知时隐藏；用户显式 capability override 后按 Agent/task 选择；OpenAI-compatible 通过已安装 AI SDK providerOptions 映射，其他 adapter fail closed；不保存 raw reasoning）
- **目标：** 只为支持的模型显示effort，按Agent配置并记录实际值；默认不保存原始reasoning。
- **依赖：** CAP-001、UX-001、MULTI-002。
- **修改文件：** Agent/Profile UI、Provider adapters、task setup/timeline/i18n。
- **新增文件：** effort mapping fixtures/tests、reasoning summary component。
- **关键实现：** normalized effort→provider mapping；capability intersection；unsupported fail before task；summary与raw reasoning分离。
- **验收：** 不支持模型无控件；模型更新使旧值不可用时要求重选；usage记录actual effort；默认DB无raw chain-of-thought。
- **测试命令：** `bun test packages/core/src/model-capabilities.test.ts apps/sidecar/src/providers apps/desktop/src`（限定effort tests）。
- **主要风险：** Provider术语和政策变化；mapping版本化且UI不承诺通用同等强度。

### UX-003 — RAF、键盘可用的可调整 Composer

- **优先级 / 状态：** P5 / 已完成（104px～min(360px,40vh)、pointer capture、RAF、8/24px 键盘、双击复位、localStorage、窗口 clamp 与 IME 回归）
- **目标：** 用户可在104px到`min(360px,40vh)`间拖动，不触发整窗口抖动。
- **依赖：** CHAT-001、ATT-002、UI-004。
- **修改文件：** ChatPage/index.css/i18n。
- **新增文件：** `composer/Composer.tsx`、`composerMachine.ts`、`ResizeHandle.tsx` 及 tests。
- **关键实现：** pointer capture + RAF批量应用；keyboard 8/24px；double-click reset；height只存localStorage；IME/Enter语义保留；reduced-motion无弹性动画。
- **验收：** 连续拖动每frame最多一次layout write；窗口变小自动clamp；Shift+Enter换行、IME Enter不发送；screen reader识别separator/value。
- **测试命令：** `bun test apps/desktop/src/composer apps/desktop/src/composerIme.test.ts && bun run test:visual`。
- **主要风险：** 重构composer回归发送/附件；先抽纯state machine再替换视图。

### UX-004 — Recovery Center、暂停/恢复与任务诊断

- **优先级 / 状态：** P5 / 进行中（Multi pause/resume/retry/cancel、outcome_unknown 与执行中断人工复核已完成；统一 Recovery Center/诊断导出仍待）
- **目标：** 用户能看到 interrupted/pending/unknown任务并安全选择resume/retry/cancel/inspect。
- **依赖：** MULTI-007、DB-002、TL-001。
- **修改文件：** ChatPage历史任务、settings/health、store/i18n。
- **新增文件：** recovery center components/routes/tests、redacted diagnostic exporter。
- **关键实现：** 按state/reason分类；exact last checkpoint/tool；resume capability说明；diagnostic默认无消息内容/secret；control幂等。
- **验收：** 重启fixture中的每种active状态均有可操作card；outcome_unknown不可一键盲重试；重复cancel/retry不创建多attempt。
- **测试命令：** `bun test apps/desktop/src/recovery apps/sidecar/src/routes/recovery.test.ts apps/sidecar/src/security/redaction.test.ts`。
- **主要风险：** “恢复”按钮暗示自动安全；按状态显示不同动作且危险项要求人工核查。

### PERF-001 — Output bounding、context compaction 与长会话性能

- **优先级 / 状态：** P5 / 进行中（Multi context 已有有界 extractive checkpoint、covered range/hash/event 且保留原 history；工具 10MB 外置、10k timeline windowing 与 quota/GC 仍待）
- **目标：** 大工具输出、长timeline和多Agent历史不会拖垮DB、WebView或context window。
- **依赖：** TL-001、MULTI-007、ATT-001。
- **修改文件：** ToolExecutor/EventStore/ContextAssembler/Timeline。
- **新增文件：** output store/retention tests、timeline virtualization或windowing组件、performance fixtures。
- **关键实现：** preview bytes/lines cap、full output storage ref、delta checkpoint、visible window、explicit compaction record、storage quota/GC。
- **验收：** 10MB输出不进入event JSON；10k timeline items可交互；DB增长符合上限；compaction可追溯且原history仍可查看。
- **测试命令：** `bun test apps/sidecar/src/tools apps/sidecar/src/store apps/desktop/src/timeline`，并执行定义好的性能budget script。
- **主要风险：** 过早虚拟化破坏滚动/读屏；先记录预算和profile，再选最小实现。

### SEC-002 — 全链路 Agent Workspace 安全验收

- **优先级 / 状态：** P5 / 未开始
- **目标：** 在write/shell/MCP正式启用前完成威胁驱动回归和人工审查。
- **依赖：** WS-002、APR-001、CODEX-002、MCP-005、MULTI-006、SEC-001。
- **修改文件：** 仅修复审计发现所需的最小文件；feature flags默认保持off直到本票关闭。
- **新增文件：** security integration suite、malicious fixtures、`docs/security/agent-workspace-test-report.md`。
- **关键实现：** traversal/symlink/TOCTOU、approval replay、prompt injection、MCP spoof、DNS rebinding/redirect、secret/log、child orphan、DB crash、outcome unknown。
- **验收：** master plan 24.3的每个阻断项有自动证据或明确人工证据；无P0/P1高风险未决；write/shell/MCP flag开启需独立review。
- **测试命令：** `bun run test:security` + 全仓 gate + Rust gate + 受控macOS真机测试。
- **主要风险：** 把单元测试当sandbox证明；必须包含OS/进程/真文件系统集成和实际签名构建。

### REL-001 — Bundled sidecar/Runtime、签名、公证与第三方清单

- **优先级 / 状态：** P5 / 未开始
- **目标：** DMG在无Bun开发环境中启动，固定binary可验证，license/NOTICE完整。
- **依赖：** CODEX-002、SEC-002；开放问题中的分发渠道已决。
- **修改文件：** Tauri config/Cargo/build、根/desktop scripts、release docs。
- **新增文件：** `THIRD_PARTY_NOTICES.md`、`third_party/runtime-manifest.json`、binary verifier、release smoke scripts。
- **关键实现：** bundle sidecar；Codex bundled或user-managed明确一种支持模式；SHA-256/version/schema；codesign/notarize；父子进程监督；附OpenCode/Reasonix copied-code notices（如有）和Codex Apache NOTICE/Ratatui归属。
- **验收：** 干净macOS用户安装DMG可离线打开Native Chat；Runtime不可用时只禁对应模式；退出无child；`codesign`/`spctl`/notarization通过；manifest与实际hash一致。
- **测试命令：** `bun run build:dmg && bun run smoke:installed-app`，加平台签名验证命令和全仓gate。
- **主要风险：** binary体积、分发条款、架构(arm64/x64)；在打包前锁定渠道和universal策略。

### REL-002 — Migration、backup/rollback 与三模式 E2E 发布演练

- **优先级 / 状态：** P5 / 未开始
- **目标：** 用真实旧数据副本完成升级/回滚，并在安装包上验证Chat/Single/Multi关键链路。
- **依赖：** REL-001、MULTI-007、UX-004、PERF-001。
- **修改文件：** release/migration scripts和docs；只修演练发现的问题。
- **新增文件：** anonymized schema fixtures、migration report template、E2E scenarios、release checklist。
- **关键实现：** backup→upgrade→row/hash/FK/seq验证→运行→故障注入→恢复backup；feature flag rollout；Provider/Runtime用fake与受保护manual smoke双轨。
- **验收：** 当前真实schema和至少两个旧fixture零丢失；failed migration可回到可启动版本；三模式、附件、approval、MCP、restart、DMG均有证据；无真实key写盘/Git。
- **测试命令：** `bun run test:migrations && bun run test:e2e && bun run smoke:installed-app`，再完整gate。
- **主要风险：** 只测全新DB掩盖真实升级问题；fixture必须来自匿名化的历史schema形状。

## 关键路径与首个可执行里程碑

```text
UI-001 + UI-002 -> UI-003 -> UI-004                         (首个里程碑)
ARC-001 -> DB-001 -> DB-002 -> DB-003
ARC-001 -> CAP-001 -> TOOL-001 -> PERM-001 -> APR-001
DB-003 + SEC-001 -> WS-001 -> WS-002
DB-002 + TOOL-001 + APR-001 -> RUN-001 -> CODEX-001
以上 P1 -> MODE-001 -> CHAT-001 / NATIVE-001 / CODEX-002
P2 -> MCP-001..005
P1 + P2 -> MULTI-001..007
P4 -> P5 security/release gates
```

第一轮只开四张 P0 票。完成标准不是“看起来好一点”，而是 UI-004 的 DPR/zoom/主题矩阵和事件计数同时通过。此后 P1 可按两条并行线推进：`DB/Event/Session` 与 `Capability/Tool/Permission/Runtime`；Workspace/Approval 是两条线的汇合点。

## 关闭 Issue/PR 前的统一检查

- [ ] 只包含本票范围；没有顺手开放更高权限。
- [ ] acceptance 每一项有自动或人工证据链接。
- [ ] 依赖 ticket 已合并，schema/protocol version已更新。
- [ ] 新 error/state/i18n 三语完整，UI不显示raw backend错误。
- [ ] secret、绝对敏感路径、真实prompt/附件未进入log/fixture/screenshot。
- [ ] `bun run lint`（ENG-001后）、`bun test`、`bun run typecheck`、Desktop build通过。
- [ ] Rust/外部进程票的fmt/clippy/test/transcript/cleanup通过。
- [ ] migration/runtime/dependency票更新license、manifest、ADR或兼容文档。
- [ ] PR写明风险、回滚/feature flag和未解决限制；“测试通过”附具体命令。
